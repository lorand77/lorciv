"use strict";

// In-game chat: one room per game for players and spectators, history on join,
// limits, and the retention sweep. Chat text is never logged.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor, db } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { sweepChat } = require("../../src/db/retention");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("messages reach everyone in the game, players and watchers, and come back on join", async (t) => {
  const logs = captureLogs();
  t.after(() => logs.restore());
  const alice = await registerUser(srv.baseUrl, "talker");
  const bob = await registerUser(srv.baseUrl, "watcher");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  t.after(() => { a.close(); b.close(); });
  await emitAck(a, "game:join", { gameId: id });

  assert.equal((await emitAck(b, "chat:send", { gameId: id, text: "hi" })).error, "not_joined");
  assert.equal((await emitAck(b, "game:join", { gameId: id })).state.chat.length, 0);

  const toA = waitFor(a, "chat:message");
  const toB = waitFor(b, "chat:message");
  assert.deepEqual(await emitAck(a, "chat:send", { gameId: id, text: "  good luck, have fun  " }), { ok: true });
  const [ma, mb] = await Promise.all([toA, toB]);
  assert.equal(ma.gameId, id);
  assert.equal(ma.userId, alice.user.id);
  assert.equal(ma.username, alice.user.username);
  assert.equal(ma.text, "good luck, have fun", "trimmed");
  assert.deepEqual(mb, ma);

  // A watcher may talk too.
  const toA2 = waitFor(a, "chat:message");
  assert.equal((await emitAck(b, "chat:send", { gameId: id, text: "watching!" })).ok, true);
  assert.equal((await toA2).username, bob.user.username);

  for (const text of ["", "   ", "x".repeat(301), 42]) {
    assert.equal((await emitAck(a, "chat:send", { gameId: id, text })).error, "bad_text", JSON.stringify(text));
  }
  assert.equal((await emitAck(a, "chat:send", { gameId: 999999, text: "hello" })).error, "no_such_game");

  const history = (await emitAck(b, "game:join", { gameId: id })).state.chat;
  assert.deepEqual(history.map((m) => m.text), ["good luck, have fun", "watching!"], "oldest first");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE game_id = ?").get(id).n, 2);
  assert.equal(JSON.stringify(logs.lines).includes("good luck"), false, "chat text is never logged");
});

test("chat of long-finished games is swept; live games keep theirs", async () => {
  const alice = await registerUser(srv.baseUrl, "sweeper");
  const old = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  const live = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }] })).body.id;
  const insert = db().prepare("INSERT INTO chat_messages (game_id, user_id, text) VALUES (?, ?, ?)");
  insert.run(old, alice.user.id, "gg");
  insert.run(live, alice.user.id, "still here");
  db().prepare("UPDATE games SET status = 'finished', finished_at = datetime('now', '-40 days') WHERE id = ?").run(old);
  assert.equal(sweepChat(30), 1);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE game_id = ?").get(old).n, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE game_id = ?").get(live).n, 1);
  assert.equal(sweepChat(-1), 0, "a negative retention keeps everything");
});
