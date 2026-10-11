"use strict";

// Two people in one game: turns alternate with the AI seats between them,
// each sees their own seat, a player who leaves is replaced by the AI, and a
// game with nobody left is abandoned. Rooms come back at boot.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { deserializeGame } = require("../../src/shared/snapshot");
const rooms = require("../../src/game/rooms");
const queries = require("../../src/db/queries");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

// alice hosts [human, open, ai, ai], bob takes seat 1, alice starts; both join.
async function twoPlayerGame(t, seed = 21) {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, { kind: "ai" }, { kind: "ai" }], seed })).body.id;
  assert.equal((await bob.c.post(`/api/games/${id}/seats/1/join`)).status, 200);
  assert.equal((await alice.c.post(`/api/games/${id}/start`)).status, 200);
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  t.after(() => { a.close(); b.close(); });
  const sa = (await emitAck(a, "game:join", { gameId: id })).state;
  const sb = (await emitAck(b, "game:join", { gameId: id })).state;
  return { alice, bob, id, a, b, sa, sb };
}

test("turns alternate: human, human, then the AI seats, then round two", async (t) => {
  const { id, a, b, sa, sb } = await twoPlayerGame(t);
  assert.equal(sa.mySeat, 0);
  assert.equal(sb.mySeat, 1);
  assert.equal(deserializeGame(sa.snapshot).currentPlayer, 0);

  assert.equal((await emitAck(b, "game:action", { gameId: id, seq: sb.seq, type: "endTurn" })).error, "not_your_turn");

  let aSees = waitFor(a, "game:state");
  let bSees = waitFor(b, "game:state");
  let bobsTurn = waitFor(b, "turn:yours");
  assert.equal((await emitAck(a, "game:action", { gameId: id, seq: sa.seq, type: "endTurn" })).ok, true);
  const [s1a, s1b, yours] = await Promise.all([aSees, bSees, bobsTurn]);
  assert.equal(yours.gameId, id);
  assert.equal(deserializeGame(s1b.snapshot).currentPlayer, 1, "bob is up; the AI seats wait their turn");
  assert.equal(deserializeGame(s1b.snapshot).turn, 1);
  assert.equal(s1a.mySeat, 0);
  assert.equal(s1b.mySeat, 1);

  assert.equal((await emitAck(a, "game:action", { gameId: id, seq: s1a.seq, type: "endTurn" })).error, "not_your_turn");
  aSees = waitFor(a, "game:state");
  const alicesTurn = waitFor(a, "turn:yours");
  assert.equal((await emitAck(b, "game:action", { gameId: id, seq: s1b.seq, type: "endTurn" })).ok, true);
  const s2 = await aSees;
  await alicesTurn;
  const g2 = deserializeGame(s2.snapshot);
  assert.equal(g2.currentPlayer, 0, "the two AI seats played and the round is over");
  assert.equal(g2.turn, 2);
  assert.ok(g2.civs[2].cities.length >= 1, "an AI founded its capital");
});

test("AI seats before the first human play before the game is handed over", async (t) => {
  const alice = await registerUser(srv.baseUrl, "second");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "ai" }, { kind: "human" }, { kind: "ai" }, { kind: "ai" }], seed: 3 })).body.id;
  const s = await connectSocket(srv.baseUrl, alice.c.cookie());
  t.after(() => s.close());
  const state = (await emitAck(s, "game:join", { gameId: id })).state;
  assert.equal(state.mySeat, 1);
  const game = deserializeGame(state.snapshot);
  assert.equal(game.currentPlayer, 1, "seat 0's AI has already moved");
  assert.ok(game.civs[0].cities.length >= 1);
  assert.equal(queries.getGameById.get(id).current_seat, 1);
});

test("a player who leaves is replaced by the AI; the last one leaving ends the game", async (t) => {
  const { id, a, b, sa } = await twoPlayerGame(t, 33);
  const logs = captureLogs();
  t.after(() => logs.restore());

  // Alice ends her turn; bob is up. Then bob leaves mid-turn: the AI plays his
  // seat at once and the round completes back to alice.
  let aSees = waitFor(a, "game:state");
  let bSees = waitFor(b, "game:state");
  await emitAck(a, "game:action", { gameId: id, seq: sa.seq, type: "endTurn" });
  await Promise.all([aSees, bSees]);
  aSees = waitFor(a, "game:state");
  bSees = waitFor(b, "game:state");
  assert.deepEqual(await emitAck(b, "game:leave", { gameId: id }), { ok: true });
  const [s2a, s2b] = await Promise.all([aSees, bSees]);
  assert.equal(s2a.seats[1].kind, "ai");
  assert.ok(s2a.seats[1].username, "the name stays on the seat");
  assert.equal(s2b.mySeat, null);
  assert.equal(s2b.formerSeat, 1);
  const g2 = deserializeGame(s2a.snapshot);
  assert.equal(g2.civs[1].isCpu, true);
  assert.equal(g2.currentPlayer, 0, "bob's seat, now AI, played on and the round came back to alice");
  assert.equal(g2.turn, 2);
  assert.ok(logs.find("game.takeover", { game: id, seat: 1, reason: "leave" }));
  assert.equal(queries.getSeats.all(id)[1].kind, "ai");
  assert.equal((await emitAck(b, "game:action", { gameId: id, seq: s2b.seq, type: "endTurn" })).error, "not_seated");
  assert.equal((await emitAck(b, "game:leave", { gameId: id })).error, "not_seated");

  // Alice leaves too: nobody is left, the game is abandoned.
  aSees = waitFor(a, "game:state");
  assert.deepEqual(await emitAck(a, "game:leave", { gameId: id }), { ok: true });
  const s3 = await aSees;
  assert.equal(s3.status, "aborted");
  assert.equal(queries.getGameById.get(id).status, "aborted");
  assert.ok(queries.getGameById.get(id).finished_at);
  assert.ok(logs.find("game.abort", { game: id, reason: "no_humans" }));
  assert.equal((await emitAck(a, "game:action", { gameId: id, seq: s3.seq, type: "endTurn" })).error, "not_seated");
});

test("active games are rebuilt at boot, before anyone joins", async (t) => {
  const { id } = await twoPlayerGame(t, 44);
  await srv.close();
  assert.equal(rooms.listRooms().length, 0, "a fresh process has no rooms");
  const logs = captureLogs();
  t.after(() => logs.restore());
  srv = await startServer();
  assert.ok(rooms.listRooms().some((r) => r.gameId === id), "resumed without a join");
  assert.ok(logs.find("game.resume", { game: id }));
  assert.ok(Number(logs.find("process.resumed").fields.games) >= 1);
});
