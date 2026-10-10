"use strict";

// Playing over the socket: join, act, the AI seats after an end of turn,
// persistence, resume after a restart, spectators, stale views, the end of a
// game and a failed write. See "The game on the server" in docs/design.md.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, db,
} = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { deserializeGame } = require("../../src/shared/snapshot");
const { getReachableTiles } = require("../../src/shared/state");
const queries = require("../../src/db/queries");
const rooms = require("../../src/game/rooms");

const AI = { kind: "ai" };
const SEATS = [{ kind: "human" }, AI, AI, AI];

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

async function newGame(t, base = "alice", seed = 11) {
  const player = await registerUser(srv.baseUrl, base);
  const gameId = (await player.c.post("/api/games", { seats: SEATS, seed })).body.id;
  const socket = await connectSocket(srv.baseUrl, player.c.cookie());
  t.after(() => socket.close());
  const joined = await emitAck(socket, "game:join", { gameId });
  assert.equal(joined.ok, true);
  return { player, gameId, socket, state: joined.state };
}

const unitOf = (state, seat, type) =>
  deserializeGame(state.snapshot).civs[seat].units.find((u) => u.unitType === type);

function act(socket, gameId, state, action) {
  return emitAck(socket, "game:action", { gameId, seq: state.seq, ...action });
}

test("joining gives the full state: seat, seats, sequence number and snapshot", async (t) => {
  const { gameId, state, player } = await newGame(t);
  assert.equal(state.gameId, gameId);
  assert.equal(state.seq, 0);
  assert.equal(state.status, "active");
  assert.equal(state.winner, null);
  assert.equal(state.mySeat, 0);
  assert.deepEqual(state.settings, { turnTime: "3m" });
  assert.equal(state.seats.length, 4);
  assert.equal(state.seats[0].username, player.user.username);
  assert.equal(state.seats[0].civ, "Rome");
  assert.equal(state.seats[1].kind, "ai");
  assert.equal(state.snapshot.version, 2);
  const game = deserializeGame(state.snapshot);
  assert.equal(game.turn, 1);
  assert.equal(game.civs[0].isCpu, false);
  assert.equal(game.civs[1].isCpu, true);
});

test("an unknown game cannot be joined or acted on", async (t) => {
  const { socket } = await newGame(t);
  assert.deepEqual(await emitAck(socket, "game:join", { gameId: 999999 }), { ok: false, error: "no_such_game" });
  assert.deepEqual(await emitAck(socket, "game:join", {}), { ok: false, error: "no_such_game" });
  assert.equal((await emitAck(socket, "game:action", { gameId: 999999, seq: 0, type: "endTurn" })).error, "no_such_game");
});

test("a legal action is applied, persisted and broadcast; an illegal one is refused and nothing moves", async (t) => {
  const { gameId, socket, state } = await newGame(t);
  const settler = unitOf(state, 0, "settler");
  const game = deserializeGame(state.snapshot);
  const [key, cost] = [...getReachableTiles(settler, game.tiles, game.turn).entries()][0];
  const [q, r] = key.split(",").map(Number);

  const next = waitFor(socket, "game:state");
  const res = await act(socket, gameId, state, { type: "move", unitId: settler.id, q, r });
  assert.deepEqual(res, { ok: true, message: "" });
  const s1 = await next;
  assert.equal(s1.seq, 1);
  assert.equal(s1.mySeat, 0);
  const moved = deserializeGame(s1.snapshot).unitById(settler.id);
  assert.deepEqual([moved.q, moved.r], [q, r]);
  assert.equal(moved.movesLeft, settler.movesLeft - cost);

  const row = queries.getGameById.get(gameId);
  assert.equal(row.seq, 1);
  assert.deepEqual(JSON.parse(row.snapshot), s1.snapshot, "the database holds what was broadcast");
  const actions = queries.listActions.all(gameId);
  assert.equal(actions.length, 1);
  assert.deepEqual(JSON.parse(actions[0].action), { type: "move", unitId: settler.id, q, r });
  assert.equal(actions[0].seat, 0);

  const quiet = expectNo(socket, "game:state");
  const bad = await act(socket, gameId, s1, { type: "move", unitId: settler.id, q: q + 20, r });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "illegal");
  assert.equal(bad.message, "Cannot move there.");
  assert.equal(await quiet, true);
  assert.equal(queries.getGameById.get(gameId).seq, 1);
  // Only the fields an action can carry are stored.
  const sneaky = await act(socket, gameId, s1, { type: "skip", unitId: unitOf(s1, 0, "worker").id, evil: "x" });
  assert.equal(sneaky.ok, true);
  assert.equal("evil" in JSON.parse(queries.listActions.all(gameId)[1].action), false);
});

test("a stale sequence number is refused and answered with the current state", async (t) => {
  const { gameId, socket, state } = await newGame(t);
  const worker = unitOf(state, 0, "worker");
  await act(socket, gameId, state, { type: "skip", unitId: worker.id });
  const resync = waitFor(socket, "game:state");
  const res = await act(socket, gameId, state, { type: "skip", unitId: worker.id }); // seq 0 again
  assert.deepEqual(res, { ok: false, error: "stale", seq: 1 });
  assert.equal((await resync).seq, 1);
});

test("ending the turn runs the AI seats at once and brings the turn back", async (t) => {
  const { gameId, socket, state } = await newGame(t);
  const next = waitFor(socket, "game:state");
  assert.deepEqual(await act(socket, gameId, state, { type: "endTurn" }), { ok: true, message: "" });
  const s1 = await next;
  const game = deserializeGame(s1.snapshot);
  assert.equal(game.currentPlayer, 0, "the three AI seats have played");
  assert.equal(game.turn, 2);
  assert.equal(game.scoreHistory.length, 1);
  assert.ok(game.civs[1].cities.length >= 1, "the AI founded its capital");
  const row = queries.getGameById.get(gameId);
  assert.equal(row.turn, 2);
  assert.equal(row.current_seat, 0);
  assert.equal(row.seq, 1);
});

test("someone without a seat watches: full state, every broadcast, no actions", async (t) => {
  const { gameId, socket, state } = await newGame(t);
  const bob = await registerUser(srv.baseUrl, "bob");
  const watcher = await connectSocket(srv.baseUrl, bob.c.cookie());
  t.after(() => watcher.close());
  const joined = await emitAck(watcher, "game:join", { gameId });
  assert.equal(joined.ok, true);
  assert.equal(joined.state.mySeat, null);
  assert.equal(joined.state.seq, 0);
  assert.deepEqual(await emitAck(watcher, "game:action", { gameId, seq: 0, type: "endTurn" }), { ok: false, error: "not_seated" });

  const seen = waitFor(watcher, "game:state");
  await act(socket, gameId, state, { type: "endTurn" });
  const s1 = await seen;
  assert.equal(s1.seq, 1);
  assert.equal(s1.mySeat, null, "the watcher's own view");
});

test("a game survives a server restart: the first join rebuilds the room from the database", async (t) => {
  const { gameId, socket, state, player } = await newGame(t, "restart");
  const next = waitFor(socket, "game:state");
  await act(socket, gameId, state, { type: "endTurn" });
  const before = await next;
  socket.close();

  await srv.close();
  srv = await startServer();
  const logs = captureLogs();
  t.after(() => logs.restore());
  const again = await connectSocket(srv.baseUrl, player.c.cookie());
  t.after(() => again.close());
  const joined = await emitAck(again, "game:join", { gameId });
  assert.equal(joined.ok, true);
  assert.equal(joined.state.seq, before.seq);
  assert.deepEqual(joined.state.snapshot, before.snapshot);
  assert.ok(logs.find("game.resume", { game: gameId }));
  // And play goes on from there.
  const s2 = waitFor(again, "game:state");
  assert.equal((await act(again, gameId, joined.state, { type: "endTurn" })).ok, true);
  assert.equal((await s2).seq, before.seq + 1);
});

test("victory ends the game: status, winner, and no more actions", async (t) => {
  const { gameId, socket, state } = await newGame(t, "winner");
  const settler = unitOf(state, 0, "settler");
  let next = waitFor(socket, "game:state");
  assert.equal((await act(socket, gameId, state, { type: "foundCity", unitId: settler.id })).ok, true);
  const s1 = await next;
  next = waitFor(socket, "game:state");
  await act(socket, gameId, s1, { type: "endTurn" });
  const s2 = await next;

  // Hand every original capital to seat 0, as a conquest would, then act.
  const room = rooms.getRoom(gameId);
  const capital = room.game.civs[0].cities[0];
  for (const civ of room.game.civs) civ.originalCapital = capital;
  const logs = captureLogs();
  t.after(() => logs.restore());
  next = waitFor(socket, "game:state");
  const res = await act(socket, gameId, s2, { type: "skip", unitId: unitOf(s2, 0, "worker").id });
  assert.equal(res.ok, true);
  const s3 = await next;
  assert.equal(s3.status, "finished");
  assert.equal(s3.winner, 0);
  assert.equal(deserializeGame(s3.snapshot).winner, 0);
  const row = queries.getGameById.get(gameId);
  assert.equal(row.status, "finished");
  assert.equal(row.winner_seat, 0);
  assert.ok(row.finished_at);
  assert.ok(logs.find("game.over", { game: gameId, winner: 0 }));
  assert.equal((await act(socket, gameId, s3, { type: "endTurn" })).error, "game_over");
});

test("a failed write rolls the room back and tells the player", async (t) => {
  const { gameId, socket, state } = await newGame(t, "unlucky");
  t.mock.method(queries.insertAction, "run", () => { throw new Error("disk full"); });
  const logs = captureLogs();
  t.after(() => logs.restore());
  const quiet = expectNo(socket, "game:state");
  const res = await act(socket, gameId, state, { type: "endTurn" });
  assert.deepEqual(res, { ok: false, error: "server_error", message: "Could not save the game." });
  assert.equal(await quiet, true);
  assert.equal(logs.find("game.persist_failed", { game: gameId }).fields.err, "Error: disk full");
  const again = await emitAck(socket, "game:join", { gameId });
  assert.equal(again.state.seq, 0);
  assert.deepEqual(again.state.snapshot, state.snapshot, "nothing changed");
  assert.equal(queries.getGameById.get(gameId).seq, 0);
});
