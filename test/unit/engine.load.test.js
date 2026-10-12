"use strict";

// src/shared/ is loaded by Node and by the browser from the same files. These
// tests keep it loadable in Node without a DOM and hold it to the two-runtime
// rules in docs/CLAUDE.md.

const fs = require("fs");
const path = require("path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const SHARED = path.join(__dirname, "../../src/shared");
const FILES = ["hex.js", "state.js", "mapgen.js", "game.js", "ai.js", "snapshot.js", "settings.js", "actions.js", "replay.js", "achievements.js"];

describe("src/shared", () => {
  test("every file loads in Node and exports what the others need", () => {
    const hex = require(path.join(SHARED, "hex.js"));
    assert.equal(typeof hex.hexDistance, "function");
    const state = require(path.join(SHARED, "state.js"));
    assert.ok(state.UNIT_DEFS.warrior);
    assert.equal(typeof state.getReachableTiles, "function");
    const mapgen = require(path.join(SHARED, "mapgen.js"));
    assert.equal(typeof mapgen.generateMap, "function");
    const game = require(path.join(SHARED, "game.js"));
    assert.equal(typeof game.Game, "function");
    const ai = require(path.join(SHARED, "ai.js"));
    assert.equal(typeof ai.aiTakeTurn, "function");
    assert.equal(typeof ai.runCpuTurns, "function");
    const snapshot = require(path.join(SHARED, "snapshot.js"));
    assert.equal(snapshot.SNAPSHOT_VERSION, 2);
    const settings = require(path.join(SHARED, "settings.js"));
    assert.ok(Array.isArray(settings.ACTION_TYPES));
    const actions = require(path.join(SHARED, "actions.js"));
    assert.equal(typeof actions.applyAction, "function");
    const replay = require(path.join(SHARED, "replay.js"));
    assert.equal(typeof replay.replayAll, "function");
    const achievements = require(path.join(SHARED, "achievements.js"));
    assert.ok(achievements.ACHIEVEMENTS.length);
  });

  test("the directory holds exactly the engine files", () => {
    assert.deepEqual(fs.readdirSync(SHARED).sort(), [...FILES].sort());
  });

  test("no file touches the DOM, browser storage or Node-only APIs", () => {
    const banned = ["document.", "window.", "localStorage", "sessionStorage", "navigator.",
      "process.", "require(\"fs\")", "require('fs')", "require(\"path\")", "__dirname"];
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(SHARED, f), "utf8");
      for (const word of banned) assert.equal(src.includes(word), false, `${f} mentions ${word}`);
    }
  });

  test("every file is strict and ends with the Node export tail", () => {
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(SHARED, f), "utf8");
      assert.ok(src.startsWith("\"use strict\";"), `${f} is not strict`);
      assert.match(src, /typeof module !== ['"]undefined['"] && module\.exports\) module\.exports = |module\.exports = \{/, `${f} has no export tail`);
    }
  });
});
