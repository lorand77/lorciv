"use strict";

// The login and registration limits of src/auth/throttle.js over real HTTP,
// with the limits set low. Behind `trust proxy` the client IP is the last
// X-Forwarded-For hop, so each test poses as its own address and none of
// them shares a counter with another.

process.env.LOGIN_MAX_FAILURES = "3";
process.env.REGISTER_MAX = "3";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, uniqueName } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

async function post(ip, urlPath, body) {
  const res = await fetch(srv.baseUrl + urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("login limit", () => {
  test("failed logins from one IP are capped; successes do not count", async () => {
    const username = uniqueName("target");
    const password = "hunter22";
    assert.equal((await post("10.0.0.1", "/api/register", { username, password })).status, 201);

    const ip = "10.0.1.1";
    const wrong = { username, password: "wrong-pass" };
    assert.equal((await post(ip, "/api/login", wrong)).status, 401);
    assert.equal((await post(ip, "/api/login", { username: uniqueName("nobody"), password })).status, 401,
      "an unknown user is a failure too");
    assert.equal((await post(ip, "/api/login", { username, password })).status, 200);
    assert.equal((await post(ip, "/api/login", wrong)).status, 401);

    const blocked = await post(ip, "/api/login", { username, password });
    assert.equal(blocked.status, 429, "even the right password waits out the window");
    assert.match(blocked.body.error, /Too many attempts/);

    assert.equal((await post("10.0.1.2", "/api/login", { username, password })).status, 200,
      "another IP is unaffected");
  });
});

describe("registration limit", () => {
  test("accounts created from one IP are capped", async () => {
    const ip = "10.0.2.1";
    for (let i = 0; i < 3; i++) {
      const res = await post(ip, "/api/register", { username: uniqueName("many"), password: "hunter22" });
      assert.equal(res.status, 201);
    }
    const blocked = await post(ip, "/api/register", { username: uniqueName("many"), password: "hunter22" });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many attempts/);

    const other = await post("10.0.2.2", "/api/register", { username: uniqueName("many"), password: "hunter22" });
    assert.equal(other.status, 201, "another IP is unaffected");
  });

  test("rejected registrations do not use up the allowance", async () => {
    const ip = "10.0.3.1";
    for (let i = 0; i < 5; i++) {
      assert.equal((await post(ip, "/api/register", { username: "x", password: "hunter22" })).status, 400);
    }
    const res = await post(ip, "/api/register", { username: uniqueName("late"), password: "hunter22" });
    assert.equal(res.status, 201);
  });
});

describe("password length", () => {
  test("128 characters is the most a password can be", async () => {
    const ip = "10.0.4.1";
    const tooLong = await post(ip, "/api/register", { username: uniqueName("long"), password: "p".repeat(129) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /Password must be 6–128 characters/);

    const username = uniqueName("long");
    const longest = "p".repeat(128);
    assert.equal((await post(ip, "/api/register", { username, password: longest })).status, 201);
    assert.equal((await post(ip, "/api/login", { username, password: longest })).status, 200);

    const login = await post(ip, "/api/login", { username, password: longest + "p" });
    assert.equal(login.status, 401);
    assert.match(login.body.error, /Invalid username or password/);
  });
});
