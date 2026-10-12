"use strict";

// /api/leaderboard: every active account, ranked by wins over finished games
// and abandoned games two or more people played (a loss each) or in which the
// player's civ was eliminated (a loss, even solo), those yet to
// play at 0 / 0 below the rest; a seat the AI took over does not win for the
// person; deactivated accounts are left off.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, client, db } = require("../helpers/server");
const queries = require("../../src/db/queries");

const AI = { kind: "ai" };
const SOLO = [{ kind: "human" }, AI, AI, AI];

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

// A solo game the user played (made a move in), set to finished.
async function finishedGame(user, winnerSeat, moved = true) {
  const id = (await user.c.post("/api/games", { seats: SOLO })).body.id;
  if (moved) queries.insertAction.run(id, 1, 0, user.user.id, JSON.stringify({ type: "endTurn" }));
  db().prepare("UPDATE games SET status = 'finished', winner_seat = ?, finished_at = datetime('now') WHERE id = ?").run(winnerSeat, id);
  return id;
}

test("ranks by wins, counts games, ignores unfinished ones and AI-held seats", async () => {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const carol = await registerUser(srv.baseUrl, "carol");
  const dora = await registerUser(srv.baseUrl, "dora"); // never played
  await finishedGame(alice, 0);
  await finishedGame(alice, 0);
  await finishedGame(alice, 2);
  await finishedGame(bob, 0);
  await bob.c.post("/api/games", { seats: SOLO }); // active: not counted
  // Carol's seat was handed to the AI, which then won: not her win, but her game.
  const takenOver = await finishedGame(carol, 0);
  db().prepare("UPDATE game_seats SET kind = 'ai' WHERE game_id = ? AND seat = 0").run(takenOver);
  // A game Carol never moved in (the clock handed it to the AI): not hers.
  const neverMoved = await finishedGame(carol, 1, false);
  db().prepare("UPDATE game_seats SET kind = 'ai' WHERE game_id = ? AND seat = 0").run(neverMoved);

  const res = await alice.c.get("/api/leaderboard");
  assert.equal(res.status, 200);
  const rows = res.body.filter((r) => [alice, bob, carol, dora].some((u) => u.user.id === r.id));
  assert.deepEqual(rows.map((r) => [r.username, r.games, r.wins]), [
    [alice.user.username, 3, 2],
    [bob.user.username, 1, 1],
    [carol.user.username, 1, 0],
    [dora.user.username, 0, 0],
  ]);
  assert.equal((await client(srv.baseUrl).get("/api/leaderboard")).status, 401);

  queries.deactivateUser.run(bob.user.id);
  assert.equal((await alice.c.get("/api/leaderboard")).body.some((r) => r.id === bob.user.id), false);
});

test("an abandoned game two or more people played is a loss for each; a solo one or a cancelled table is not", async () => {
  const rooms = require("../../src/game/rooms");
  const dan = await registerUser(srv.baseUrl, "dan");
  const eve = await registerUser(srv.baseUrl, "eve");
  const record = async () => {
    const rows = (await dan.c.get("/api/leaderboard")).body;
    return [dan, eve].map((u) => { const r = rows.find((x) => x.id === u.user.id); return r ? [r.games, r.wins] : null; });
  };
  assert.deepEqual(await record(), [[0, 0], [0, 0]]);

  // Dan and Eve both walk out; with nobody left the game is abandoned.
  const duo = (await dan.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, AI, AI] })).body.id;
  assert.equal((await eve.c.post(`/api/games/${duo}/seats/1/join`)).status, 200);
  assert.equal((await dan.c.post(`/api/games/${duo}/start`)).status, 200);
  const room = rooms.getRoom(duo);
  assert.equal(rooms.applyPlayerAction(room, 0, dan.user.id, { type: "endTurn" }).ok, true);
  assert.equal(rooms.applyPlayerAction(room, 1, eve.user.id, { type: "endTurn" }).ok, true);
  assert.equal(rooms.leaveGame(rooms.getRoom(duo), eve.user.id).ok, true);
  assert.equal(rooms.leaveGame(rooms.getRoom(duo), dan.user.id).ok, true);
  assert.equal(queries.getGameById.get(duo).status, "aborted");
  assert.deepEqual(await record(), [[1, 0], [1, 0]]);

  // Dan alone against the AI, moving and walking out: not counted.
  const solo = (await dan.c.post("/api/games", { seats: SOLO })).body.id;
  assert.equal(rooms.applyPlayerAction(rooms.getRoom(solo), 0, dan.user.id, { type: "endTurn" }).ok, true);
  assert.equal(rooms.leaveGame(rooms.getRoom(solo), dan.user.id).ok, true);
  assert.equal(queries.getGameById.get(solo).status, "aborted");
  // A table of two cancelled before it started: not counted either.
  const table = (await dan.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, AI, AI] })).body.id;
  assert.equal((await eve.c.post(`/api/games/${table}/seats/1/join`)).status, 200);
  assert.equal((await dan.c.del(`/api/games/${table}`)).status, 200);
  assert.equal(queries.getGameById.get(table).status, "aborted");
  assert.deepEqual(await record(), [[1, 0], [1, 0]]);
});

test("someone who never moved has not played: no loss for them, and no game of two for the other", async () => {
  const rooms = require("../../src/game/rooms");
  const settings = require("../../src/shared/settings");
  const fay = await registerUser(srv.baseUrl, "fay");
  const gus = await registerUser(srv.baseUrl, "gus");
  const id = (await fay.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, AI, AI], turnTime: "1m" })).body.id;
  assert.equal((await gus.c.post(`/api/games/${id}/seats/1/join`)).status, 200);
  assert.equal((await fay.c.post(`/api/games/${id}/start`)).status, 200);
  const room = rooms.getRoom(id);
  // Fay plays; Gus never does, and the clock hands his seat to the AI.
  for (let i = 0; i < settings.MISSED_TURN_LIMIT; i++) {
    assert.equal(rooms.applyPlayerAction(room, 0, fay.user.id, { type: "endTurn" }).ok, true);
    assert.equal(rooms.expireTurn(room, room.deadline + 1), true);
  }
  assert.equal(room.seats[1].kind, "ai");
  // Then Fay walks out too: abandoned, but only one person ever played it.
  assert.equal(rooms.leaveGame(room, fay.user.id).ok, true);
  assert.equal(queries.getGameById.get(id).status, "aborted");
  const rows = (await fay.c.get("/api/leaderboard")).body;
  for (const u of [fay, gus]) assert.equal(rows.find((r) => r.id === u.user.id).games, 0, u.user.username);
});

test("a game abandoned because the player's civ was eliminated is a loss, even solo", async () => {
  const hal = await registerUser(srv.baseUrl, "hal");
  const abort = (id, eliminated) => db().prepare(`
    UPDATE games SET status = 'aborted', finished_at = datetime('now'),
      snapshot = json_set(snapshot, '$.game.civs[0].isEliminated', json(?)) WHERE id = ?
  `).run(eliminated ? "true" : "false", id);
  // Wiped out by the AI: the server aborts the game with no human civ left.
  const wipedOut = await finishedGame(hal, null);
  abort(wipedOut, true);
  // Walked out of alone, civ still standing: not counted.
  const walkedOut = await finishedGame(hal, null);
  abort(walkedOut, false);
  assert.ok(queries.getGameById.get(wipedOut).started_at, "the game had started");

  const row = (await hal.c.get("/api/leaderboard")).body.find((r) => r.id === hal.user.id);
  assert.deepEqual([row.games, row.wins], [1, 0]);
  const { record } = (await hal.c.get("/api/stats")).body;
  assert.deepEqual([record.played, record.wins, record.losses, record.abandoned], [1, 0, 1, 0]);
});
