"use strict";

// /api/games: creating a game (one human seat, at any civ, the rest AI),
// listing one's games, reading one. Playing is over the socket (socket.game.test.js).

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, registerUser, db } = require("../helpers/server");
const { deserializeGame } = require("../../src/shared/snapshot");

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

  test("the host may play any civ: the AI seats before it have moved when the game opens", async () => {
    const { c, user } = await registerUser(srv.baseUrl, "babylonian");
    const res = await c.post("/api/games", { seats: [AI, AI, AI, { kind: "human" }] });
    assert.equal(res.status, 201);
    const row = db().prepare("SELECT current_seat, turn, host_id FROM games WHERE id = ?").get(res.body.id);
    assert.deepEqual({ ...row }, { current_seat: 3, turn: 1, host_id: user.id }, "Babylon's turn, Rome to the Huns done");
    const mine = (await c.get("/api/games")).body.find((g) => g.id === res.body.id);
    assert.equal(mine.mySeat, 3);
    assert.equal(mine.seats[3].civ, "Babylon");
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

describe("difficulty", () => {
  test("only an AI seat gets one; a person plays at prince, whatever the request says", async () => {
    const { c } = await registerUser(srv.baseUrl, "sly");
    const { c: guest } = await registerUser(srv.baseUrl, "joiner");
    const res = await c.post("/api/games", {
      seats: [{ kind: "human", difficulty: "emperor" }, { kind: "open", difficulty: "emperor" }, { kind: "ai", difficulty: "emperor" }, AI],
    });
    assert.equal(res.status, 201);
    const id = res.body.id;
    const seats = db().prepare("SELECT seat, difficulty FROM game_seats WHERE game_id = ? ORDER BY seat").all(id);
    assert.deepEqual(seats.map((s) => s.difficulty), ["prince", "prince", "emperor", "king"]);

    // A row from before the rule: the start ignores it on a person's seat.
    db().prepare("UPDATE game_seats SET difficulty = 'emperor' WHERE game_id = ? AND seat IN (0, 1)").run(id);
    assert.equal((await guest.post(`/api/games/${id}/seats/1/join`)).status, 200);
    assert.equal((await c.post(`/api/games/${id}/start`)).status, 200);
    const snapshot = JSON.parse(db().prepare("SELECT snapshot FROM games WHERE id = ?").get(id).snapshot);
    assert.deepEqual(snapshot.setup.difficultyFlags, ["prince", "prince", "emperor", "king"]);
    const { civs } = deserializeGame(snapshot);
    assert.equal(civs[0].prodMult, 1);
    assert.equal(civs[1].prodMult, 1);
    assert.equal(civs[2].prodMult, 1.5);
  });
});

describe("seeds and seats as the lists show them", () => {
  test("a seed outside 0..4294967295, or not a whole number, is refused rather than wrapped", async () => {
    const { c } = await registerUser(srv.baseUrl, "seeder");
    for (const seed of [4294967296, 1e300, -1, 1.5, "5", true]) {
      const res = await c.post("/api/games", { seats: SEATS, seed });
      assert.equal(res.status, 400, String(seed));
      assert.match(res.body.error, /seed is a whole number/);
    }
    const top = await c.post("/api/games", { seats: SEATS, seed: 4294967295 });
    assert.equal(top.status, 201);
    assert.equal(db().prepare("SELECT seed FROM games WHERE id = ?").get(top.body.id).seed, 4294967295);
    assert.equal((await c.post("/api/games", { seats: SEATS, seed: null })).status, 201, "null: the server draws one");
  });

  test("a game you left is still in your list, to watch: no seat of yours, and among live games", async () => {
    const rooms = require("../../src/game/rooms");
    const { c: host } = await registerUser(srv.baseUrl, "stays");
    const { c: guest, user } = await registerUser(srv.baseUrl, "goes");
    const id = (await host.post("/api/games", { seats: [{ kind: "human" }, { kind: "open" }, AI, AI] })).body.id;
    assert.equal((await guest.post(`/api/games/${id}/seats/1/join`)).status, 200);
    assert.equal((await host.post(`/api/games/${id}/start`)).status, 200);
    assert.equal((await guest.get("/api/games")).body.find((g) => g.id === id).mySeat, 1);

    assert.equal(rooms.leaveGame(rooms.getRoom(id), user.id).ok, true);
    const mine = (await guest.get("/api/games")).body.find((g) => g.id === id);
    assert.ok(mine, "still listed");
    assert.equal(mine.mySeat, null);
    assert.equal((await guest.get("/api/games/live")).body.find((g) => g.id === id).mySeat, null);
  });
});
