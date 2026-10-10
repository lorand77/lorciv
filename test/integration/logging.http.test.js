"use strict";

// The http.request line every /api request leaves, and the error handler that
// logs what no route caught. See "Logging" in docs/design.md.

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, registerUser } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const queries = require("../../src/db/queries");

let srv;
let logs;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
beforeEach(() => { logs = captureLogs(); });
afterEach(() => logs.restore());

test("a signed-out request is logged with its route, status and time, and no user", async () => {
  const res = await client(srv.baseUrl).get("/api/me");
  assert.equal(res.status, 401);
  const line = await logs.waitFor("http.request", { route: "/api/me" });
  assert.equal(line.level, "info");
  assert.match(line.fields.req, /^[0-9a-f]{8}$/);
  assert.equal(line.fields.method, "GET");
  assert.equal(line.fields.status, "401");
  assert.match(line.fields.ms, /^\d+$/);
  assert.equal("user" in line.fields, false);
  assert.equal("name" in line.fields, false);
  assert.equal("aborted" in line.fields, false);
});

test("the user is the one at the end of the request: set by register, kept through logout", async () => {
  const { c, user } = await registerUser(srv.baseUrl, "logme");
  const reg = await logs.waitFor("http.request", { route: "/api/register" });
  assert.equal(reg.fields.user, String(user.id));
  assert.equal(reg.fields.name, user.username);
  assert.equal(reg.fields.status, "201");

  assert.equal((await c.post("/api/logout")).status, 200);
  const out = await logs.waitFor("http.request", { route: "/api/logout" });
  assert.equal(out.fields.user, String(user.id));
  assert.equal(out.fields.name, user.username);
});

test("the route is the pattern, never the query string", async () => {
  const { c } = await registerUser(srv.baseUrl, "pattern");
  await c.get("/api/me?secret=abc");
  const line = await logs.waitFor("http.request", { route: "/api/me", status: 200 });
  assert.equal(line.fields.status, "200");
  assert.equal(JSON.stringify(logs.lines).includes("abc"), false);
});

test("an unknown endpoint is logged as unmatched", async () => {
  const res = await client(srv.baseUrl).get("/api/no/such/thing");
  assert.equal(res.status, 404);
  const line = await logs.waitFor("http.request", { route: "unmatched" });
  assert.equal(line.fields.status, "404");
  assert.equal(JSON.stringify(line).includes("such"), false);
});

test("static files are not logged", async () => {
  const res = await client(srv.baseUrl).get("/login.html");
  assert.equal(res.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(logs.find("http.request"), undefined);
});

test("malformed JSON is the client's error: 400, logged as a request, not as a failure", async () => {
  const res = await fetch(srv.baseUrl + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Bad request." });
  const line = await logs.waitFor("http.request", { status: 400 });
  assert.equal(line.level, "info");
  assert.equal(line.fields.route, "unmatched");
  assert.equal(logs.find("http.unhandled"), undefined);
});

test("an error no route caught is logged with its stack and the request id, and answered with neither", async (t) => {
  const { c, user } = await registerUser(srv.baseUrl, "boom");
  t.mock.method(queries.getUserById, "get", () => { throw new Error("database on fire"); });
  const res = await c.get("/api/me");
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "Server error." });

  const failure = await logs.waitFor("http.unhandled");
  assert.equal(failure.level, "error");
  assert.equal(failure.fields.err, "Error: database on fire");
  assert.equal(failure.fields.user, String(user.id));
  assert.ok(failure.stack.some((f) => f.includes("logging.http.test.js")));

  const request = await logs.waitFor("http.request", { route: "/api/me", status: 500 });
  assert.equal(request.level, "error");
  assert.equal(request.fields.req, failure.fields.req);
});

test("a slow request is a warning", async (t) => {
  // Every reading of the clock is 2 s after the previous one.
  let now = 0;
  t.mock.method(performance, "now", () => (now += 2000));
  await client(srv.baseUrl).get("/api/me");
  const line = await logs.waitFor("http.request", { route: "/api/me" });
  assert.equal(line.level, "warn");
  assert.ok(Number(line.fields.ms) >= 1000);
});

test("a request the client abandons is logged as aborted", async (t) => {
  const { user, password } = await registerUser(srv.baseUrl, "quitter");
  // Hold the login in argon2 long enough for the client to give up first.
  const argon2 = require("argon2");
  const verify = argon2.verify;
  t.mock.method(argon2, "verify", async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return verify(...args);
  });
  const controller = new AbortController();
  const pending = fetch(srv.baseUrl + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user.username, password }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { name: "AbortError" });
  const line = await logs.waitFor("http.request", { route: "/api/login" });
  assert.equal(line.fields.aborted, "true");
});
