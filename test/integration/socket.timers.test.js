"use strict";

// Turn timers: a human turn that runs out is ended by the server and counted
// as missed; at the limit the seat is handed to the AI; a deadline survives a
// restart; abandoned tables and games are swept. The sweeps are called
// directly, and once left to the interval, set short for this file.

process.env.DEADLINE_SWEEP_MS = "50";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, db } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { deserializeGame } = require("../../src/shared/snapshot");
const settings = require("../../src/shared/settings");
const rooms = require("../../src/game/rooms");
const queries = require("../../src/db/queries");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

async function timedGame(t, turnTime = "1m", seats = [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }], base = "timed") {
  const player = await registerUser(srv.baseUrl, base);
  const id = (await player.c.post("/api/games", { seats, turnTime, seed: 8 })).body.id;
  const socket = await connectSocket(srv.baseUrl, player.c.cookie());
  t.after(() => socket.close());
  const state = (await emitAck(socket, "game:join", { gameId: id })).state;
  return { player, id, socket, state, room: rooms.getRoom(id) };
}

test("a human turn gets a deadline from the table's turn time; 'none' gets none", async (t) => {
  const { state, room, id } = await timedGame(t, "1m");
  assert.ok(Number.isFinite(state.deadline));
  assert.ok(state.deadline - Date.now() > 55000 && state.deadline - Date.now() <= 60000);
  assert.equal(Date.parse(queries.getGameById.get(id).turn_deadline), room.deadline);

  const none = await timedGame(t, "none", undefined, "untimed");
  assert.equal(none.state.deadline, null);
  assert.equal(none.room.deadline, null);
  assert.equal(rooms.expireTurn(none.room, Date.now() + 1e9), false, "nothing to expire without a clock");
});

test("an expired turn is ended by the server and counted; acting resets the count", async (t) => {
  const { id, socket, state, room } = await timedGame(t);
  const logs = captureLogs();
  t.after(() => logs.restore());
  const next = waitFor(socket, "game:state");
  assert.equal(rooms.expireTurn(room, room.deadline + 1), true);
  const s1 = await next;
  assert.equal(s1.seq, 1);
  assert.equal(deserializeGame(s1.snapshot).turn, 2, "the turn ended and the AI seats played");
  assert.equal(s1.seats[0].missedTurns, 1);
  assert.equal(s1.seats[0].kind, "human");
  assert.ok(s1.deadline > state.deadline, "a fresh clock for the new turn");
  const action = queries.listActions.all(id)[0];
  assert.deepEqual(JSON.parse(action.action), { type: "timeout" });
  assert.equal(action.user_id, null, "the server acted, not the player");
  assert.ok(logs.find("game.timeout", { game: id, seat: 0, missed: 1 }));
  assert.equal(queries.getSeats.all(id)[0].missed_turns, 1);

  const next2 = waitFor(socket, "game:state");
  assert.equal((await emitAck(socket, "game:action", { gameId: id, seq: s1.seq, type: "endTurn" })).ok, true);
  const s2 = await next2;
  assert.equal(s2.seats[0].missedTurns, 0, "acting forgives the missed turns");
  assert.equal(queries.getSeats.all(id)[0].missed_turns, 0);
});

test("at the missed-turn limit the seat goes to the AI; the only human gone, the game is abandoned", async (t) => {
  const { id, socket, room } = await timedGame(t, "1m", undefined, "sleeper");
  const logs = captureLogs();
  t.after(() => logs.restore());
  let last;
  for (let i = 1; i <= settings.MISSED_TURN_LIMIT; i++) {
    const next = waitFor(socket, "game:state");
    assert.equal(rooms.expireTurn(room, room.deadline + 1), true, `expiry ${i}`);
    last = await next;
  }
  assert.equal(last.seats[0].kind, "ai");
  assert.equal(last.seats[0].missedTurns, settings.MISSED_TURN_LIMIT);
  assert.equal(last.mySeat, null);
  assert.equal(last.formerSeat, 0);
  assert.equal(last.status, "aborted", "no human seat is left");
  assert.equal(last.deadline, null);
  assert.equal(deserializeGame(last.snapshot).civs[0].isCpu, true);
  assert.ok(logs.find("game.takeover", { game: id, seat: 0, reason: "timeout" }));
  assert.ok(logs.find("game.abort", { game: id, reason: "no_humans" }));
  assert.equal(queries.getGameById.get(id).status, "aborted");
  assert.equal(queries.getSeats.all(id)[0].kind, "ai");
});

test("with another human left, the game goes on after a takeover", async (t) => {
  const alice = await registerUser(srv.baseUrl, "stayer");
  const bob = await registerUser(srv.baseUrl, "dozer");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, { kind: "ai" }, { kind: "ai" }], turnTime: "1m", seed: 8 })).body.id;
  await bob.c.post(`/api/games/${id}/seats/1/join`);
  await alice.c.post(`/api/games/${id}/start`);
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  t.after(() => a.close());
  const sa = (await emitAck(a, "game:join", { gameId: id })).state;
  // Alice plays; bob never does.
  let seen = waitFor(a, "game:state");
  await emitAck(a, "game:action", { gameId: id, seq: sa.seq, type: "endTurn" });
  let s = await seen;
  const room = rooms.getRoom(id);
  for (let i = 0; i < settings.MISSED_TURN_LIMIT; i++) {
    assert.equal(deserializeGame(s.snapshot).currentPlayer, 1, "bob's turn, which he lets expire");
    seen = waitFor(a, "game:state");
    assert.equal(rooms.expireTurn(room, room.deadline + 1), true);
    s = await seen; // bob's turn ended, the AIs played, alice is up
    if (i < settings.MISSED_TURN_LIMIT - 1) {
      seen = waitFor(a, "game:state");
      await emitAck(a, "game:action", { gameId: id, seq: s.seq, type: "endTurn" });
      s = await seen;
    }
  }
  assert.equal(s.seats[1].kind, "ai");
  assert.equal(s.status, "active", "alice is still playing");
  assert.equal(deserializeGame(s.snapshot).currentPlayer, 0);
});

test("the sweep runs on its own", async (t) => {
  const { socket, room } = await timedGame(t, "1m", undefined, "ticker");
  const next = waitFor(socket, "game:state", 2000);
  room.deadline = Date.now() - 1;
  assert.equal((await next).seats[0].missedTurns, 1);
});

test("a deadline survives a restart, and one that passed meanwhile fires at boot", async (t) => {
  const { id, player, room } = await timedGame(t, "1h", undefined, "patient");
  const deadline = room.deadline;
  await srv.close();
  srv = await startServer();
  const back = rooms.getRoom(id);
  assert.equal(back.deadline, deadline, "the clock did not reset");

  db().prepare("UPDATE games SET turn_deadline = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  await srv.close();
  srv = await startServer();
  const s = await connectSocket(srv.baseUrl, player.c.cookie());
  t.after(() => s.close());
  const expired = waitFor(s, "game:state", 2000);
  await emitAck(s, "game:join", { gameId: id });
  const state = await expired;
  assert.equal(state.seats[0].missedTurns, 1, "the overdue turn was ended once the server was back");
});

test("abandoned tables and games are swept; fresh ones are left alone", async (t) => {
  const alice = await registerUser(srv.baseUrl, "leaver");
  const table = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  const game = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  const fresh = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  db().prepare("UPDATE games SET updated_at = datetime('now', '-40 days') WHERE id IN (?, ?)").run(table, game);
  const logs = captureLogs();
  t.after(() => logs.restore());
  assert.equal(rooms.sweepAbandoned(), 2);
  assert.equal(queries.getGameById.get(table).status, "aborted");
  assert.equal(queries.getGameById.get(game).status, "aborted");
  assert.equal(queries.getGameById.get(fresh).status, "active");
  assert.equal(rooms.listRooms().some((r) => r.gameId === game), false, "its room is gone");
  assert.ok(logs.find("game.abandon_sweep", { aborted: 2 }));
  assert.equal(rooms.sweepAbandoned(), 0);
  void expectNo;
});

test("acting within a turn leaves the clock alone; only a new turn restarts it", async (t) => {
  const { id, socket, state, room } = await timedGame(t, "1m", undefined, "staller");
  const worker = deserializeGame(state.snapshot).civs[0].units.find((u) => u.unitType === "worker");
  // Most of the turn has gone by.
  room.deadline = Date.now() + 5000;
  const deadline = room.deadline;
  let next = waitFor(socket, "game:state");
  assert.equal((await emitAck(socket, "game:action", { gameId: id, seq: state.seq, type: "skip", unitId: worker.id })).ok, true);
  const s1 = await next;
  assert.equal(s1.deadline, deadline, "a move does not buy more time");
  assert.equal(Date.parse(queries.getGameById.get(id).turn_deadline), deadline);

  next = waitFor(socket, "game:state");
  assert.equal((await emitAck(socket, "game:action", { gameId: id, seq: s1.seq, type: "endTurn" })).ok, true);
  const s2 = await next;
  assert.ok(s2.deadline - Date.now() > 55000, "the next turn gets a full clock");
});
