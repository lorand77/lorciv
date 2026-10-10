"use strict";

// src/shared/snapshot.js: the whole game as JSON and back, with everything a
// resumed game needs (ids, random state, score history, AI memory, who is AI).

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("../../src/shared/game");
const { runCpuTurns } = require("../../src/shared/ai");
const { SNAPSHOT_VERSION, serializeGame, deserializeGame } = require("../../src/shared/snapshot");

const ALL_CPU = [true, true, true, true];
const viaJson = (obj) => JSON.parse(JSON.stringify(obj));

describe("snapshot", () => {
  test("round trip is the identity at several points of a game", () => {
    const g = new Game({ seed: 7, cpuFlags: ALL_CPU });
    for (const stop of [1, 30, 90]) {
      runCpuTurns(g, stop);
      const once = serializeGame(g);
      const again = serializeGame(deserializeGame(viaJson(once)));
      assert.deepEqual(again, once, `after turn ${stop}`);
    }
  });

  test("carries the version, ids, random state, score history and AI memory", () => {
    const g = new Game({ seed: 7, cpuFlags: ALL_CPU });
    runCpuTurns(g, 30);
    const s = serializeGame(g);
    assert.equal(s.version, SNAPSHOT_VERSION);
    assert.equal(typeof s.game.rngState, "number");
    assert.ok(s.game.nextId > 12, "ids were handed out beyond the twelve starting units");
    assert.equal(s.game.scoreHistory.length, g.turn - 1);
    assert.ok(Object.keys(s.game.aiState).length > 0, "the AI remembered its strategies");
    const ids = s.game.civs.flatMap((c) => [...c.units, ...c.cities].map((e) => e.id));
    assert.equal(new Set(ids).size, ids.length, "ids are unique");

    const b = deserializeGame(viaJson(s));
    assert.equal(b.nextId, g.nextId);
    assert.equal(b._rng.getState(), g._rng.getState());
    for (const civ of g.civs) {
      for (const u of civ.units) assert.equal(b.unitById(u.id).unitType, u.unitType);
      for (const c of civ.cities) assert.equal(b.cityById(c.id).name, c.name);
    }
    // Tiles point back at the rebuilt objects, not at copies.
    const city = b.civs.find((c) => c.cities.length).cities[0];
    assert.equal(b.tiles.get(`${city.q},${city.r}`).city, city);
  });

  test("a seat handed to the AI stays an AI seat after a reload", () => {
    const g = new Game({ seed: 7, cpuFlags: [false, true, true, true] });
    g.civs[0].isCpu = true;
    const b = deserializeGame(viaJson(serializeGame(g)));
    assert.equal(b.civs[0].isCpu, true);
    assert.deepEqual(b.setup.cpuFlags, [false, true, true, true], "setup records how the game began");
  });

  test("the setup of a game is recorded whatever shape it was given in", () => {
    const g = new Game({ seed: 3 });
    assert.deepEqual(g.setup, {
      seed: 3, cpuFlags: [false, true, true, true], difficultyFlags: ["prince", "prince", "prince", "prince"],
    });
  });

  test("an unknown version is refused", () => {
    assert.throws(() => deserializeGame({ version: 1 }), /version mismatch/);
    assert.throws(() => deserializeGame(null), /version mismatch/);
  });
});
