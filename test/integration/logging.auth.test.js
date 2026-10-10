"use strict";

// The auth.* lines: the only ones that carry an IP, and the ones that must
// never carry what was typed into the login form. See "Logging" in
// docs/design.md.

// Few enough failures to reach the limit quickly (the tests before the last
// fail only twice), and one argon2 slot so a held login makes the next one
// busy. Set before the helper, which only fills in what is unset.
process.env.LOGIN_MAX_FAILURES = "5";
process.env.HASH_MAX_CONCURRENT = "1";

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const argon2 = require("argon2");
const { startServer, client, registerUser, db } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const queries = require("../../src/db/queries");

const IP = /^(::ffff:)?127\.0\.0\.1$/;

let srv;
let logs;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
beforeEach(() => { logs = captureLogs(); });
afterEach(() => logs.restore());

const written = () => JSON.stringify(logs.lines);

test("register names the new account and the IP", async () => {
  const { user } = await registerUser(srv.baseUrl, "newbie");
  const line = await logs.waitFor("auth.register");
  assert.equal(line.level, "info");
  assert.equal(line.fields.user, String(user.id));
  assert.equal(line.fields.name, user.username);
  assert.match(line.fields.ip, IP);
});

test("login names the account and the IP; logout names the account only", async () => {
  const { user, password } = await registerUser(srv.baseUrl, "regular");
  const c = client(srv.baseUrl);
  assert.equal((await c.post("/api/login", { username: user.username, password })).status, 200);
  const login = await logs.waitFor("auth.login");
  assert.equal(login.fields.user, String(user.id));
  assert.equal(login.fields.name, user.username);
  assert.match(login.fields.ip, IP);

  assert.equal((await c.post("/api/logout")).status, 200);
  const logout = await logs.waitFor("auth.logout");
  assert.equal(logout.fields.user, String(user.id));
  assert.equal(logout.fields.name, user.username);
  assert.equal("ip" in logout.fields, false);
});

test("a wrong password names the account, never the password", async () => {
  const { user } = await registerUser(srv.baseUrl, "fumble");
  const res = await client(srv.baseUrl).post("/api/login", { username: user.username, password: "Typo-Pass-91" });
  assert.equal(res.status, 401);
  const line = await logs.waitFor("auth.login_failed");
  assert.equal(line.fields.reason, "wrong_password");
  assert.equal(line.fields.user, String(user.id));
  assert.match(line.fields.ip, IP);
  assert.equal(written().includes("Typo-Pass-91"), false);
});

test("an unknown username is not written: it is sometimes a password", async () => {
  const res = await client(srv.baseUrl).post("/api/login", { username: "MySecret_Pw7", password: "whatever" });
  assert.equal(res.status, 401);
  const line = await logs.waitFor("auth.login_failed");
  assert.equal(line.fields.reason, "unknown_user");
  assert.equal("user" in line.fields, false);
  assert.equal("name" in line.fields, false);
  assert.equal(written().includes("MySecret_Pw7"), false);
  assert.equal(written().includes("whatever"), false);
});

test("a deactivated account's login is refused and logged as such", async () => {
  const { user, password } = await registerUser(srv.baseUrl, "gone");
  db().prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(user.id);
  const res = await client(srv.baseUrl).post("/api/login", { username: user.username, password });
  assert.equal(res.status, 403);
  const line = await logs.waitFor("auth.login_failed", { reason: "deactivated" });
  assert.equal(line.fields.user, String(user.id));
});

test("only auth lines carry an IP, and no line carries a password", async () => {
  const { c, password } = await registerUser(srv.baseUrl, "private");
  await c.get("/api/me");
  await c.post("/api/logout");
  await logs.waitFor("http.request", { route: "/api/logout" });
  for (const line of logs.lines) {
    if (!line.event.startsWith("auth.")) assert.equal("ip" in line.fields, false, line.event);
  }
  assert.equal(written().includes(password), false);
});

test("a login while every argon2 slot is taken is logged as busy", async (t) => {
  const { user, password } = await registerUser(srv.baseUrl, "queued");
  const verify = argon2.verify;
  t.mock.method(argon2, "verify", async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return verify(...args);
  });
  const body = { username: user.username, password };
  const [first, second] = await Promise.all([
    client(srv.baseUrl).post("/api/login", body),
    new Promise((resolve) => setTimeout(resolve, 50)).then(() => client(srv.baseUrl).post("/api/login", body)),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 503);
  const line = await logs.waitFor("auth.busy");
  assert.equal(line.level, "warn");
  assert.equal(line.fields.kind, "login");
});

test("an exception during login or registration is logged with its stack", async (t) => {
  t.mock.method(queries.getUserByUsername, "get", () => { throw new Error("login store down"); });
  assert.equal((await client(srv.baseUrl).post("/api/login", { username: "anyone", password: "x" })).status, 500);
  const login = await logs.waitFor("auth.login_error");
  assert.equal(login.fields.err, "Error: login store down");
  assert.ok(login.stack.length > 0);

  t.mock.method(queries.createUser, "run", () => { throw new Error("register store down"); });
  const reg = await client(srv.baseUrl).post("/api/register", { username: "fresh_name_1", password: "hunter22" });
  assert.equal(reg.status, 500);
  const register = await logs.waitFor("auth.register_error");
  assert.equal(register.fields.err, "Error: register store down");
});

// Last: it uses up this IP's login failures.
test("hitting the failed-login limit is a warning with the IP", async () => {
  const c = client(srv.baseUrl);
  let status;
  for (let i = 0; i < 10 && status !== 429; i++) {
    status = (await c.post("/api/login", { username: "nobody_here", password: "x" })).status;
  }
  assert.equal(status, 429);
  const line = await logs.waitFor("auth.throttled");
  assert.equal(line.level, "warn");
  assert.equal(line.fields.kind, "login");
  assert.match(line.fields.ip, IP);
});
