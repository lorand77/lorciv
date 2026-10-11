"use strict";

// A page on another host of the same site (lorchess.lorand77.dev, say) gets
// the user's cookie sent along with what it sends to LorCiv; the server refuses
// requests whose Origin is not its own host. See src/auth/origin.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { io: ioClient } = require("socket.io-client");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const SIBLING = "https://lorchess.lorand77.dev";
const SEATS = [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }];

// A request carrying the user's cookie and the given Origin, as a browser on
// that origin would send it.
function asFrom(origin, cookie, method, path, body) {
  const headers = { Cookie: `connect.sid=${cookie}` };
  if (origin !== undefined) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(srv.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// Resolves "connect" or the connect_error message.
function socketFrom(origin, cookie) {
  return new Promise((resolve) => {
    const socket = ioClient(srv.baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `connect.sid=${cookie}`, Origin: origin },
      reconnection: false,
      forceNew: true,
    });
    socket.once("connect", () => { socket.close(); resolve("connect"); });
    socket.once("connect_error", (err) => { socket.close(); resolve(err.message); });
  });
}

test("a change sent from another host is refused; from our own host it goes through", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "victim");
  const logs = captureLogs();
  t.after(() => logs.restore());

  const refused = await asFrom(SIBLING, c.cookie(), "POST", "/api/games", { seats: SEATS });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /other sites/);
  assert.ok(logs.find("auth.origin_refused", { via: "http", origin: SIBLING, method: "POST" }));
  assert.equal((await asFrom("null", c.cookie(), "POST", "/api/logout")).status, 403, "an opaque origin too");
  assert.equal((await asFrom(SIBLING, c.cookie(), "GET", "/api/me")).status, 200, "reads are left alone");

  const own = new URL(srv.baseUrl).origin;
  assert.equal((await asFrom(own, c.cookie(), "POST", "/api/games", { seats: SEATS })).status, 201);
  assert.equal((await asFrom(undefined, c.cookie(), "POST", "/api/games", { seats: SEATS })).status, 201,
    "no Origin: not a page on another site");
});

test("a socket opened from another host is refused; from our own host it connects", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "socketeer");
  const logs = captureLogs();
  t.after(() => logs.restore());
  assert.notEqual(await socketFrom(SIBLING, c.cookie()), "connect");
  assert.ok(logs.find("auth.origin_refused", { via: "socket", origin: SIBLING }));
  assert.equal(await socketFrom(new URL(srv.baseUrl).origin, c.cookie()), "connect");
});
