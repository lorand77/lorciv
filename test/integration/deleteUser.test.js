"use strict";

// `npm run user:delete`: the account row stays as deleted-<id>, deactivated and
// without a password; chat, friendships, achievements, display settings and
// sessions go;
// tables they host are cancelled and their seats at other tables released; a
// live seat blocks the deletion.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { startServer, registerUser, client, db } = require("../helpers/server");
const queries = require("../../src/db/queries");

const CLI = path.join(__dirname, "../../src/db/deleteUser.js");

// Run the command against the test database with the confirmation on stdin.
function cli(username, confirm) {
  // The answer needs its newline, as a person typing Enter would give it.
  const r = spawnSync(process.execPath, [CLI, username], { env: process.env, encoding: "utf8", input: (confirm ?? "") + "\n" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const AI = { kind: "ai" };
const TABLE = [{ kind: "human" }, { kind: "open" }, AI, AI];

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("refuses while the user holds a seat in a live game, and tells the operator what to do", async () => {
  const alice = await registerUser(srv.baseUrl, "busy");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, AI, AI, AI] })).body.id;
  const r = cli(alice.user.username, alice.user.username);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`live game\\(s\\) #${id}; nothing deleted`));
  assert.match(r.out, /user:deactivate/);
  assert.equal(queries.getUserById.get(alice.user.id).username, alice.user.username);
});

test("deletes: name freed, password gone, chat, friends, achievements, settings and sessions removed, tables tidied, games kept", async () => {
  const alice = await registerUser(srv.baseUrl, "leaving");
  const bob = await registerUser(srv.baseUrl, "staying");
  // A finished game alice took part in, a table she hosts, a seat at bob's table, some chat.
  const finished = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, AI, AI, AI] })).body.id;
  db().prepare("UPDATE games SET status = 'finished', winner_seat = 0, finished_at = datetime('now') WHERE id = ?").run(finished);
  const hosted = (await alice.c.post("/api/games", { seats: TABLE })).body.id;
  const bobs = (await bob.c.post("/api/games", { seats: TABLE })).body.id;
  assert.equal((await alice.c.post(`/api/games/${bobs}/seats/1/join`)).status, 200);
  db().prepare("INSERT INTO chat_messages (game_id, user_id, text) VALUES (?, ?, 'gg')").run(finished, alice.user.id);
  db().prepare("INSERT INTO chat_messages (game_id, user_id, text) VALUES (?, ?, 'well played')").run(finished, bob.user.id);
  // A friend, a request she sent, and a scheme of her own.
  const carol = await registerUser(srv.baseUrl, "asked");
  const req = await alice.c.post("/api/friends/requests", { toUserId: bob.user.id });
  assert.equal((await bob.c.post(`/api/friends/requests/${req.body.id}/accept`)).status, 200);
  assert.equal((await alice.c.post("/api/friends/requests", { toUserId: carol.user.id })).status, 201);
  assert.equal((await alice.c.put("/api/settings", { scheme: "light" })).status, 200);
  // An achievement of hers, and one of bob's.
  for (const u of [alice, bob]) {
    queries.awardAchievement.run({ userId: u.user.id, key: "first_blood", tier: 1, at: null, gameId: finished });
  }

  const refused = cli(alice.user.username, "something else");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /not confirmed/);
  assert.equal(queries.getUserById.get(alice.user.id).username, alice.user.username);

  const r = cli(alice.user.username, alice.user.username);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kept, without the name: 1 finished or abandoned game/);
  assert.match(r.out, /cancelled: 1 table\(s\) hosted; released: 1 seat/);
  assert.match(r.out, /deleted: 1 chat message\(s\), 2 friendship\(s\) and request\(s\), 1 achievement\(s\)/);
  assert.match(r.out, new RegExp(`deleted ${alice.user.username}: now deleted-${alice.user.id}`));

  const row = db().prepare("SELECT * FROM users WHERE id = ?").get(alice.user.id);
  assert.equal(row.username, `deleted-${alice.user.id}`);
  assert.equal(row.password_hash, null);
  assert.equal(row.prefs, null, "her settings are gone");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM friendships WHERE ? IN (requester_id, addressee_id)").get(alice.user.id).n, 0);
  assert.deepEqual((await bob.c.get("/api/friends")).body.friends, [], "she is off her friends' lists");
  assert.deepEqual((await carol.c.get("/api/friends")).body.incoming, []);
  assert.ok(row.deactivated_at);
  assert.equal((await alice.c.get("/api/me")).status, 401, "sessions are gone");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?").get(alice.user.id).n, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?").get(bob.user.id).n, 1, "others' chat stays");
  assert.deepEqual(queries.listAchievements.all(alice.user.id), []);
  assert.equal(queries.listAchievements.all(bob.user.id).length, 1, "others' achievements stay");
  assert.equal(queries.getGameById.get(hosted).status, "aborted", "her table is cancelled");
  assert.equal(queries.getSeats.all(bobs)[1].kind, "open", "her seat at bob's table is free again");
  // The finished game keeps its record, under the new name.
  const seats = queries.getSeats.all(finished);
  assert.equal(seats[0].user_id, alice.user.id);
  assert.equal(seats[0].username, `deleted-${alice.user.id}`);
  assert.equal((await bob.c.get(`/api/games/${finished}`)).body.seats[0].username, `deleted-${alice.user.id}`);
  // The old name can be registered again; the new one never can.
  const again = await client(srv.baseUrl).post("/api/register", { username: alice.user.username, password: "hunter22" });
  assert.equal(again.status, 201);
  assert.equal((await client(srv.baseUrl).post("/api/register", { username: `deleted-${alice.user.id}`, password: "hunter22" })).status, 400);
  // Deleted accounts are off the leaderboard.
  assert.equal((await bob.c.get("/api/leaderboard")).body.some((p) => p.id === alice.user.id), false);
});

test("refuses unknown and already deleted names", async () => {
  assert.equal(cli("no_such_user_x", "no_such_user_x").code, 2);
  assert.equal(cli("deleted-5", "deleted-5").code, 2);
  assert.equal(spawnSync(process.execPath, [CLI], { env: process.env, encoding: "utf8" }).status, 2);
});
