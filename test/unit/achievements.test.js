"use strict";

// Achievements without a server: the catalogue holds together, the engine's
// observer reports combat as it happens without changing the game, the
// tracker turns events and states into feats for the seats a person plays,
// and analyzeGame replays a record and refuses one of other rules or one
// that does not end where the stored game did.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ACHIEVEMENTS, ACHIEVEMENT_GROUPS, ACHIEVEMENTS_BY_KEY: A, describeAchievement, tierName, tierFor, maxTier,
} = require("../../src/shared/achievements");
const { UNIT_DEFS, TECH_DEFS, BUILDING_DEFS, RESOURCES } = require("../../src/shared/state");
const { DIFFICULTIES } = require("../../src/shared/settings");
const { Game, RULES_VERSION, PLAYER_NAMES } = require("../../src/shared/game");
const { runCpuTurns } = require("../../src/shared/ai");
const { serializeGame } = require("../../src/shared/snapshot");
const { replayStart, replayStep } = require("../../src/shared/replay");
const { analyzeGame, Tracker, MEDIEVAL } = require("../../src/achievements/analyze");

describe("the catalogue", () => {
  test("keys are unique, groups known, thresholds where the text needs them", () => {
    assert.equal(new Set(ACHIEVEMENTS.map((a) => a.key)).size, ACHIEVEMENTS.length);
    const groups = new Set(ACHIEVEMENT_GROUPS.map((g) => g.key));
    for (const a of ACHIEVEMENTS) {
      assert.ok(groups.has(a.group), a.key);
      assert.ok(a.name && a.icon && a.desc, a.key);
      assert.equal(a.desc.includes("{n}"), a.n !== undefined || a.tiers !== undefined, a.key);
      if (a.tiers) assert.deepEqual([...a.tiers].sort((x, y) => x - y), a.tiers, `${a.key} tiers ascend`);
      if (a.difficulty) assert.ok(DIFFICULTIES.includes(a.difficulty), a.key);
      for (const u of a.units ?? []) assert.ok(UNIT_DEFS[u], `${a.key}: ${u}`);
      for (const r of a.resources ?? []) assert.ok(RESOURCES[r], `${a.key}: ${r}`);
      if (a.building) assert.ok(BUILDING_DEFS[a.building], `${a.key}: ${a.building}`);
      // A civ's own names the seat that civ plays, and only those do.
      assert.equal(a.group === "civs", a.seat !== undefined, a.key);
      if (a.seat !== undefined) assert.ok(a.desc.startsWith(`As ${a.seat === 2 ? "the Huns" : PLAYER_NAMES[a.seat]},`), a.key);
    }
    for (const g of ACHIEVEMENT_GROUPS) assert.ok(ACHIEVEMENTS.some((a) => a.group === g.key), g.key);
  });

  test("descriptions, tier names and tiers reached", () => {
    assert.equal(describeAchievement(A.blitz), "Win a game by turn 150.");
    assert.equal(describeAchievement(A.wins, 2), "Win 25 games.");
    assert.equal(describeAchievement(A.wins, 9), "Win 100 games.", "clamped to the last tier");
    assert.equal(describeAchievement(A.first_blood), "Win a game.");
    assert.equal(tierName(A.wins, 1), "Bronze");
    assert.equal(tierName(A.wins, 3), "Gold");
    assert.equal(tierName(A.blitz, 1), null);
    assert.deepEqual([0, 4, 5, 24, 25, 100, 500].map((n) => tierFor(A.wins, n)), [0, 0, 1, 1, 2, 3, 3]);
    assert.deepEqual([tierFor(A.blitz, 0), tierFor(A.blitz, 1)], [0, 1]);
    assert.deepEqual([maxTier(A.wins), maxTier(A.blitz)], [3, 1]);
  });

  test("medieval units are those of medieval techs", () => {
    assert.deepEqual([...MEDIEVAL].sort(), ["crossbowman", "knight", "longswordsman", "pikeman", "trebuchet"]);
  });
});

describe("the engine's observer", () => {
  test("reports captures, kills, attacks on cities and research as they happen, and changes nothing", () => {
    const watched = new Game({ seed: 1000, cpuFlags: [true, true, true, true] });
    const seen = [];
    watched.observer = (ev, game) => {
      seen.push(ev.type);
      if (ev.type === "cityCaptured") {
        assert.equal(game.cityById(ev.cityId).owner, ev.by);
        assert.notEqual(ev.by, ev.from);
        assert.equal(ev.eliminated, game.civs[ev.from].isEliminated);
        assert.equal(ev.capital, game.civs[ev.from].originalCapital?.id === ev.cityId);
        assert.equal(UNIT_DEFS[ev.attackerType].type, "melee", "only soldiers take cities");
      } else if (ev.type === "techResearched") {
        assert.ok(game.civs[ev.civ].techsResearched.has(ev.tech));
        assert.equal(game.civs[ev.civ].currentResearch, ev.tech, "told before the next is chosen");
      } else if (ev.type === "cityAttacked") {
        assert.notEqual(ev.by, ev.owner);
        if (!ev.fell) assert.equal(game.cityById(ev.cityId).owner, ev.owner);
      } else {
        assert.equal(ev.type, "unitKilled");
        assert.ok(UNIT_DEFS[ev.attackerType] && UNIT_DEFS[ev.victimType]);
        assert.notEqual(ev.by, ev.victim);
      }
    };
    runCpuTurns(watched, 200);
    for (const type of ["cityCaptured", "cityAttacked", "unitKilled", "techResearched"]) assert.ok(seen.includes(type), type);

    const plain = new Game({ seed: 1000, cpuFlags: [true, true, true, true] });
    runCpuTurns(plain, 200);
    assert.deepEqual(serializeGame(watched), serializeGame(plain));
  });
});

describe("the tracker", () => {
  // A game whose seat 0 is a person's, with a city of theirs.
  function setup() {
    const game = new Game({ seed: 7, cpuFlags: [false, true, true, true] });
    const seats = [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }];
    const settler = game.civs[0].units.find((u) => u.unitType === "settler");
    const city = game.foundCity(settler);
    return { game, seats, city, tracker: new Tracker(seats) };
  }
  const feats = (t, seat = 0) => t.result()[seat].feats;

  test("captures: a capital, a last city, and losses on the other side", () => {
    const { game, tracker } = setup();
    tracker.onEvent({ type: "cityCaptured", by: 0, from: 1, cityId: 1, capital: true, eliminated: false }, game);
    tracker.onEvent({ type: "cityCaptured", by: 0, from: 2, cityId: 2, capital: false, eliminated: true }, game);
    // The AI's captures are nobody's feat, but they are seat 0's losses.
    tracker.onEvent({ type: "cityCaptured", by: 3, from: 0, cityId: 3, capital: false, eliminated: false }, game);
    const r = tracker.result();
    assert.deepEqual(r[0].feats, ["capital_punishment", "kingslayer"]);
    assert.equal(r[0].captures, 2);
    assert.deepEqual([r[0].lostCity, r[0].lostCapital], [true, false]);
    assert.deepEqual([r[1].lostCity, r[1].lostCapital], [true, true]);
    assert.deepEqual([r[3].captures, r[3].feats], [0, []]);
  });

  test("a fortress holds a walled and castled city through five attacks; a fall starts over", () => {
    const { game, city, tracker } = setup();
    const hit = (fell = false) => tracker.onEvent({ type: "cityAttacked", by: 1, owner: 0, cityId: city.id, fell }, game);
    for (let i = 0; i < 5; i++) hit();
    assert.deepEqual(feats(tracker), [], "no walls and castle yet");
    city.buildings.push("walls", "castle");
    for (let i = 0; i < 4; i++) hit();
    hit(true);
    tracker.onEvent({ type: "cityCaptured", by: 1, from: 0, cityId: city.id, capital: true, eliminated: false }, game);
    hit();
    assert.deepEqual(feats(tracker), []);
    for (let i = 0; i < 4; i++) hit();
    assert.deepEqual(feats(tracker), ["fortress"]);
  });

  test("an underdog is a warrior or archer of a person's killing a medieval unit", () => {
    const { game, tracker } = setup();
    const kill = (by, attackerType, victimType) =>
      tracker.onEvent({ type: "unitKilled", by, attackerType, victim: by ? 0 : 1, victimType }, game);
    kill(0, "warrior", "warrior");
    kill(0, "swordsman", "knight");
    kill(1, "archer", "knight");
    assert.deepEqual(feats(tracker), []);
    kill(0, "archer", "trebuchet");
    assert.deepEqual(feats(tracker), ["underdog"]);
  });

  test("the state of a person's civ: techs, buildings, a big city, units, resources, cities founded", () => {
    const { game, city, tracker } = setup();
    const civ = game.civs[0];
    const found = { seat: 0, action: { type: "foundCity" } };
    const step = (rec = { seat: 0, action: { type: "endTurn" } }) => tracker.afterStep(game, rec);
    // Resources on tiles of seat 0's, set before the tracker first looks.
    const land = [...game.tiles.values()].filter((t) => t.terrain !== "ocean" && !t.resource).slice(0, 5);
    ["gold", "silver", "diamonds", "iron", "horses"].forEach((r, i) => { land[i].resource = r; land[i].owner = null; });
    step();
    assert.deepEqual(feats(tracker), []);

    for (let i = 0; i < 4; i++) step(found);
    assert.deepEqual(feats(tracker), []);
    step(found);
    for (const t of Object.keys(TECH_DEFS)) civ.techsResearched.add(t);
    city.population = A.metropolis.n;
    city.buildings = Object.keys(BUILDING_DEFS);
    for (const u of A.upgrade_path.units) civ.units.push({ unitType: u });
    for (const t of land) t.owner = 0;
    step();
    assert.deepEqual(feats(tracker), [
      "founder", "golden_age", "iron_and_horses", "metropolis", "scholar", "treasure_hunter", "upgrade_path",
    ]);
  });

  test("iron and horses only by the turn; nothing once the AI has the seat or the civ is gone", () => {
    const { game, seats, tracker } = setup();
    const land = [...game.tiles.values()].filter((t) => t.terrain !== "ocean" && !t.resource).slice(0, 2);
    land[0].resource = "iron"; land[1].resource = "horses";
    for (const t of land) t.owner = 0;
    game.turn = A.iron_and_horses.n + 1;
    tracker.afterStep(game, { seat: 0, action: { type: "endTurn" } });
    assert.deepEqual(feats(tracker), []);

    game.turn = 1;
    game.civs[0].isEliminated = true;
    tracker.afterStep(game, { seat: 0, action: { type: "endTurn" } });
    assert.deepEqual(feats(tracker), []);

    game.civs[0].isEliminated = false;
    seats[0].kind = "ai";
    tracker.afterStep(game, { seat: 0, action: { type: "foundCity" } });
    tracker.onEvent({ type: "cityCaptured", by: 0, from: 1, cityId: 1, capital: true, eliminated: true }, game);
    assert.deepEqual(feats(tracker), []);
    assert.equal(tracker.result()[0].captures, 0);
  });
});

describe("the civilizations' own", () => {
  // Every seat a person's, each civ with a city: seat i is Rome, Greece, the
  // Huns, Babylon.
  function setup() {
    const game = new Game({ seed: 7, cpuFlags: [false, false, false, false] });
    const seats = game.civs.map(() => ({ kind: "human" }));
    const cities = game.civs.map((c) => game.foundCity(c.units.find((u) => u.unitType === "settler")));
    return { game, seats, cities, tracker: new Tracker(seats) };
  }
  const take = (tracker, game, by, from, cityId, attackerType = "swordsman") =>
    tracker.onEvent({ type: "cityCaptured", by, from, cityId, attackerType, capital: false, eliminated: false }, game);
  const feats = (tracker, seat) => tracker.result()[seat].feats;

  test("Veni, Vidi, Vici: Rome takes three cities in one turn", () => {
    const { game, cities, tracker } = setup();
    game.turn = 5;
    take(tracker, game, 0, 1, cities[1].id);
    take(tracker, game, 0, 2, cities[2].id);
    game.turn = 6;
    take(tracker, game, 0, 3, cities[3].id);
    // Greece taking three in one turn is not Rome.
    for (let i = 0; i < 3; i++) take(tracker, game, 1, 2, cities[2].id);
    assert.deepEqual([feats(tracker, 0), feats(tracker, 1)], [[], []]);
    take(tracker, game, 0, 1, cities[1].id);
    take(tracker, game, 0, 2, cities[2].id);
    assert.deepEqual(feats(tracker, 0), ["veni_vidi_vici"]);
  });

  test("Beware of Greeks Bearing Gifts: Greece takes a walled city with a Horseman", () => {
    const { game, cities, tracker } = setup();
    take(tracker, game, 1, 0, cities[0].id, "horseman");
    cities[0].buildings.push("walls");
    take(tracker, game, 1, 0, cities[0].id, "knight");
    take(tracker, game, 0, 1, cities[0].id, "horseman");
    assert.deepEqual([feats(tracker, 0), feats(tracker, 1)], [[], []]);
    take(tracker, game, 1, 0, cities[0].id, "horseman");
    assert.deepEqual(feats(tracker, 1), ["greeks_bearing_gifts"]);
  });

  test("An Eye for an Eye: Babylon pays back the civ that took its city, on its very next turn", () => {
    const { game, cities, tracker } = setup();
    game.turn = 4;
    take(tracker, game, 1, 3, cities[3].id);   // Greece takes a city of Babylon's
    take(tracker, game, 3, 2, cities[2].id);   // Babylon takes from the Huns instead
    game.turn = 5;
    take(tracker, game, 3, 1, cities[1].id);   // a round too late
    assert.deepEqual(feats(tracker, 3), []);
    take(tracker, game, 1, 3, cities[3].id);
    take(tracker, game, 3, 1, cities[1].id);   // the same round: Babylon plays after Greece
    assert.deepEqual(feats(tracker, 3), ["eye_for_an_eye"]);
    // Rome paying the Huns back is the same feat, but not Rome's to earn.
    take(tracker, game, 2, 0, cities[0].id);
    game.turn = 6;
    take(tracker, game, 0, 2, cities[2].id);
    assert.deepEqual(feats(tracker, 0), []);
  });

  test("Brute Force: the Huns know every tech before anyone else does", () => {
    const research = (game, tracker, civ) => {
      for (const t of Object.keys(TECH_DEFS)) game.civs[civ].techsResearched.add(t);
      tracker.onEvent({ type: "techResearched", civ, tech: "education" }, game);
    };
    const first = setup();
    first.tracker.onEvent({ type: "techResearched", civ: 2, tech: "mining" }, first.game);
    research(first.game, first.tracker, 2);
    research(first.game, first.tracker, 0);
    assert.deepEqual(feats(first.tracker, 2), ["brute_force"]);
    assert.deepEqual(feats(first.tracker, 0), [], "Rome finishing second, or at all, is nothing");

    const second = setup();
    research(second.game, second.tracker, 1);
    research(second.game, second.tracker, 2);
    assert.deepEqual(feats(second.tracker, 2), []);

    const ai = setup();
    ai.seats[2].kind = "ai";
    research(ai.game, ai.tracker, 2);
    assert.deepEqual(feats(ai.tracker, 2), [], "not once the AI has the seat");
  });
});

describe("analyzeGame", () => {
  // A short game played through the replay itself, as the server would have
  // stored it: seat 0 founds its capital and ends three turns.
  function record() {
    const setup = { seed: 11, cpuFlags: [false, true, true, true], difficultyFlags: ["prince", "prince", "prince", "prince"] };
    const game = replayStart(setup);
    const seats = setup.cpuFlags.map((cpu) => ({ kind: cpu ? "ai" : "human", missedTurns: 0 }));
    const settler = game.civs[0].units.find((u) => u.unitType === "settler");
    const actions = [{ seq: 1, seat: 0, action: { type: "foundCity", unitId: settler.id } }];
    for (let i = 0; i < 3; i++) actions.push({ seq: actions.length + 1, seat: 0, action: { type: "endTurn" } });
    for (const rec of actions) assert.equal(replayStep(game, seats, rec).ok, true);
    return { setup, actions, snapshot: JSON.stringify(serializeGame(game)) };
  }

  test("replays a record to the stored end and reports every seat", () => {
    const res = analyzeGame(record());
    assert.equal(res.ok, true);
    assert.equal(res.seats.length, 4);
    assert.deepEqual(res.seats[0], { feats: [], captures: 0, lostCity: false, lostCapital: false });
  });

  test("a record that ends elsewhere, or that the rules refuse, reports nothing", () => {
    const r = record();
    const moved = JSON.parse(r.snapshot);
    moved.game.turn += 1;
    assert.deepEqual(analyzeGame({ ...r, snapshot: JSON.stringify(moved) }), { ok: false, error: "mismatch" });
    const bad = [...r.actions, { seq: 5, seat: 0, action: { type: "fortify", unitId: 99999 } }];
    assert.deepEqual(analyzeGame({ ...r, actions: bad }), { ok: false, error: "refused", seq: 5 });
    const later = { ...r.setup, rules: RULES_VERSION + 1 };
    assert.deepEqual(analyzeGame({ ...r, setup: later }), { ok: false, error: "rules" });
  });
});
