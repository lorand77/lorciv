"use strict";

// Boots the real LorCiv server in-process on a random port, against a
// throwaway SQLite database, and provides a small HTTP client that keeps the
// session cookie between requests the way a browser would.
//
// The database path is fixed the moment this module loads, so require it
// BEFORE anything under src/ (src/db/index.js opens the database when loaded).
// Each test file runs in its own process, so each gets its own database.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorciv-test-"));
process.env.DB_PATH = path.join(dir, "test.sqlite");
process.env.SESSION_SECRET = "test-secret";
// Every test registers and logs in from 127.0.0.1, often several users at
// once, so the auth limits of src/auth/throttle.js would trip all over the
// suite. Lift them unless the test file set its own before requiring this.
process.env.LOGIN_MAX_FAILURES ??= "100000";
process.env.REGISTER_MAX ??= "100000";
process.env.HASH_MAX_CONCURRENT ??= "100000";
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

// The session cookie's name, which depends on NODE_ENV (src/config.js). That
// module only reads the environment, so loading it here is safe.
const COOKIE = require("../../src/config").SESSION_COOKIE;

// The server logs connections and the first load of the database logs its
// migrations. Keep the test output to the runner's own report unless TEST_LOG
// is set, which shows everything down to debug.
process.env.LOG_LEVEL ??= process.env.TEST_LOG ? "debug" : "silent";

// Start the server. Returns { baseUrl, io, close }. Servers may be started one
// after another against the same database, which is how a restart is tested.
async function startServer() {
  const { createServer } = require("../../src/app");
  const { server, io } = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    io,
    close: async () => {
      await shutdownSockets();
      server.closeAllConnections();
      await new Promise((resolve) => io.close(() => resolve()));
      // A real restart starts with no rooms in memory; the next server built
      // against the same database must rebuild them from it.
      require("../../src/game/rooms").clearAll();
    },
  };
}

// A minimal HTTP client with a cookie jar. Responses come back as
// { status, body, headers }, with body parsed as JSON when it is JSON.
function client(baseUrl) {
  const jar = new Map();

  async function request(method, urlPath, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*(Expires=Thu, 01 Jan 1970|Max-Age=0)/i.test(a));
      if (expired || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed === null ? text : parsed, headers: res.headers };
  }

  return {
    get: (p) => request("GET", p),
    post: (p, body = {}) => request("POST", p, body),
    put: (p, body = {}) => request("PUT", p, body),
    del: (p) => request("DELETE", p),
    cookie: (name = COOKIE) => jar.get(name),
    setCookie: (name, value) => jar.set(name, value),
    clearCookies: () => jar.clear(),
  };
}

// A username that is unique within the process and valid for /api/register.
// The suffix is decimal: base-36 letters could spell something that
// src/auth/usernamePolicy.js refuses, and the test would fail at random.
let counter = 0;
function uniqueName(base) {
  counter++;
  return `${base}_${process.pid}${counter}`.slice(0, 20);
}

// Register a fresh user on a fresh client; returns { c, user }.
async function registerUser(baseUrl, base = "user", password = "hunter22") {
  const c = client(baseUrl);
  const username = uniqueName(base);
  const res = await c.post("/api/register", { username, password });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return { c, user: res.body, password };
}

module.exports = { startServer, client, uniqueName, registerUser, COOKIE };

// ---- Socket.IO ----

const { io: ioClient } = require("socket.io-client");
const openSockets = new Set();

// Connect a Socket.IO client as the user whose session cookie this is. Rejects
// with the handshake error when the server refuses the connection. The
// `welcome` payload the server sends on connection is kept on socket.welcome.
function connectSocket(baseUrl, cookie) {
  const socket = ioClient(baseUrl, {
    transports: ["websocket"],
    extraHeaders: cookie ? { Cookie: `${COOKIE}=${cookie}` } : {},
    reconnection: false,
    forceNew: true,
  });
  openSockets.add(socket);
  socket.on("disconnect", () => openSockets.delete(socket));
  socket.welcome = new Promise((resolve) => socket.once("welcome", resolve));
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => { openSockets.delete(socket); socket.close(); reject(err); });
  });
}

// Emit with an acknowledgement callback, as a promise.
function emitAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), timeoutMs);
    socket.emit(event, payload, (reply) => { clearTimeout(timer); resolve(reply); });
  });
}

// The next occurrence of an event, as a promise. Arm it BEFORE the action that
// triggers the event, or the event may already have passed.
function waitFor(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${timeoutMs}ms`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

// Resolves true when the event does NOT arrive within the window.
function expectNo(socket, event, windowMs = 300) {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(timer); socket.off(event, handler); resolve(false); };
    const timer = setTimeout(() => { socket.off(event, handler); resolve(true); }, windowMs);
    socket.on(event, handler);
  });
}

// The application's database handle, for assertions on persisted rows.
function db() {
  return require("../../src/db/index");
}

// Close every client socket, so nothing keeps the process alive after the
// server has closed.
async function shutdownSockets() {
  for (const s of openSockets) s.close();
  openSockets.clear();
}

module.exports.connectSocket = connectSocket;
module.exports.emitAck = emitAck;
module.exports.waitFor = waitFor;
module.exports.expectNo = expectNo;
module.exports.db = db;
module.exports.shutdownSockets = shutdownSockets;
