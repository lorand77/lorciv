"use strict";

// ============================================================
// replay.js — a game's states rebuilt from its seed and its action rows.
// The engine is deterministic and the server recorded every action, so
// playing the same actions over the same seed, in the same way the server
// did (src/game/rooms.js), gives the same states, snapshot for snapshot.
// Shared by the replay page, the server's achievements and its tests.
// ============================================================

// Node: the files this one reads as bare names, hoisted onto globalThis. In the
// browser they are globals already, from the earlier <script> tags.
if (typeof module !== "undefined" && module.exports) {
    Object.assign(globalThis, require("./state"), require("./game"), require("./ai"),
        require("./actions"), require("./settings"), require("./snapshot"));
}

// Whether today's engine may replay a game set up this way. A game recorded
// under other rules may not: its actions would play out differently and stop
// making sense, or worse, quietly make a different game. One from before
// rules versions existed (no `rules`) is tried, and only its end can tell
// (endsOn).
function rulesAllow(setup) {
    return setup.rules == null || setup.rules === RULES_VERSION;
}

// Whether a replayed game ended exactly on `final`, the snapshot the server
// stored when the game ended. Compared as JSON values, whatever the order of
// their keys.
function endsOn(game, final) {
    return sameJson(JSON.parse(JSON.stringify(serializeGame(game))), final);
}

function sameJson(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(k => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

// The game as it was handed to its first human: AI seats before the first
// human seat have already played (rooms.startGame does the same). An
// `observer` (Game.observer) sees the game from its first move.
function replayStart(setup, observer = null) {
    const game = new Game({ seed: setup.seed, cpuFlags: setup.cpuFlags, difficultyFlags: setup.difficultyFlags,
                            rules: setup.rules ?? null });
    game.observer = observer;
    runCpuTurns(game);
    return game;
}

// Apply one recorded action as the server did. `seats` is the mutable seat
// state of the replay: [{ kind, missedTurns }]. Returns { ok } or the
// validator's refusal, which means the record does not fit the rules.
function replayStep(game, seats, rec) {
    const seat = rec.seat;
    const a = rec.action;
    if (a.type === "timeout") {
        const res = applyAction(game, seat, { type: "endTurn" });
        if (!res.ok) return res;
        seats[seat].missedTurns++;
        if (seats[seat].missedTurns >= MISSED_TURN_LIMIT) {
            seats[seat].kind = "ai";
            game.civs[seat].isCpu = true;
        }
    } else if (a.type === "leave") {
        seats[seat].kind = "ai";
        game.civs[seat].isCpu = true;
    } else {
        game.civs[seat].pendingMessages = [];
        game.civs[seat].researchJustCompleted = false;
        const res = applyAction(game, seat, a);
        if (!res.ok) return res;
        seats[seat].missedTurns = 0;
    }
    // With nobody human left in the game (seats handed to the AI, civs
    // eliminated) the server abandoned it instead of letting the AI play on.
    if (seats.some((s, i) => s.kind === "human" && !game.civs[i].isEliminated)) {
        runCpuTurns(game);
        game.checkVictory();
    }
    return { ok: true };
}

// A short line for a step: who did what.
function describeStep(rec, civName) {
    const a = rec.action;
    const what = {
        move: "moves", attack: "attacks", foundCity: "founds a city", buildImprovement: `starts a ${a.key}`,
        fortify: "fortifies", heal: "rests", skip: "skips a unit", upgrade: "upgrades a unit",
        setProduction: `builds ${a.key}`, buy: `buys ${a.key}`, setResearch: `researches ${a.key}`,
        endTurn: "ends the turn", timeout: "runs out of time", leave: "leaves the game",
    }[a.type] ?? a.type;
    return `${civName} ${what}`;
}

// Every state of a game, as snapshots: states[0] is the start, states[i] the
// state after action i. `record` is what GET /api/games/:id/replay returns.
// Stops at the first action the rules refuse and reports it in `error`; a
// record of other rules gives no states and `error: "rules"`, and one that
// ends anywhere but on `record.final` (when given) `error: "mismatch"`.
function replayAll(record) {
    if (!rulesAllow(record.setup)) return { states: [], labels: [], error: { error: "rules" } };
    const game = replayStart(record.setup);
    const seats = record.setup.cpuFlags.map(cpu => ({ kind: cpu ? "ai" : "human", missedTurns: 0 }));
    const states = [serializeGame(game)];
    const labels = ["Start"];
    let error = null;
    for (const rec of record.actions) {
        const res = replayStep(game, seats, rec);
        if (!res.ok) { error = { seq: rec.seq, ...res }; break; }
        states.push(serializeGame(game));
        labels.push(describeStep(rec, PLAYER_NAMES[rec.seat]));
    }
    if (!error && record.final && !endsOn(game, record.final)) error = { error: "mismatch" };
    return { states, labels, error };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { rulesAllow, endsOn, replayStart, replayStep, describeStep, replayAll };
}
