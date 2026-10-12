"use strict";

// What each seat did in one ended game, read by replaying it: the feats of
// the achievement catalogue that happen inside a game (a capital taken, a
// city of size 20, every tech researched...) and the number of cities each
// seat took. Pure: no database, no clock. It runs in the achievements worker
// (worker.js), because replaying re-runs every AI turn and a long game takes
// seconds, and the tests call it directly.
//
// A seat earns a feat only while a person plays it: the replay's seat state
// says whether it still did at the moment something happened. What the AI
// did after taking a seat over is not the person's. Whether the game counts
// for that person at all (the leaderboard's rule) is the caller's question.

const { rulesAllow, endsOn, replayStart, replayStep } = require("../shared/replay");
const { UNIT_DEFS, TECH_DEFS, BUILDING_DEFS } = require("../shared/state");
const { ACHIEVEMENTS_BY_KEY: A } = require("../shared/achievements");

const TECH_COUNT = Object.keys(TECH_DEFS).length;
const BUILDINGS = Object.keys(BUILDING_DEFS).filter((k) => k !== "palace");
// A unit is medieval when the tech it needs is of the medieval era.
const MEDIEVAL = new Set(Object.keys(UNIT_DEFS).filter((k) => {
  const tech = UNIT_DEFS[k].requires_tech;
  return tech && TECH_DEFS[tech].era === "medieval";
}));

class Tracker {
  // `seats` is the replay's mutable seat state ([{ kind }]), read as events
  // happen, so a seat handed to the AI stops earning at that moment.
  constructor(seats) {
    this.kinds = seats;
    this.seats = seats.map(() => ({
      feats: new Set(), captures: 0, founded: 0, lostCity: false, lostCapital: false, sieges: new Map(),
    }));
    this.resourceTiles = null;
  }

  human(seat) {
    return this.kinds[seat].kind === "human";
  }

  earn(seat, key) {
    this.seats[seat].feats.add(key);
  }

  // Game.observer: combat as it happens.
  onEvent(ev, game) {
    if (ev.type === "cityCaptured") {
      const loser = this.seats[ev.from];
      loser.lostCity = true;
      if (ev.capital) loser.lostCapital = true;
      loser.sieges.delete(ev.cityId);
      if (!this.human(ev.by)) return;
      this.seats[ev.by].captures++;
      if (ev.capital) this.earn(ev.by, "capital_punishment");
      if (ev.eliminated) this.earn(ev.by, "kingslayer");
    } else if (ev.type === "cityAttacked") {
      if (ev.fell || !this.human(ev.owner)) return;
      const city = game.cityById(ev.cityId);
      if (!city.buildings.includes("walls") || !city.buildings.includes("castle")) return;
      const sieges = this.seats[ev.owner].sieges;
      const n = (sieges.get(ev.cityId) ?? 0) + 1;
      sieges.set(ev.cityId, n);
      if (n >= A.fortress.n) this.earn(ev.owner, "fortress");
    } else if (ev.type === "unitKilled") {
      if (this.human(ev.by) && A.underdog.units.includes(ev.attackerType) && MEDIEVAL.has(ev.victimType)) {
        this.earn(ev.by, "underdog");
      }
    }
  }

  // After each recorded action and the AI turns that followed it: what the
  // state of each person's civ shows.
  afterStep(game, rec) {
    if (rec.action.type === "foundCity" && this.human(rec.seat)) {
      if (++this.seats[rec.seat].founded >= A.founder.n) this.earn(rec.seat, "founder");
    }
    // A tile's resource never changes, only its owner.
    this.resourceTiles ??= [...game.tiles.values()].filter((t) => t.resource);
    const held = game.civs.map(() => new Set());
    for (const t of this.resourceTiles) if (t.owner !== null) held[t.owner].add(t.resource);

    for (let seat = 0; seat < this.seats.length; seat++) {
      const civ = game.civs[seat];
      if (!this.human(seat) || civ.isEliminated) continue;
      if (civ.techsResearched.size >= TECH_COUNT) this.earn(seat, "scholar");
      if (civ.cities.some((c) => c.population >= A.metropolis.n)) this.earn(seat, "metropolis");
      const standing = new Set(civ.cities.flatMap((c) => c.buildings));
      if (BUILDINGS.every((b) => standing.has(b))) this.earn(seat, "golden_age");
      const fielded = new Set(civ.units.map((u) => u.unitType));
      if (A.upgrade_path.units.every((u) => fielded.has(u))) this.earn(seat, "upgrade_path");
      if (A.treasure_hunter.resources.every((r) => held[seat].has(r))) this.earn(seat, "treasure_hunter");
      if (game.turn <= A.iron_and_horses.n && A.iron_and_horses.resources.every((r) => held[seat].has(r))) {
        this.earn(seat, "iron_and_horses");
      }
    }
  }

  result() {
    return this.seats.map((s) => ({
      feats: [...s.feats].sort(), captures: s.captures, lostCity: s.lostCity, lostCapital: s.lostCapital,
    }));
  }
}

// Replay a game the way the server played it (src/shared/replay.js) and
// report per seat. `record` is { setup, actions, snapshot }: the actions as
// the replay route sends them and the game's stored snapshot (JSON), which
// the replay must end on exactly. A record that does not replay (other rules,
// an action refused, or a different end: a game played under older rules
// before versions existed) reports { ok: false, error } instead, and nothing
// it saw on the way counts.
function analyzeGame(record) {
  if (!rulesAllow(record.setup)) return { ok: false, error: "rules" };
  const seats = record.setup.cpuFlags.map((cpu) => ({ kind: cpu ? "ai" : "human", missedTurns: 0 }));
  const tracker = new Tracker(seats);
  const game = replayStart(record.setup, (ev, g) => tracker.onEvent(ev, g));
  for (const rec of record.actions) {
    const res = replayStep(game, seats, rec);
    if (!res.ok) return { ok: false, error: "refused", seq: rec.seq };
    tracker.afterStep(game, rec);
  }
  if (!endsOn(game, JSON.parse(record.snapshot))) return { ok: false, error: "mismatch" };
  return { ok: true, seats: tracker.result() };
}

module.exports = { analyzeGame, Tracker, MEDIEVAL };
