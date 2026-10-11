"use strict";

// /api/leaderboard: active accounts ranked by wins over finished games; a seat
// the AI took over does not win for the person; deactivated accounts are left off.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, client, db } = require("../helpers/server");
const queries = require("../../src/db/queries");

const AI = { kind: "ai" };
const SOLO = [{ kind: "human" }, AI, AI, AI];

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

async function finishedGame(user, winnerSeat) {
  const id = (await user.c.post("/api/games", { seats: SOLO })).body.id;
  db().prepare("UPDATE games SET status = 'finished', winner_seat = ?, finished_at = datetime('now') WHERE id = ?").run(winnerSeat, id);
  return id;
}

test("ranks by wins, counts games, ignores unfinished ones and AI-held seats", async () => {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const carol = await registerUser(srv.baseUrl, "carol");
  await finishedGame(alice, 0);
  await finishedGame(alice, 0);
  await finishedGame(alice, 2);
  await finishedGame(bob, 0);
  await bob.c.post("/api/games", { seats: SOLO }); // active: not counted
  // Carol's seat was handed to the AI, which then won: not her win, but her game.
  const takenOver = await finishedGame(carol, 0);
  db().prepare("UPDATE game_seats SET kind = 'ai' WHERE game_id = ? AND seat = 0").run(takenOver);

  const res = await alice.c.get("/api/leaderboard");
  assert.equal(res.status, 200);
  const rows = res.body.filter((r) => [alice, bob, carol].some((u) => u.user.id === r.id));
  assert.deepEqual(rows.map((r) => [r.username, r.games, r.wins]), [
    [alice.user.username, 3, 2],
    [bob.user.username, 1, 1],
    [carol.user.username, 1, 0],
  ]);
  assert.equal((await client(srv.baseUrl).get("/api/leaderboard")).status, 401);

  queries.deactivateUser.run(bob.user.id);
  assert.equal((await alice.c.get("/api/leaderboard")).body.some((r) => r.id === bob.user.id), false);
});
