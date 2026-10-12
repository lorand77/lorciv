"use strict";

// src/shared/replay.js, what tells a faithful replay from one that is not:
// the rules version a game was recorded under, and whether the replay ends on
// the stored final snapshot. (test/integration/replay.test.js checks a real
// game's replay snapshot for snapshot.)

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { RULES_VERSION } = require("../../src/shared/game");
const { serializeGame } = require("../../src/shared/snapshot");
const { rulesAllow, endsOn, replayStart, replayStep, replayAll } = require("../../src/shared/replay");

const SETUP = { seed: 11, cpuFlags: [false, true, true, true], difficultyFlags: ["prince", "prince", "prince", "prince"] };

// A short record as the server would have stored it: the capital founded and
// two turns ended, with the final snapshot.
function record(setup = { ...SETUP, rules: RULES_VERSION }) {
  const game = replayStart(setup);
  const seats = setup.cpuFlags.map((cpu) => ({ kind: cpu ? "ai" : "human", missedTurns: 0 }));
  const settler = game.civs[0].units.find((u) => u.unitType === "settler");
  const actions = [{ seq: 1, seat: 0, action: { type: "foundCity", unitId: settler.id } },
    { seq: 2, seat: 0, action: { type: "endTurn" } }, { seq: 3, seat: 0, action: { type: "endTurn" } }];
  for (const rec of actions) assert.equal(replayStep(game, seats, rec).ok, true);
  return { setup, actions, final: JSON.parse(JSON.stringify(serializeGame(game))) };
}

describe("replay", () => {
  test("today's rules, or none recorded, may be replayed; other rules may not", () => {
    assert.equal(rulesAllow({ ...SETUP, rules: RULES_VERSION }), true);
    assert.equal(rulesAllow(SETUP), true, "a game from before versions is tried");
    assert.equal(rulesAllow({ ...SETUP, rules: RULES_VERSION - 1 }), false);
    assert.equal(rulesAllow({ ...SETUP, rules: RULES_VERSION + 1 }), false);
  });

  test("a replay keeps the rules version of its record, or the lack of one", () => {
    assert.equal(replayStart({ ...SETUP, rules: RULES_VERSION }).setup.rules, RULES_VERSION);
    assert.equal("rules" in replayStart(SETUP).setup, false);
  });

  test("endsOn compares the end as JSON values, whatever the order of keys", () => {
    const r = record();
    const game = replayStart(r.setup);
    const seats = r.setup.cpuFlags.map((cpu) => ({ kind: cpu ? "ai" : "human", missedTurns: 0 }));
    for (const rec of r.actions) replayStep(game, seats, rec);
    assert.equal(endsOn(game, r.final), true);
    const reordered = Object.fromEntries(Object.entries(r.final).reverse());
    assert.equal(endsOn(game, reordered), true);
    const moved = structuredClone(r.final);
    moved.game.civs[0].gold += 1;
    assert.equal(endsOn(game, moved), false);
    const extra = structuredClone(r.final);
    extra.game.extra = null;
    assert.equal(endsOn(game, extra), false);
    assert.equal(endsOn(game, { ...r.final, game: [] }), false);
  });

  test("replayAll refuses other rules and reports an end elsewhere", () => {
    const r = record();
    assert.equal(replayAll(r).error, null);
    assert.equal(replayAll(r).states.length, 4);
    assert.deepEqual(replayAll({ ...r, setup: { ...r.setup, rules: RULES_VERSION + 1 } }),
      { states: [], labels: [], error: { error: "rules" } });
    const moved = structuredClone(r.final);
    moved.game.turn += 1;
    const res = replayAll({ ...r, final: moved });
    assert.deepEqual(res.error, { error: "mismatch" });
    assert.equal(res.states.length, 4, "the states are still there to look at");
    // Without a final snapshot to check against there is nothing to compare.
    assert.equal(replayAll({ setup: r.setup, actions: r.actions }).error, null);
  });
});
