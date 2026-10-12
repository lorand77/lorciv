"use strict";

// Replays: a game rebuilt from its seed and its recorded actions reaches the
// very snapshots the server stored, through player actions, AI rounds, a
// timeout, a takeover, a leave and a seat lost to the missed-turn limit.
// GET /api/games/:id/replay hands the page what it needs.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor } = require("../helpers/server");
const { deserializeGame } = require("../../src/shared/snapshot");
const { getReachableTiles } = require("../../src/shared/state");
const { replayAll } = require("../../src/shared/replay");
const { RULES_VERSION } = require("../../src/shared/game");
const { MISSED_TURN_LIMIT } = require("../../src/shared/settings");
const rooms = require("../../src/game/rooms");
const queries = require("../../src/db/queries");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const act = (socket, gameId, state, action) => emitAck(socket, "game:action", { gameId, seq: state.seq, ...action });

test("replaying the recorded actions reproduces the stored game, step by step", async (t) => {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "ai" }, { kind: "human" }, { kind: "open" }, { kind: "ai" }], seed: 77, turnTime: "1m" })).body.id;
  await bob.c.post(`/api/games/${id}/seats/2/join`);
  await alice.c.post(`/api/games/${id}/start`);
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  t.after(() => { a.close(); b.close(); });
  let sa = (await emitAck(a, "game:join", { gameId: id })).state;
  await emitAck(b, "game:join", { gameId: id });
  // What the server stored after each step, in full: the snapshots players
  // get leave out the random-number state and the AI's memory.
  const stored = () => JSON.parse(rooms.getRoom(id).lastSnapshot);
  const snapshots = [stored()];

  // Alice: move the settler, found a city, pick research, end the turn.
  const game = deserializeGame(sa.snapshot);
  const settler = game.civs[1].units.find((u) => u.unitType === "settler");
  const [key] = [...getReachableTiles(settler, game.tiles, game.turn).keys()];
  const [q, r] = key.split(",").map(Number);
  for (const action of [
    { type: "move", unitId: settler.id, q, r },
    { type: "foundCity", unitId: settler.id },
    { type: "setResearch", key: "mining" },
    { type: "endTurn" },
  ]) {
    const next = waitFor(a, "game:state");
    assert.equal((await act(a, id, sa, action)).ok, true, action.type);
    sa = await next;
    snapshots.push(stored());
  }
  // Bob's turn runs out, twice; then he leaves, so the AI takes seat 2.
  const room = rooms.getRoom(id);
  for (let i = 0; i < 2; i++) {
    const next = waitFor(a, "game:state");
    assert.equal(rooms.expireTurn(room, room.deadline + 1), true);
    sa = await next;
    snapshots.push(stored());
    const mine = waitFor(a, "game:state");
    assert.equal((await act(a, id, sa, { type: "endTurn" })).ok, true);
    sa = await mine;
    snapshots.push(stored());
  }
  const left = waitFor(a, "game:state");
  assert.deepEqual(await emitAck(b, "game:leave", { gameId: id }), { ok: true });
  sa = await left;
  snapshots.push(stored());
  assert.equal(sa.seats[2].kind, "ai");

  // Still being played: no replay, for players or anyone else.
  const early = await alice.c.get(`/api/games/${id}/replay`);
  assert.equal(early.status, 403);
  assert.equal(early.body.error, "The replay opens when the game is over.");
  // Alice leaves too; with nobody human left the game is over (aborted).
  const over = waitFor(a, "game:state");
  assert.deepEqual(await emitAck(a, "game:leave", { gameId: id }), { ok: true });
  sa = await over;
  snapshots.push(stored());
  assert.equal(sa.status, "aborted");

  const record = (await alice.c.get(`/api/games/${id}/replay`)).body;
  assert.deepEqual(record.setup, snapshots[0].setup);
  assert.deepEqual(record.setup.cpuFlags, [true, false, false, true]);
  assert.equal(record.setup.rules, RULES_VERSION, "the game records the rules it was played under");
  assert.deepEqual(record.final, snapshots.at(-1), "and the page gets the stored end to check against");
  assert.equal(record.actions.length, snapshots.length - 1);
  assert.deepEqual(record.actions.map((x) => x.action.type),
    ["move", "foundCity", "setResearch", "endTurn", "timeout", "endTurn", "timeout", "endTurn", "leave", "leave"]);
  assert.equal(record.actions[4].seat, 2);

  const replay = replayAll(record);
  assert.equal(replay.error, null);
  assert.equal(replay.states.length, snapshots.length);
  for (let i = 0; i < snapshots.length; i++) {
    assert.deepEqual(replay.states[i], snapshots[i], `state after ${i} action(s)`);
  }
  assert.equal(replay.labels[0], "Start");
  assert.equal(replay.labels[2], "Greece founds a city");
  assert.equal(replay.labels[5], "The Huns runs out of time");
  assert.equal(replay.labels[9], "The Huns leaves the game");
  assert.equal(replay.labels[10], "Greece leaves the game");
});

test("a seat that runs out of time at the limit goes to the AI in the replay too", async (t) => {
  const alice = await registerUser(srv.baseUrl, "carol");
  const bob = await registerUser(srv.baseUrl, "dave");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, { kind: "ai" }, { kind: "ai" }], seed: 8, turnTime: "1m" })).body.id;
  await bob.c.post(`/api/games/${id}/seats/1/join`);
  await alice.c.post(`/api/games/${id}/start`);
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  t.after(() => a.close());
  let sa = (await emitAck(a, "game:join", { gameId: id })).state;
  const stored = () => JSON.parse(rooms.getRoom(id).lastSnapshot);
  const snapshots = [stored()];
  const room = rooms.getRoom(id);

  // Alice ends her turns; bob lets every one of his run out, up to the limit.
  for (let i = 0; i < MISSED_TURN_LIMIT; i++) {
    let next = waitFor(a, "game:state");
    assert.equal((await act(a, id, sa, { type: "endTurn" })).ok, true);
    sa = await next;
    snapshots.push(stored());
    next = waitFor(a, "game:state");
    assert.equal(rooms.expireTurn(room, room.deadline + 1), true);
    sa = await next;
    snapshots.push(stored());
  }
  assert.equal(sa.seats[1].kind, "ai");
  // The AI plays bob's seat from here: alice's next turn comes straight back.
  let next = waitFor(a, "game:state");
  assert.equal((await act(a, id, sa, { type: "endTurn" })).ok, true);
  sa = await next;
  snapshots.push(stored());
  next = waitFor(a, "game:state");
  assert.deepEqual(await emitAck(a, "game:leave", { gameId: id }), { ok: true });
  sa = await next;
  snapshots.push(stored());
  assert.equal(sa.status, "aborted");

  const record = (await alice.c.get(`/api/games/${id}/replay`)).body;
  assert.deepEqual(record.actions.map((x) => x.action.type),
    [...Array(MISSED_TURN_LIMIT)].flatMap(() => ["endTurn", "timeout"]).concat("endTurn", "leave"));
  const replay = replayAll(record);
  assert.equal(replay.error, null);
  assert.equal(replay.states.length, snapshots.length);
  for (let i = 0; i < snapshots.length; i++) {
    assert.deepEqual(replay.states[i], snapshots[i], `state after ${i} action(s)`);
  }
  // Bob's civ is the AI's from the last timeout on, not a moment before.
  assert.equal(replay.states[2 * MISSED_TURN_LIMIT - 1].game.civs[1].isCpu, false);
  assert.equal(replay.states[2 * MISSED_TURN_LIMIT].game.civs[1].isCpu, true);
});

test("the replay endpoint: 404 for unknown games and tables; a record that breaks the rules is reported", async () => {
  const alice = await registerUser(srv.baseUrl, "curious");
  assert.equal((await alice.c.get("/api/games/999999/replay")).status, 404);
  const table = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  assert.equal((await alice.c.get(`/api/games/${table}/replay`)).status, 404, "nothing to replay yet");

  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }], seed: 1 })).body.id;
  assert.equal((await alice.c.get(`/api/games/${id}/replay`)).status, 403, "not while it is played");
  rooms.leaveGame(rooms.getRoom(id), alice.user.id);
  const record = (await alice.c.get(`/api/games/${id}/replay`)).body;
  record.actions = [{ seq: 1, seat: 0, action: { type: "move", unitId: 9999, q: 0, r: 0 } }];
  const replay = replayAll(record);
  assert.equal(replay.states.length, 1);
  assert.deepEqual(replay.error, { seq: 1, ok: false, error: "no_such_unit", message: "" });
  void queries;
});
