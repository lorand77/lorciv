"use strict";

// The socket.* and game.* lines a connection and a game leave, and what they
// must not hold (an IP, a payload). See "Logging" in docs/design.md.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { deserializeGame } = require("../../src/shared/snapshot");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("connect and disconnect, as the log tells it", async (t) => {
  const logs = captureLogs();
  t.after(() => logs.restore());
  const alice = await registerUser(srv.baseUrl, "lg_alice");
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());

  const connect = await logs.waitFor("socket.connect", { user: alice.user.id });
  assert.equal(connect.level, "info");
  assert.equal(connect.fields.name, alice.user.username);

  a.close();
  const left = await logs.waitFor("socket.disconnect", { user: alice.user.id });
  assert.equal(left.fields.reason, "client namespace disconnect");

  for (const line of logs.lines) {
    if (!line.event.startsWith("auth.")) assert.equal("ip" in line.fields, false, line.event);
  }
});

test("a game leaves a line per join and per accepted action, with the type and never the payload", async (t) => {
  const logs = captureLogs();
  t.after(() => logs.restore());
  const alice = await registerUser(srv.baseUrl, "lg_player");
  const bob = await registerUser(srv.baseUrl, "lg_watcher");
  const id = (await alice.c.post("/api/games", { seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }], seed: 2 })).body.id;
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  t.after(() => { a.close(); b.close(); });
  const state = (await emitAck(a, "game:join", { gameId: id })).state;
  await emitAck(b, "game:join", { gameId: id });
  const joined = logs.find("game.join", { game: id, user: alice.user.id });
  assert.equal(joined.fields.seat, "0");
  assert.equal("watcher" in joined.fields, false);
  assert.equal(logs.find("game.join", { game: id, user: bob.user.id }).fields.watcher, "true");

  const worker = deserializeGame(state.snapshot).civs[0].units.find((u) => u.unitType === "worker");
  const next = waitFor(a, "game:state");
  assert.equal((await emitAck(a, "game:action", { gameId: id, seq: 0, type: "skip", unitId: worker.id })).ok, true);
  await next;
  const line = logs.find("game.action", { game: id, type: "skip" });
  assert.equal(line.level, "info");
  assert.equal(line.fields.user, String(alice.user.id));
  assert.equal(line.fields.name, alice.user.username);
  assert.equal(line.fields.seat, "0");
  assert.equal(line.fields.seq, "1");
  assert.equal(line.fields.turn, "1");
  assert.equal("unitId" in line.fields, false, "the payload stays out of the log");

  const end = waitFor(a, "game:state");
  await emitAck(a, "game:action", { gameId: id, seq: 1, type: "endTurn" });
  await end;
  assert.ok(logs.find("game.action", { game: id, type: "endTurn", seq: 2 }));

  // A refusal is not an info line.
  assert.equal((await emitAck(a, "game:action", { gameId: id, seq: 2, type: "skip", unitId: 9999 })).error, "no_such_unit");
  const refused = logs.find("game.action_refused", { game: id, type: "skip" });
  assert.equal(refused.level, "debug");
  assert.equal(refused.fields.error, "no_such_unit");
  assert.equal(logs.lines.filter((l) => l.event === "game.action" && l.fields.game === String(id)).length, 2);
});
