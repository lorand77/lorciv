"use strict";

// In production the session cookie is __Host-lorciv.sid: Secure, Path=/ and
// no Domain, which a browser demands of the prefix, so a page on a sibling
// *.lorand77.dev host cannot plant a cookie of that name. A request that
// reached the app over plain HTTP gets no cookie at all; logout clears it with
// the same attributes, without which a browser would not overwrite it.
//
// NODE_ENV is set before the helper loads src/config.js, and each test file
// runs in its own process, so no other file sees it.

process.env.NODE_ENV = "production";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, COOKIE } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

// Caddy terminates TLS and says so in X-Forwarded-Proto; the app trusts one hop.
function register(username, https) {
  return fetch(srv.baseUrl + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(https ? { "X-Forwarded-Proto": "https" } : {}) },
    body: JSON.stringify({ username, password: "hunter22" }),
  });
}

test("over HTTPS the cookie is __Host-lorciv.sid with the attributes the prefix requires", async () => {
  assert.equal(COOKIE, "__Host-lorciv.sid");
  const res = await register("prodcookie_" + process.pid, true);
  assert.equal(res.status, 201);
  const [line] = res.headers.getSetCookie();
  assert.match(line, /^__Host-lorciv\.sid=/);
  for (const attr of [/; Path=\//, /; Secure/, /; HttpOnly/, /; SameSite=Lax/]) assert.match(line, attr);
  assert.doesNotMatch(line, /Domain=/i);

  const cookie = line.split(";")[0];
  const me = await fetch(srv.baseUrl + "/api/me", { headers: { Cookie: cookie, "X-Forwarded-Proto": "https" } });
  assert.equal(me.status, 200);

  const out = await fetch(srv.baseUrl + "/api/logout", {
    method: "POST",
    headers: { Cookie: cookie, "X-Forwarded-Proto": "https" },
  });
  assert.equal(out.status, 200);
  const [cleared] = out.headers.getSetCookie();
  assert.match(cleared, /^__Host-lorciv\.sid=;/);
  for (const attr of [/; Path=\//, /; Secure/, /Expires=Thu, 01 Jan 1970/]) assert.match(cleared, attr);
});

test("over plain HTTP no session cookie is issued", async () => {
  const res = await register("prodplain_" + process.pid, false);
  assert.equal(res.status, 201, "the account is made");
  assert.deepEqual(res.headers.getSetCookie(), []);
});
