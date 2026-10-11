"use strict";

// /api/games: creating a game (one human seat, the rest AI), listing one's
// games, reading one. Playing is over the socket (socket.game.test.js).

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, registerUser, db } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const AI = { kind: "ai", difficulty: "king" };
const SEATS = [{ kind: "human" }, AI, AI, { kind: "ai" }];

describe("POST /api/games", () => {
  test("needs a session", async () => {
    assert.equal((await client(srv.baseUrl).post("/api/games", { seats: SEATS })).status, 401);
  });

  test("refuses a bad seat list, difficulty or turn time", async () => {
    const { c } = await registerUser(srv.baseUrl, "picky");
    const bad = [
      ["no seats", {}, /4 seats/],
      ["three seats", { seats: SEATS.slice(0, 3) }, /4 seats/],
      ["two humans", { seats: [{ kind: "human" }, { kind: "human" }, AI, AI] }, /Exactly one seat/],
      ["no human", { seats: [AI, AI, AI, AI] }, /Exactly one seat/],
      ["unknown kind", { seats: [{ kind: "human" }, { kind: "robot" }, AI, AI] }, /human, open or ai/],
      ["unknown difficulty", { seats: [{ kind: "human" }, { kind: "ai", difficulty: "deity" }, AI, AI] }, /difficulty/],
      ["unknown turn time", { seats: SEATS, turnTime: "1w" }, /turn time/],
    ];
    for (const [name, body, re] of bad) {
      const res = await c.post("/api/games", body);
      assert.equal(res.status, 400, name);
      assert.match(res.body.error, re, name);
    }
  });

  test("creates the game, its seats and the first snapshot", async () => {
    const { c, user } = await registerUser(srv.baseUrl, "host");
    const res = await c.post("/api/games", { seats: SEATS, seed: 4242, turnTime: "10m" });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "active", "no open seat: it starts at once");
    const id = res.body.id;
    assert.ok(Number.isInteger(id));

    const row = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
    assert.equal(row.status, "active");
    assert.equal(row.host_id, user.id);
    assert.equal(row.seed, 4242);
    assert.deepEqual(JSON.parse(row.settings), { turnTime: "10m" });
    assert.equal(row.seq, 0);
    assert.equal(row.turn, 1);
    assert.equal(JSON.parse(row.snapshot).version, 2);
    assert.ok(row.started_at);

    const seats = db().prepare("SELECT * FROM game_seats WHERE game_id = ? ORDER BY seat").all(id);
    assert.deepEqual(seats.map((s) => [s.seat, s.kind, s.user_id, s.difficulty]), [
      [0, "human", user.id, "prince"], [1, "ai", null, "king"], [2, "ai", null, "king"], [3, "ai", null, "prince"],
    ]);
    assert.ok(seats[0].joined_at, "the human took the seat");
    assert.equal(seats[1].joined_at, null);
  });

  test("a missing seed is drawn by the server; the default turn time applies", async () => {
    const { c } = await registerUser(srv.baseUrl, "lazy");
    const res = await c.post("/api/games", { seats: SEATS });
    assert.equal(res.status, 201);
    const row = db().prepare("SELECT seed, settings FROM games WHERE id = ?").get(res.body.id);
    assert.ok(Number.isInteger(row.seed) && row.seed >= 0);
    assert.deepEqual(JSON.parse(row.settings), { turnTime: "3m" });
  });
});

describe("GET /api/games", () => {
  test("lists my games with my seat, newest first; others see theirs only", async () => {
    const alice = await registerUser(srv.baseUrl, "alice");
    const bob = await registerUser(srv.baseUrl, "bob");
    const first = (await alice.c.post("/api/games", { seats: SEATS, seed: 1 })).body.id;
    const second = (await alice.c.post("/api/games", { seats: SEATS, seed: 2 })).body.id;

    const mine = await alice.c.get("/api/games");
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.map((g) => g.id), [second, first]);
    const g = mine.body[0];
    assert.equal(g.status, "active");
    assert.equal(g.turn, 1);
    assert.equal(g.currentSeat, 0);
    assert.equal(g.mySeat, 0);
    assert.equal(g.seats.length, 4);
    assert.equal(g.seats[0].username, alice.user.username);
    assert.equal(g.seats[0].civ, "Rome");
    assert.equal(g.seats[1].kind, "ai");
    assert.equal(g.seats[1].username, null);

    assert.deepEqual((await bob.c.get("/api/games")).body, []);

    // Anyone signed in may look at a game: spectating is open.
    const look = await bob.c.get(`/api/games/${first}`);
    assert.equal(look.status, 200);
    assert.equal(look.body.id, first);
    assert.equal(look.body.mySeat, null);
    assert.equal(look.body.seed, 1);
    assert.deepEqual(look.body.settings, { turnTime: "3m" });
    assert.equal((await alice.c.get(`/api/games/${first}`)).body.mySeat, 0);

    assert.equal((await bob.c.get("/api/games/999999")).status, 404);
    assert.equal((await bob.c.get("/api/games/abc")).status, 404);
    assert.equal((await client(srv.baseUrl).get("/api/games")).status, 401);
  });
});
