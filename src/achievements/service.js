"use strict";

// Achievements: what each person earned, decided on the server when a game
// ends (src/shared/achievements.js is the catalogue). Only the people a game
// counts for, by the leaderboard's rule (queries COUNTED), earn anything from
// it, so a game walked out of alone or never moved in gives nothing. Two
// kinds of check:
//
//   in the game   replayed from its actions in a worker thread (worker.js,
//                 analyze.js): a capital taken, every tech, a city of 20...
//                 plus the win feats that need the result (Blitz, Flawless).
//   the record    the person's counted games up to this one: games played,
//                 wins, cities taken, a win as every civ, three in a row.
//
// rooms.js calls gameEnded() when a game finishes or is abandoned, and
// start() at boot, which queues every ended game not yet awarded: that is the
// backfill, and it also catches a game a restart cut short. Games are done one
// at a time, oldest first. Awarding only ever raises a tier, so doing a game
// twice is harmless. Newly earned achievements go out on `events` as
// "earned" ({ userId, earned }), which socket.js sends to the person's tabs.

const EventEmitter = require("events");
const path = require("path");
const { Worker } = require("worker_threads");
const db = require("../db/index");
const queries = require("../db/queries");
const log = require("../log");
const { DIFFICULTIES } = require("../shared/settings");
const {
  ACHIEVEMENTS_BY_KEY: A, describeAchievement, tierName, tierFor,
} = require("../shared/achievements");

const DIFFICULTY_WINS = ["princely_victory", "royal_victory", "imperial_victory"];

const events = new EventEmitter();
const queue = [];   // game ids waiting
let current = null; // the job the worker has
let worker = null;
let waiters = [];   // idle() callers

// ---- the queue ----

function gameEnded(gameId) {
  if (current?.gameId === gameId || queue.includes(gameId)) return;
  queue.push(gameId);
  pump();
}

function start() {
  for (const { id } of queries.listUnawardedGames.all()) gameEnded(id);
}

function pump() {
  while (!current) {
    const gameId = queue.shift();
    if (gameId === undefined) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
      return;
    }
    let job;
    try {
      job = jobFor(gameId);
    } catch (err) {
      log.error("achievements.failed", { game: gameId, err });
      continue;
    }
    if (!job) continue;
    current = job;
    const w = workerThread();
    w.ref();
    w.postMessage(job);
  }
}

// What the worker needs to replay a game, or null when there is nothing to
// do: not over, already awarded, or nobody it counts for (marked done here,
// no replay needed).
function jobFor(gameId) {
  const row = queries.getGameById.get(gameId);
  if (!row || !row.snapshot || row.achievements_at || !["finished", "aborted"].includes(row.status)) return null;
  if (!queries.achievementSeats.all(gameId).length) {
    queries.markGameAwarded.run(gameId);
    return null;
  }
  return {
    gameId,
    setup: JSON.parse(row.snapshot).setup,
    actions: queries.listActions.all(gameId).map((a) => ({ seq: a.seq, seat: a.seat, action: JSON.parse(a.action) })),
    snapshot: row.snapshot,
  };
}

function workerThread() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, "worker.js"));
  w.on("message", (res) => { if (w === worker) finish(res); });
  // The worker died (not a game that failed to replay: analyze reports
  // those). The game it had is awarded without its replay; the next job gets
  // a new worker.
  w.on("error", (err) => {
    if (w !== worker) return;
    worker = null;
    log.error("achievements.failed", { game: current?.gameId, err });
    if (current) finish({ gameId: current.gameId, ok: false, error: "worker" });
  });
  worker = w;
  return w;
}

function finish(res) {
  const job = current;
  current = null;
  if (worker) worker.unref();
  try {
    award(job.gameId, res);
  } catch (err) {
    // Not marked as awarded, so the next boot tries again.
    log.error("achievements.failed", { game: job.gameId, err });
  }
  pump();
}

// Resolves once nothing is queued or being replayed (the tests wait on it).
function idle() {
  return new Promise((resolve) => {
    if (!current && !queue.length) resolve();
    else waiters.push(resolve);
  });
}

// Forget the queue, end the worker and drop the listeners (rooms.clearAll,
// which the tests use to simulate a restart).
function stop() {
  queue.length = 0;
  current = null;
  if (worker) worker.terminate();
  worker = null;
  events.removeAllListeners();
  pump();
}

// ---- awarding ----

// One ended game's achievements, from the worker's report (`res`), in one
// transaction with the mark that it is done.
function award(gameId, res) {
  if (!res.ok) log.warn("achievements.replay_failed", { game: gameId, error: res.error, seq: res.seq });
  const row = queries.getGameById.get(gameId);
  const ref = { gameId, at: row.finished_at };
  const earned = new Map(); // userId -> [view]
  const people = new Map(); // userId -> username, for the log

  db.transaction(() => {
    const seats = queries.achievementSeats.all(gameId);
    // The easiest AI in the game; -1 when there is none.
    const aiLevels = queries.getSeats.all(gameId).filter((s) => s.user_id === null)
      .map((s) => DIFFICULTIES.indexOf(s.difficulty));
    const easiest = aiLevels.length ? Math.min(...aiLevels) : -1;

    for (const s of seats) {
      people.set(s.user_id, s.username);
      const seen = res.ok ? res.seats[s.seat] : null;
      if (seen) queries.setSeatCaptures.run(seen.captures, gameId, s.seat);
      const keys = seen ? [...seen.feats] : [];
      if (s.won) {
        if (s.people === 1) {
          for (const key of DIFFICULTY_WINS) {
            if (easiest >= DIFFICULTIES.indexOf(A[key].difficulty)) keys.push(key);
          }
        }
        if (s.people >= 4) keys.push("world_conqueror");
        if (row.turn <= A.blitz.n) keys.push("blitz");
        if (seen && !seen.lostCity) keys.push("flawless");
        if (seen && seen.lostCapital) keys.push("comeback");
      }
      for (const key of keys) give(earned, s.user_id, key, 1, ref);
    }
    queries.markGameAwarded.run(gameId);
    for (const userId of people.keys()) awardRecord(earned, userId, ref);
  })();

  for (const [userId, list] of earned) {
    log.info("achievements.earned", {
      user: userId, name: people.get(userId), game: gameId, keys: list.map((a) => a.key + (a.tierName ? `:${a.tier}` : "")).join(","),
    });
    events.emit("earned", { userId, earned: list });
  }
}

// What a person's record of counted games, up to `ref`'s game, has earned.
function awardRecord(earned, userId, ref) {
  const games = queries.achievementRecord.all({ userId, at: ref.at, gameId: ref.gameId });
  const won = games.filter((g) => g.won);
  give(earned, userId, "games_played", tierFor(A.games_played, games.length), ref);
  give(earned, userId, "wins", tierFor(A.wins, won.length), ref);
  give(earned, userId, "cities_captured", tierFor(A.cities_captured, games.reduce((n, g) => n + g.captures, 0)), ref);
  if (won.length) give(earned, userId, "first_blood", 1, ref);
  if (new Set(won.map((g) => g.seat)).size >= 4) give(earned, userId, "four_banners", 1, ref);
  let run = 0;
  for (const g of games) {
    run = g.won ? run + 1 : 0;
    if (run >= A.hat_trick.n) { give(earned, userId, "hat_trick", 1, ref); break; }
  }
}

// Record `key` at `tier` for a user; on anything new (a first award or a
// higher tier) add it to `earned` as the toast shows it.
function give(earned, userId, key, tier, ref) {
  if (tier < 1) return;
  const before = queries.getUserAchievement.get(userId, key);
  const info = queries.awardAchievement.run({ userId, key, tier, at: ref.at, gameId: ref.gameId });
  if (!info.changes) return;
  if (!earned.has(userId)) earned.set(userId, []);
  earned.get(userId).push({ ...view(key, tier), upgraded: !!before });
}

// An earned achievement as the client shows it, without needing the catalogue.
function view(key, tier) {
  const a = A[key];
  return { key, name: a.name, icon: a.icon, tier, tierName: tierName(a, tier), desc: describeAchievement(a, tier) };
}

// ---- reading ----

// A user's achievements and the counts behind the tiered ones.
function listFor(userId) {
  const games = queries.achievementRecord.all({ userId, at: null, gameId: null });
  return {
    earned: queries.listAchievements.all(userId).map((r) => ({
      key: r.key, tier: r.tier, earnedAt: r.earned_at, gameId: r.game_id,
    })),
    progress: {
      games_played: games.length,
      wins: games.filter((g) => g.won).length,
      cities_captured: games.reduce((n, g) => n + g.captures, 0),
    },
  };
}

module.exports = { events, gameEnded, start, idle, stop, listFor };
