"use strict";

// Session revocation must cover live socket connections, every tab sharing the
// cookie, and handshakes that began before logout. Separate logins stay valid.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, client, registerUser, connectSocket, waitFor, expectNo, db,
} = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { Manager } = require("socket.io-client");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("a connected socket is welcomed as its user", async (t) => {
  const { c, user } = await registerUser(srv.baseUrl, "hello");
  const socket = await connectSocket(srv.baseUrl, c.cookie());
  t.after(() => socket.close());
  assert.deepEqual(await socket.welcome, { userId: user.id, username: user.username });
});

test("without a session the handshake is refused", async () => {
  await assert.rejects(connectSocket(srv.baseUrl, undefined), /unauthorized/);
  await assert.rejects(connectSocket(srv.baseUrl, "s%3Aforged.signature"), /unauthorized/);
});

test("logout disconnects every tab sharing the session", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "alice");
  const cookie = c.cookie();
  const tab1 = await connectSocket(srv.baseUrl, cookie);
  const tab2 = await connectSocket(srv.baseUrl, cookie);
  t.after(() => { tab1.close(); tab2.close(); });

  const [out, reason1, reason2] = await Promise.all([
    c.post("/api/logout"),
    waitFor(tab1, "disconnect"),
    waitFor(tab2, "disconnect"),
  ]);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true });
  assert.equal(c.cookie(), undefined);
  assert.equal(reason1, "io server disconnect");
  assert.equal(reason2, "io server disconnect");

  const stale = client(srv.baseUrl);
  stale.setCookie("connect.sid", cookie);
  assert.equal((await stale.get("/api/me")).status, 401);
  await assert.rejects(connectSocket(srv.baseUrl, cookie), /unauthorized/);
});

test("logout preserves an independent login for the same player", async (t) => {
  const { c, user, password } = await registerUser(srv.baseUrl, "bob");
  const first = await connectSocket(srv.baseUrl, c.cookie());
  const other = client(srv.baseUrl);
  assert.equal((await other.post("/api/login", { username: user.username, password })).status, 200);
  const device = await connectSocket(srv.baseUrl, other.cookie());
  t.after(() => { first.close(); device.close(); });

  const [out] = await Promise.all([c.post("/api/logout"), waitFor(first, "disconnect")]);
  assert.equal(out.status, 200);
  assert.equal(device.connected, true);
  assert.equal(await expectNo(device, "disconnect"), true);
  assert.equal((await other.get("/api/me")).status, 200);
});

test("a session that expires on an open connection is dropped at its next event", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "expiry");
  const socket = await connectSocket(srv.baseUrl, c.cookie());
  t.after(() => socket.close());
  const sid = srv.io.sockets.sockets.get(socket.id).request.sessionID;
  db().prepare("UPDATE sessions SET expire = ? WHERE sid = ?").run("2000-01-01T00:00:00.000Z", sid);
  const disconnected = waitFor(socket, "disconnect");
  // Any event re-checks the session, known to the server or not.
  socket.emit("noop", {});
  assert.equal(await disconnected, "io server disconnect");
});

test("logout between the transport handshake and socket connect rejects the stale session", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "late");
  const manager = new Manager(srv.baseUrl, {
    autoConnect: false, transports: ["websocket"], reconnection: false,
    extraHeaders: { Cookie: `connect.sid=${c.cookie()}` },
  });
  const socket = manager.socket("/");
  t.after(() => { socket.close(); manager.engine.close(); });
  const opened = waitFor(manager, "open");
  manager.open();
  await opened;
  assert.equal((await c.post("/api/logout")).status, 200);
  const result = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  socket.connect();
  await assert.rejects(result, /unauthorized/);
});

test("regenerating a login disconnects sockets authenticated by the old session", async (t) => {
  const { c, user, password } = await registerUser(srv.baseUrl, "renew");
  const cookie = c.cookie();
  const socket = await connectSocket(srv.baseUrl, cookie);
  t.after(() => socket.close());
  const [login, reason] = await Promise.all([
    c.post("/api/login", { username: user.username, password }),
    waitFor(socket, "disconnect"),
  ]);
  assert.equal(login.status, 200);
  assert.equal(reason, "io server disconnect");
  assert.notEqual(c.cookie(), cookie);
  await assert.rejects(connectSocket(srv.baseUrl, cookie), /unauthorized/);
  const fresh = await connectSocket(srv.baseUrl, c.cookie());
  t.after(() => fresh.close());
  assert.equal((await fresh.welcome).userId, user.id);
});

test("logout reports a store failure instead of claiming the session was revoked", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "failure");
  const cookie = c.cookie();
  const socket = await connectSocket(srv.baseUrl, cookie);
  t.after(() => socket.close());
  const store = srv.io.sockets.sockets.get(socket.id).request.sessionStore;
  t.mock.method(store, "destroy", (_sid, callback) => callback(new Error("write failed")));
  const logs = captureLogs();
  t.after(() => logs.restore());
  const out = await c.post("/api/logout");
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: "Logout failed." });
  assert.equal(logs.find("auth.logout_error").fields.err, "Error: write failed");
  assert.equal(c.cookie(), cookie);
  assert.equal((await c.get("/api/me")).status, 200);
  assert.equal(socket.connected, true);
});
