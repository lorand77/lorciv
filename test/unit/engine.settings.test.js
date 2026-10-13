"use strict";

// src/shared/settings.js: the allowlists agree with the engine's catalogues,
// every action name has a handler, and every seat has its civ.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Game, DIFFICULTY_DEFS, PLAYER_NAMES, PLAYER_COLORS, PLAYER_BLURBS } = require("../../src/shared/game");
const { applyAction } = require("../../src/shared/actions");
const settings = require("../../src/shared/settings");

describe("settings", () => {
  test("difficulties are the engine's", () => {
    assert.deepEqual(settings.DIFFICULTIES, Object.keys(DIFFICULTY_DEFS));
  });

  test("turn-time presets are unique, the default exists, and 'none' means no limit", () => {
    const keys = settings.TURN_TIMES.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(settings.turnTimeOf(settings.DEFAULT_TURN_TIME).ms, 3 * 60 * 1000);
    assert.equal(settings.turnTimeOf("none").ms, null);
    assert.equal(settings.turnTimeOf("bogus"), null);
    for (const t of settings.TURN_TIMES) assert.equal(typeof t.label, "string");
  });

  test("every action type is known to applyAction", () => {
    assert.equal(new Set(settings.ACTION_TYPES).size, settings.ACTION_TYPES.length);
    const g = new Game({ seed: 5, cpuFlags: [false, true, true, true] });
    for (const type of settings.ACTION_TYPES) {
      const res = applyAction(g, 0, { type });
      assert.notEqual(res.error, "unknown_action", type);
      if (type === "endTurn") g.currentPlayer = 0; // undo for the next type
    }
  });

  test("the fixed numbers", () => {
    assert.equal(settings.MISSED_TURN_LIMIT, 3);
    assert.equal(settings.SEATS, 4);
  });

  test("every seat has a civ: a name, a colour and a short line for the lobby", () => {
    for (const list of [PLAYER_NAMES, PLAYER_COLORS, PLAYER_BLURBS]) assert.equal(list.length, settings.SEATS);
    for (const line of PLAYER_BLURBS) {
      const words = line.split(/\s+/).length;
      assert.ok(words >= 5 && words <= 10, `${line}: ${words} words`);
    }
  });
});
