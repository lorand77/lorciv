"use strict";

// The socket.* lines a connection leaves, and what they must not hold (an
// IP). See "Logging" in docs/design.md.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");

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
