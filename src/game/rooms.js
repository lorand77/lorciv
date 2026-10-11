"use strict";

// In-memory authoritative state for live games. The server owns one engine
// instance (src/shared/game.js) per active game; clients are never trusted for
// legality, turn or seat. Rooms are keyed by gameId and map 1:1 to the
// Socket.IO room `game:<id>`. After every accepted action the whole game is
// written to the games row as a snapshot, so a room can be rebuilt from the
// database at any time; at boot every active game is rebuilt so its turn
// timer runs whether or not anyone is connected.
//
// A game starts life as a table (status 'lobby'): seats are taken in the lobby
// and the host starts it. Tables have no room; they live only in the database.
//
// This module knows nothing about sockets. It emits on `events` and
// socket.js broadcasts: "state" (room) after any change to a game, "lobby" ()
// when what the lobby lists has changed, "turn" (room) when a human seat's
// turn begins.

const EventEmitter = require("events");
const db = require("../db/index");
const queries = require("../db/queries");
const log = require("../log");
const config = require("../config");
const { Game, PLAYER_NAMES } = require("../shared/game");
const { runCpuTurns } = require("../shared/ai");
const { serializeGame, deserializeGame } = require("../shared/snapshot");
const { applyAction } = require("../shared/actions");
const settings = require("../shared/settings");

const rooms = new Map(); // gameId -> room
const events = new EventEmitter();
let sweepTimer = null;
let abandonTimer = null;

// ---- seats ----

function seatsFromRows(rows) {
  return rows.map((r) => ({
    seat: r.seat,
    kind: r.kind,
    userId: r.user_id,
    username: r.username ?? null,
    difficulty: r.difficulty,
    missedTurns: r.missed_turns,
  }));
}

function seatView(s) {
  return {
    seat: s.seat, kind: s.kind, username: s.username, difficulty: s.difficulty,
    missedTurns: s.missedTurns, civ: PLAYER_NAMES[s.seat],
  };
}

// The seat a user plays in a room, or null (a spectator, or a seat the AI took over).
function seatOf(room, userId) {
  const s = room.seats.find((x) => x.kind === "human" && x.userId === userId);
  return s ? s.seat : null;
}

// The seat a user used to play before it was handed to the AI, or null.
function formerSeatOf(room, userId) {
  const s = room.seats.find((x) => x.kind === "ai" && x.userId === userId);
  return s ? s.seat : null;
}

// ---- tables ----

const insertTable = db.transaction((hostId, seed, gameSettings, seats) => {
  const info = queries.createTable.run(hostId, seed, JSON.stringify(gameSettings));
  const gameId = Number(info.lastInsertRowid);
  for (const s of seats) {
    const userId = s.kind === "human" ? s.userId : null;
    queries.insertSeat.run(gameId, s.seat, s.kind, userId, s.difficulty, userId);
  }
  return gameId;
});

// seats: [{ seat, kind: 'human'|'open'|'ai', userId?, difficulty }], validated by
// the caller. With no open seat the game starts at once; otherwise it waits in
// the lobby for people to take the open seats. Returns { gameId, status }.
function createGame({ hostId, seats, seed, settings: gameSettings }) {
  const gameId = insertTable(hostId, seed, gameSettings, seats);
  log.info("game.table", {
    game: gameId, host: hostId, seed,
    seats: seats.map((s) => `${s.kind}:${s.difficulty}`).join(","),
  });
  if (seats.some((s) => s.kind === "open")) {
    events.emit("lobby");
    return { gameId, status: "lobby" };
  }
  startGame(gameId, hostId);
  return { gameId, status: "active" };
}

function tableRow(gameId) {
  const row = queries.getGameById.get(gameId);
  if (!row) return { error: "no_such_game" };
  if (row.status !== "lobby") return { error: "not_lobby" };
  return { row };
}

// Take an open seat at a table. One seat per person per game.
function joinSeat(gameId, seat, user) {
  const { row, error } = tableRow(gameId);
  if (error) return { error };
  const seats = queries.getSeats.all(gameId);
  const s = seats[seat];
  if (!s) return { error: "no_such_seat" };
  if (seats.some((x) => x.user_id === user.id)) return { error: "already_seated" };
  if (s.kind !== "open") return { error: "seat_taken" };
  queries.takeSeat.run(user.id, gameId, seat);
  log.info("game.join_seat", { game: gameId, seat, user: user.id, name: user.username });
  events.emit("lobby");
  return { ok: true, host: row.host_id };
}

// Give up a seat at a table. The host cannot leave; the host cancels instead.
function leaveSeat(gameId, seat, userId) {
  const { row, error } = tableRow(gameId);
  if (error) return { error };
  const s = queries.getSeats.all(gameId)[seat];
  if (!s || s.kind !== "human" || s.user_id !== userId) return { error: "not_yours" };
  if (userId === row.host_id) return { error: "host" };
  queries.releaseSeat.run(gameId, seat);
  log.info("game.leave_seat", { game: gameId, seat, user: userId });
  events.emit("lobby");
  return { ok: true };
}

// The host takes a table down before it starts.
function cancelTable(gameId, userId) {
  const { row, error } = tableRow(gameId);
  if (error) return { error };
  if (row.host_id !== userId) return { error: "not_host" };
  queries.abortGame.run(gameId);
  log.info("game.cancel", { game: gameId, host: userId });
  events.emit("lobby");
  return { ok: true };
}

// When the current human seat's turn must end, or null: no timer for AI seats,
// for games that are over, and for tables whose turn time is "none".
function computeDeadline(room) {
  if (room.status !== "active") return null;
  const s = room.seats[room.game.currentPlayer];
  if (!s || s.kind !== "human") return null;
  const tt = settings.turnTimeOf(room.settings.turnTime);
  return tt && tt.ms ? Date.now() + tt.ms : null;
}

const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());

function makeRoom(gameId, game, { seq, status, settings: gameSettings, hostId, seats, snapshotJson, deadline }) {
  return {
    gameId,
    game,
    seq,
    status,
    settings: gameSettings,
    hostId,
    seats,
    // Milliseconds since the epoch when the current human turn expires, or null.
    deadline,
    // The JSON last written to the database: what viewFor hands out, and what
    // the room falls back to if a write fails.
    lastSnapshot: snapshotJson,
  };
}

// The host starts a table: open seats become AI seats, the engine is built
// from the seed, the AI seats before the first human play, and the first
// snapshot is written. From here on the game has a room.
const startInDb = db.transaction((gameId, snapshotJson, turn, currentSeat, deadlineIso) => {
  queries.fillOpenSeats.run(gameId);
  return queries.startGame.run(snapshotJson, turn, currentSeat, deadlineIso, gameId).changes;
});

function startGame(gameId, userId) {
  const { row, error } = tableRow(gameId);
  if (error) return { error };
  if (row.host_id !== userId) return { error: "not_host" };
  const seatRows = queries.getSeats.all(gameId);
  const kinds = seatRows.map((s) => (s.kind === "human" ? "human" : "ai"));
  const game = new Game({
    seed: row.seed,
    cpuFlags: kinds.map((k) => k !== "human"),
    // Only AI seats carry a difficulty's bonuses: a person plays at prince,
    // whatever a row created before this rule may say.
    difficultyFlags: seatRows.map((s) => (s.kind === "ai" ? s.difficulty : "prince")),
  });
  runCpuTurns(game); // AI seats before the first human take their turn now
  const gameSettings = JSON.parse(row.settings);
  const room = makeRoom(gameId, game, {
    seq: 0, status: "active", settings: gameSettings, hostId: row.host_id, seats: null,
    snapshotJson: null, deadline: null,
  });
  room.seats = seatsFromRows(seatRows).map((s) => (s.kind === "open" ? { ...s, kind: "ai", difficulty: "prince" } : s));
  room.deadline = computeDeadline(room);
  room.lastSnapshot = JSON.stringify(serializeGame(game));
  startInDb(gameId, room.lastSnapshot, game.turn, game.currentPlayer, isoOrNull(room.deadline));
  rooms.set(gameId, room);
  log.info("game.start", {
    game: gameId, host: row.host_id, seed: row.seed, turn_time: gameSettings.turnTime,
    seats: room.seats.map((s) => `${s.kind}${s.userId ? ":" + s.userId : ""}`).join(","),
  });
  events.emit("lobby");
  events.emit("state", room);
  events.emit("turn", room);
  return { ok: true, room };
}

// ---- live rooms ----

// The live room, rebuilt from the database if this process has not seen the
// game yet. null for an unknown game or a table that has not started.
function getRoom(gameId) {
  const live = rooms.get(gameId);
  if (live) return live;
  const row = queries.getGameById.get(gameId);
  if (!row || !row.snapshot) return null;
  const game = deserializeGame(JSON.parse(row.snapshot));
  const room = makeRoom(gameId, game, {
    seq: row.seq,
    status: row.status,
    settings: JSON.parse(row.settings),
    hostId: row.host_id,
    seats: seatsFromRows(queries.getSeats.all(gameId)),
    snapshotJson: row.snapshot,
    deadline: row.turn_deadline ? Date.parse(row.turn_deadline) : null,
  });
  // A game saved before timers existed, or whose human turn began without one,
  // gets its clock now rather than never.
  if (room.deadline === null) {
    const fresh = computeDeadline(room);
    if (fresh !== null) {
      room.deadline = fresh;
      queries.saveGameState.run(
        room.lastSnapshot, room.seq, game.turn, game.currentPlayer, room.status, game.winner,
        isoOrNull(fresh), room.status, gameId
      );
    }
  }
  rooms.set(gameId, room);
  log.info("game.resume", { game: gameId, seq: row.seq, turn: row.turn, status: row.status });
  return room;
}

// Only the fields an action can carry are stored; nothing else from the
// client's payload reaches the database.
function recordOf(action) {
  const rec = { type: action.type };
  for (const k of ["unitId", "cityId", "q", "r", "key"]) if (action[k] !== undefined) rec[k] = action[k];
  return rec;
}

// One accepted change's writes as a single transaction: the snapshot and the
// row's summary columns, the action's own row, and any seat change that came
// with it. All or nothing, so a failure can be rolled back in memory.
const persist = db.transaction((room, action, seat, userId, seatChange) => {
  const snapshotJson = JSON.stringify(serializeGame(room.game));
  queries.saveGameState.run(
    snapshotJson, room.seq, room.game.turn, room.game.currentPlayer, room.status, room.game.winner,
    isoOrNull(room.deadline), room.status, room.gameId
  );
  queries.insertAction.run(room.gameId, room.seq, seat, userId, JSON.stringify(recordOf(action)));
  if (seatChange) {
    const s = room.seats[seatChange.seat];
    queries.setMissedTurns.run(s.missedTurns, room.gameId, s.seat);
    queries.setSeatKind.run(s.kind, room.gameId, s.seat);
  }
  return snapshotJson;
});

// A seat still played by a person whose civ is still in the game. Once none
// is left the game is abandoned, not played out by the AI.
function humanLeft(room) {
  return room.seats.some((s) => s.kind === "human" && !room.game.civs[s.seat].isEliminated);
}

// The room as of its last write, to roll back to.
function savedState(room) {
  return { seq: room.seq, status: room.status, deadline: room.deadline, snapshot: room.lastSnapshot };
}

// Put the room back as it was at its last write: the engine from the last
// snapshot, the seats from the database.
function restore(room, saved) {
  room.game = deserializeGame(JSON.parse(saved.snapshot));
  room.seq = saved.seq;
  room.status = saved.status;
  room.deadline = saved.deadline;
  room.lastSnapshot = saved.snapshot;
  room.seats = seatsFromRows(queries.getSeats.all(room.gameId));
}

// Run one change to a room. Whatever throws in it before the write (the
// validator, the engine, the AI) puts the room back as it was at its last
// write before the error goes on, so memory never holds a state that the
// database and the action log do not, and a retry starts from the same place.
// `seq` moves only with a successful write; after one there is nothing to undo.
function guarded(room, fn) {
  const saved = savedState(room);
  try {
    return fn();
  } catch (err) {
    if (room.seq === saved.seq) restore(room, saved);
    throw err;
  }
}

// After the engine has changed: let the AI seats play up to the next human,
// settle victory or abandonment, compute the next deadline, write everything,
// and tell the world. `seatChange` names a seat whose kind or missed-turn
// count changed with this action. Returns null, or an error result when the
// write failed and the room was rolled back.
function commit(room, action, seat, userId, seatChange = null) {
  const game = room.game;
  const last = JSON.parse(room.lastSnapshot).game;
  const before = { ...savedState(room), player: last.currentPlayer, turn: last.turn };
  // runCpuTurns stops by itself if the AI eliminates the last human civ.
  if (humanLeft(room)) {
    runCpuTurns(game);
    game.checkVictory();
  }

  if (game.winner !== null) room.status = "finished";
  else if (!humanLeft(room)) room.status = "aborted";
  // The clock starts when a turn begins and runs until it ends; an action
  // within the turn must not restart it, or a player could hold the turn
  // forever with a move a minute. A game that ended has no clock at all.
  const turnChanged = before.player !== game.currentPlayer || before.turn !== game.turn;
  if (turnChanged || room.status !== "active" || room.deadline === null) room.deadline = computeDeadline(room);
  room.seq++;
  try {
    room.lastSnapshot = persist(room, action, seat, userId, seatChange);
  } catch (err) {
    log.error("game.persist_failed", { game: room.gameId, seq: room.seq, err });
    restore(room, before);
    return { ok: false, error: "server_error", message: "Could not save the game." };
  }
  if (room.status === "finished") {
    log.info("game.over", { game: room.gameId, winner: game.winner, turn: game.turn, seq: room.seq });
  } else if (room.status === "aborted") {
    log.info("game.abort", { game: room.gameId, reason: "no_humans", turn: game.turn });
  }
  events.emit("state", room);
  // The lobby lists whose turn it is and the status, not every move.
  if (before.status !== room.status || turnChanged) events.emit("lobby");
  if (room.status === "active" && turnChanged) events.emit("turn", room);
  return null;
}

// Apply a player's action to the authoritative game. Validation is the shared
// validator's (src/shared/actions.js); this adds what only the server knows.
// Returns the validator's result shape.
function applyPlayerAction(room, seat, userId, action) {
  if (room.status !== "active") return { ok: false, error: "game_over", message: "" };
  return guarded(room, () => playerAction(room, seat, userId, action));
}

function playerAction(room, seat, userId, action) {
  const game = room.game;
  const civ = game.civs[seat];
  // The messages from this seat's last end of turn went out with the previous
  // state; the player has seen them and is acting on them.
  civ.pendingMessages = [];
  civ.researchJustCompleted = false;

  const res = applyAction(game, seat, action);
  if (!res.ok) return res;

  // Acting resets the count of turns the player let expire.
  const s = room.seats[seat];
  let seatChange = null;
  if (s.missedTurns) { s.missedTurns = 0; seatChange = { seat }; }
  return commit(room, action, seat, userId, seatChange) ?? res;
}

// A player hands their seat to the AI for the rest of the game.
function leaveGame(room, userId) {
  if (room.status !== "active") return { ok: false, error: "game_over" };
  const seat = seatOf(room, userId);
  if (seat === null) return { ok: false, error: "not_seated" };
  return guarded(room, () => {
    const s = room.seats[seat];
    s.kind = "ai";
    room.game.civs[seat].isCpu = true;
    log.info("game.takeover", { game: room.gameId, seat, user: userId, reason: "leave" });
    return commit(room, { type: "leave" }, seat, userId, { seat }) ?? { ok: true };
  });
}

// The current human seat's time is up: the server ends the turn for them and
// counts a missed turn. At the limit the seat is handed to the AI. Returns
// true when it acted.
function expireTurn(room, now = Date.now()) {
  if (room.status !== "active" || room.deadline === null || now < room.deadline) return false;
  const game = room.game;
  const seat = game.currentPlayer;
  const s = room.seats[seat];
  if (s.kind !== "human") { room.deadline = computeDeadline(room); return false; }
  return guarded(room, () => timeOut(room, seat));
}

function timeOut(room, seat) {
  const game = room.game;
  const s = room.seats[seat];
  const res = applyAction(game, seat, { type: "endTurn" });
  if (!res.ok) return false;
  s.missedTurns++;
  const takeover = s.missedTurns >= settings.MISSED_TURN_LIMIT;
  if (takeover) {
    s.kind = "ai";
    game.civs[seat].isCpu = true;
    log.info("game.takeover", { game: room.gameId, seat, user: s.userId, reason: "timeout", missed: s.missedTurns });
  } else {
    log.info("game.timeout", { game: room.gameId, seat, user: s.userId, missed: s.missedTurns });
  }
  commit(room, { type: "timeout" }, seat, null, { seat });
  return true;
}

// Every expired human turn, ended. Run on an interval; the tests call it.
function sweepDeadlines(now = Date.now()) {
  let n = 0;
  for (const room of rooms.values()) {
    try {
      if (expireTurn(room, now)) n++;
    } catch (err) {
      log.error("game.sweep_failed", { game: room.gameId, err });
    }
  }
  return n;
}

// Tables and games nobody has touched for ABANDON_DAYS are aborted.
function sweepAbandoned() {
  const cutoff = `-${config.ABANDON_DAYS} days`;
  const ids = queries.listAbandonable.all(cutoff).map((r) => r.id);
  if (!ids.length) return 0;
  queries.sweepAbandoned.run(cutoff);
  for (const id of ids) rooms.delete(id);
  log.info("game.abandon_sweep", { aborted: ids.length, days: config.ABANDON_DAYS });
  events.emit("lobby");
  return ids.length;
}

// At boot: rebuild every active game so its turn timer runs, and start the
// sweeps. Nothing is thrown away. A game that cannot be rebuilt (a snapshot
// from an engine version with no migration, a hand-edited row) is logged and
// left in the database; it must not keep every other game from booting.
function resumeAll() {
  sweepAbandoned();
  let n = 0;
  for (const { id } of queries.listActiveGameIds.all()) {
    try {
      if (getRoom(id)) n++;
    } catch (err) {
      log.error("game.resume_failed", { game: id, err });
    }
  }
  log.info("process.resumed", { games: n });
  if (!sweepTimer) sweepTimer = setInterval(() => sweepDeadlines(), config.DEADLINE_SWEEP_MS).unref();
  if (!abandonTimer) abandonTimer = setInterval(() => safely(sweepAbandoned, "abandon sweep"), 60 * 60 * 1000).unref();
  return n;
}

function safely(fn, label) {
  try { fn(); } catch (err) { log.error("game.sweep_failed", { task: label, err }); }
}

// ---- views ----

// What one user gets to see of a room. Today everyone sees everything, so this
// returns the whole snapshot; if fog of war ever comes, it is the one place to
// filter. `userId` is null for nobody in particular.
function viewFor(room, userId) {
  return {
    gameId: room.gameId,
    seq: room.seq,
    status: room.status,
    winner: room.game.winner,
    settings: room.settings,
    deadline: room.deadline,
    seats: room.seats.map(seatView),
    mySeat: userId == null ? null : seatOf(room, userId),
    formerSeat: userId == null ? null : formerSeatOf(room, userId),
    snapshot: JSON.parse(room.lastSnapshot),
  };
}

// The games row and seats as the REST API shows them (no snapshot). Works for
// tables as well as games.
function summary(row) {
  return {
    id: row.id,
    status: row.status,
    hostId: row.host_id,
    turn: row.turn,
    currentSeat: row.current_seat,
    winnerSeat: row.winner_seat,
    settings: JSON.parse(row.settings),
    deadline: row.turn_deadline ? Date.parse(row.turn_deadline) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seats: seatsFromRows(queries.getSeats.all(row.id)).map(seatView),
  };
}

function listRooms() {
  return [...rooms.values()];
}

// Forget every live room, stop the sweeps and drop the listeners (tests
// simulate a restart with it).
function clearAll() {
  rooms.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (abandonTimer) { clearInterval(abandonTimer); abandonTimer = null; }
  events.removeAllListeners();
}

module.exports = {
  events,
  createGame, joinSeat, leaveSeat, cancelTable, startGame,
  getRoom, seatOf, formerSeatOf, applyPlayerAction, leaveGame,
  expireTurn, sweepDeadlines, sweepAbandoned, resumeAll,
  viewFor, summary, listRooms, clearAll,
};
