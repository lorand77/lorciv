"use strict";

// The engine is deterministic from its seed: the map comes from the seed,
// combat and the AI have no randomness, and the one mid-game draw (bankruptcy)
// comes from the game's own seeded generator, whose state the snapshot keeps.
// So two games with the same seed and actions are identical, and a game
// resumed from a snapshot plays on exactly as the original would.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("../../src/shared/game");
const { runCpuTurns } = require("../../src/shared/ai");
const { serializeGame, deserializeGame } = require("../../src/shared/snapshot");

const ALL_CPU = [true, true, true, true];
const snap = (g) => JSON.stringify(serializeGame(g));

describe("determinism", () => {
  test("two games from one seed, played by the AI, are identical", () => {
    const a = new Game({ seed: 4242, cpuFlags: ALL_CPU });
    const b = new Game({ seed: 4242, cpuFlags: ALL_CPU });
    runCpuTurns(a, 150);
    runCpuTurns(b, 150);
    assert.equal(snap(a), snap(b));
    assert.ok(a.turn > 100, "the game ran");
  });

  test("different seeds give different maps", () => {
    const terrain = (g) => [...g.tiles.values()].map((t) => t.terrain).join("");
    assert.notEqual(terrain(new Game({ seed: 1 })), terrain(new Game({ seed: 2 })));
  });

  test("a game resumed from a mid-game snapshot plays on exactly as the original", () => {
    const a = new Game({ seed: 99, cpuFlags: ALL_CPU });
    runCpuTurns(a, 40);
    const b = deserializeGame(JSON.parse(snap(a)));
    assert.equal(snap(b), snap(a), "the reload itself changes nothing");
    runCpuTurns(a, 150);
    runCpuTurns(b, 150);
    assert.equal(snap(a), snap(b), "and the two futures agree");
  });

  test("a batch of AI-only games finishes without throwing", () => {
    for (let seed = 1000; seed < 1003; seed++) {
      const g = new Game({ seed, cpuFlags: ALL_CPU });
      runCpuTurns(g, 500);
      assert.ok(g.winner !== null || g.turn > 500, `seed ${seed}: a winner or the cap`);
      assert.equal(g.scoreHistory.length, g.turn - 1, `seed ${seed}: one score entry per completed round`);
      const ids = g.civs.flatMap((c) => [...c.units, ...c.cities].map((e) => e.id));
      assert.ok(ids.every(Number.isInteger), `seed ${seed}: every unit and city has an id`);
      assert.equal(new Set(ids).size, ids.length, `seed ${seed}: ids are unique`);
    }
  });
});
