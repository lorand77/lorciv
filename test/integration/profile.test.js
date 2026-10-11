"use strict";

// What a profile shows: /api/stats (the record over the games the leaderboard
// counts, by civ and by company, plus games in progress) and someone else's
// games list on /api/games/user/:id. Anyone signed in may look; a deactivated
// account is a 404 like an unknown one.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, client, db } = require("../helpers/server");
const queries = require("../../src/db/queries");

const AI = { kind: "ai" };
const SOLO = [{ kind: "human" }, AI, AI, AI];
const TABLE = [{ kind: "human" }, { kind: "open" }, AI, AI];

let srv, alice, bob, carol, shared, soloWon, soloLost, abandoned, active;
const moved = (gameId, seq, seat, user) =>
  queries.insertAction.run(gameId, seq, seat, user.user.id, JSON.stringify({ type: "endTurn" }));
const end = (gameId, status, winnerSeat = null) =>
  db().prepare("UPDATE games SET status = ?, winner_seat = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, winnerSeat, gameId);

// A table alice hosts at seat 0, bob takes seat 1, and alice starts it.
async function tableWithBob() {
  const id = (await alice.c.post("/api/games", { seats: TABLE })).body.id;
  assert.equal((await bob.c.post(`/api/games/${id}/seats/1/join`)).status, 200);
  assert.equal((await alice.c.post(`/api/games/${id}/start`)).status, 200);
  return id;
}

before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");

  // alice: a solo game won, a solo game lost, a game with bob that bob won as
  // Greece, a game with bob both walked out of, and a solo game still going.
  soloWon = (await alice.c.post("/api/games", { seats: SOLO })).body.id;
  moved(soloWon, 1, 0, alice);
  end(soloWon, "finished", 0);
  soloLost = (await alice.c.post("/api/games", { seats: SOLO })).body.id;
  moved(soloLost, 1, 0, alice);
  end(soloLost, "finished", 2);
  shared = await tableWithBob();
  moved(shared, 1, 0, alice);
  moved(shared, 2, 1, bob);
  end(shared, "finished", 1);
  abandoned = await tableWithBob();
  moved(abandoned, 1, 0, alice);
  moved(abandoned, 2, 1, bob);
  end(abandoned, "aborted");
  active = (await alice.c.post("/api/games", { seats: SOLO })).body.id;
});
after(async () => { await srv.close(); });

test("your own stats: the record, by civ, by company, and games in progress", async () => {
  const res = await alice.c.get("/api/stats");
  assert.equal(res.status, 200);
  const d = res.body;
  assert.equal(d.you, true);
  assert.equal(d.user.id, alice.user.id);
  assert.equal(d.user.username, alice.user.username);
  assert.ok(d.user.createdAt);
  assert.deepEqual(d.record, { played: 4, wins: 1, losses: 2, abandoned: 1, winRate: 25 });
  assert.equal(d.inProgress, 1);
  assert.deepEqual(d.byCiv.map((c) => [c.civ, c.played, c.wins]), [["Rome", 4, 1], ["Greece", 0, 0], ["The Huns", 0, 0], ["Babylon", 0, 0]]);
  assert.equal(d.byCiv[1].winRate, null, "no games, no rate");
  assert.deepEqual([d.solo.played, d.solo.wins, d.solo.losses], [2, 1, 1]);
  assert.deepEqual([d.withPeople.played, d.withPeople.losses, d.withPeople.abandoned], [2, 1, 1]);
});

test("someone else's stats agree with the leaderboard", async () => {
  const res = await carol.c.get(`/api/stats/${bob.user.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.you, false);
  assert.deepEqual(res.body.record, { played: 2, wins: 1, losses: 0, abandoned: 1, winRate: 50 });
  assert.equal(res.body.byCiv[1].wins, 1, "bob won as Greece");
  const board = (await carol.c.get("/api/leaderboard")).body;
  for (const u of [alice, bob]) {
    const row = board.find((r) => r.id === u.user.id);
    const stats = (await carol.c.get(`/api/stats/${u.user.id}`)).body.record;
    assert.deepEqual([stats.played, stats.wins], [row.games, row.wins], u.user.username);
  }
  assert.equal((await alice.c.get(`/api/stats/${alice.user.id}`)).body.you, true, "your own id is still you");
});

test("another player's games: theirs, with their seat, and Play only where you sit too", async () => {
  const res = await bob.c.get(`/api/games/user/${alice.user.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((g) => g.id).sort((a, b) => a - b), [soloWon, soloLost, shared, abandoned, active]);
  const s = res.body.find((g) => g.id === shared);
  assert.equal(s.userSeat, 0);
  assert.equal(s.mySeat, 1, "bob sat there too");
  assert.equal(s.seats[1].userId, bob.user.id);
  assert.equal(s.seats[2].userId, null, "an AI seat has no user");
  assert.equal(res.body.find((g) => g.id === active).mySeat, null);

  const own = (await alice.c.get("/api/games")).body.find((g) => g.id === active);
  assert.deepEqual([own.userSeat, own.mySeat], [0, 0]);
});

test("bad ids are a 400; unknown and deactivated players a 404; signed out a 401", async () => {
  for (const base of ["/api/stats", "/api/games/user", "/api/friends/user"]) {
    assert.equal((await carol.c.get(`${base}/abc`)).status, 400, base);
    assert.equal((await carol.c.get(`${base}/0`)).status, 400, base);
    assert.equal((await carol.c.get(`${base}/999999`)).status, 404, base);
    assert.equal((await client(srv.baseUrl).get(`${base}/${alice.user.id}`)).status, 401, base);
  }
  const gone = await registerUser(srv.baseUrl, "gone");
  queries.deactivateUser.run(gone.user.id);
  for (const base of ["/api/stats", "/api/games/user", "/api/friends/user"]) {
    assert.equal((await carol.c.get(`${base}/${gone.user.id}`)).status, 404, base);
  }
});
