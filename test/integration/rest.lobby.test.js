"use strict";

// Tables in the lobby: a game with open seats waits for people to take them;
// the host starts it (open seats left become AI) or cancels it. The lists the
// lobby page shows. See "Tables and the lobby" in docs/design.md.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor, db } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const OPEN = { kind: "open" };
const AI = { kind: "ai" };
const TABLE = [{ kind: "human" }, OPEN, OPEN, AI];

describe("a table", () => {
  test("waits in the lobby with its open seats, listed for everyone", async () => {
    const alice = await registerUser(srv.baseUrl, "alice");
    const bob = await registerUser(srv.baseUrl, "bob");
    const made = await alice.c.post("/api/games", { seats: TABLE, seed: 5 });
    assert.equal(made.status, 201);
    assert.equal(made.body.status, "lobby");
    const id = made.body.id;
    const row = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
    assert.equal(row.status, "lobby");
    assert.equal(row.snapshot, null);
    assert.equal(row.started_at, null);

    const open = await bob.c.get("/api/games/open");
    assert.equal(open.status, 200);
    const t = open.body.find((g) => g.id === id);
    assert.ok(t, "bob sees alice's table");
    assert.equal(t.mySeat, null);
    assert.equal(t.hostId, alice.user.id);
    assert.deepEqual(t.seats.map((s) => s.kind), ["human", "open", "open", "ai"]);
    assert.equal(t.seats[0].username, alice.user.username);
    const mine = await alice.c.get("/api/games");
    assert.equal(mine.body.find((g) => g.id === id).mySeat, 0);
    // A table is not a game yet: the game page cannot join it.
    const s = await connectSocket(srv.baseUrl, alice.c.cookie());
    assert.deepEqual(await emitAck(s, "game:join", { gameId: id }), { ok: false, error: "not_started" });
    s.close();
  });

  test("seats are taken once, by one person each; the host cannot leave, others can", async () => {
    const alice = await registerUser(srv.baseUrl, "host");
    const bob = await registerUser(srv.baseUrl, "bob");
    const carol = await registerUser(srv.baseUrl, "carol");
    const id = (await alice.c.post("/api/games", { seats: TABLE })).body.id;

    const join = await bob.c.post(`/api/games/${id}/seats/1/join`);
    assert.equal(join.status, 200);
    assert.equal(join.body.seats[1].kind, "human");
    assert.equal(join.body.seats[1].username, bob.user.username);
    assert.equal(join.body.mySeat, 1);
    assert.equal((await bob.c.post(`/api/games/${id}/seats/2/join`)).status, 409, "one seat per person");
    assert.equal((await carol.c.post(`/api/games/${id}/seats/1/join`)).status, 409, "taken");
    assert.equal((await carol.c.post(`/api/games/${id}/seats/3/join`)).status, 409, "an AI seat is not open");
    assert.equal((await carol.c.post(`/api/games/${id}/seats/9/join`)).status, 404);
    assert.equal((await carol.c.post(`/api/games/999999/seats/1/join`)).status, 404);

    assert.equal((await alice.c.post(`/api/games/${id}/seats/0/leave`)).status, 409, "the host cancels instead");
    assert.equal((await carol.c.post(`/api/games/${id}/seats/1/leave`)).status, 403, "not carol's seat");
    const left = await bob.c.post(`/api/games/${id}/seats/1/leave`);
    assert.equal(left.status, 200);
    assert.equal(left.body.seats[1].kind, "open");
    assert.equal(db().prepare("SELECT user_id FROM game_seats WHERE game_id = ? AND seat = 1").get(id).user_id, null);
  });

  test("only the host starts it; open seats left become AI seats; then it is a game", async () => {
    const alice = await registerUser(srv.baseUrl, "starter");
    const bob = await registerUser(srv.baseUrl, "joiner");
    const carol = await registerUser(srv.baseUrl, "viewer");
    const id = (await alice.c.post("/api/games", { seats: TABLE, seed: 9 })).body.id;
    assert.equal((await bob.c.post(`/api/games/${id}/seats/1/join`)).status, 200);
    assert.equal((await bob.c.post(`/api/games/${id}/start`)).status, 403);

    const started = await alice.c.post(`/api/games/${id}/start`);
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, { id, status: "active" });
    const row = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
    assert.equal(row.status, "active");
    assert.ok(row.started_at);
    assert.equal(JSON.parse(row.snapshot).version, 2);
    const seats = db().prepare("SELECT seat, kind, user_id, difficulty FROM game_seats WHERE game_id = ? ORDER BY seat").all(id);
    assert.deepEqual(seats.map((s) => s.kind), ["human", "human", "ai", "ai"]);
    assert.equal(seats[2].difficulty, "prince", "an open seat left at the start is an easy AI");
    assert.equal(seats[1].user_id, bob.user.id);

    assert.equal((await carol.c.get("/api/games/open")).body.some((g) => g.id === id), false);
    const live = await carol.c.get("/api/games/live");
    assert.ok(live.body.some((g) => g.id === id && g.mySeat === null), "carol can find it to watch");
    assert.equal((await carol.c.post(`/api/games/${id}/seats/2/join`)).status, 409, "no joining a started game");
    assert.equal((await alice.c.post(`/api/games/${id}/start`)).status, 409);

    // Both players get in with their own seat.
    const a = await connectSocket(srv.baseUrl, alice.c.cookie());
    const b = await connectSocket(srv.baseUrl, bob.c.cookie());
    assert.equal((await emitAck(a, "game:join", { gameId: id })).state.mySeat, 0);
    assert.equal((await emitAck(b, "game:join", { gameId: id })).state.mySeat, 1);
    a.close(); b.close();
  });

  test("the host cancels a table; nobody else can", async () => {
    const alice = await registerUser(srv.baseUrl, "canceller");
    const bob = await registerUser(srv.baseUrl, "other");
    const id = (await alice.c.post("/api/games", { seats: TABLE })).body.id;
    assert.equal((await bob.c.del(`/api/games/${id}`)).status, 403);
    assert.equal((await alice.c.del(`/api/games/${id}`)).status, 200);
    assert.equal(db().prepare("SELECT status FROM games WHERE id = ?").get(id).status, "aborted");
    assert.equal((await bob.c.get("/api/games/open")).body.some((g) => g.id === id), false);
    assert.equal((await alice.c.del(`/api/games/${id}`)).status, 409, "already gone");
  });

  test("the lobby is told when tables change", async () => {
    const alice = await registerUser(srv.baseUrl, "noisy");
    const bob = await registerUser(srv.baseUrl, "listener");
    const s = await connectSocket(srv.baseUrl, bob.c.cookie());
    s.emit("lobby:enter");
    const presence = await waitFor(s, "lobby:presence");
    assert.ok(presence.some((u) => u.userId === bob.user.id));
    let changed = waitFor(s, "lobby:changed");
    const id = (await alice.c.post("/api/games", { seats: TABLE })).body.id;
    await changed;
    changed = waitFor(s, "lobby:changed");
    await bob.c.post(`/api/games/${id}/seats/1/join`);
    await changed;
    changed = waitFor(s, "lobby:changed");
    await alice.c.post(`/api/games/${id}/start`);
    await changed;
    s.close();
  });
});
