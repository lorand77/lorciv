"use strict";

// Every response forbids being framed (a sibling *.lorand77.dev page could
// otherwise frame the game and trick a click), says nosniff, and does not
// name the server software. Outside production the session cookie has a
// plain name of its own, not LorChess's connect.sid.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("pages, scripts and API answers may not be framed", async () => {
  for (const path of ["/login.html", "/game.html", "/js/ui.js", "/js/game.js", "/api/me"]) {
    const res = await fetch(srv.baseUrl + path);
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("x-powered-by"), null, path);
  }
  // Express's own 404 page replaces the CSP with its stricter default-src
  // 'none' (which does not cover framing); it is plain text with nothing to
  // click, and X-Frame-Options still forbids framing it.
  const missing = await fetch(srv.baseUrl + "/no-such-page");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-frame-options"), "DENY");
});

test("in development the session cookie is lorciv.sid, not Secure, and logout clears it", async () => {
  const c = client(srv.baseUrl);
  const reg = await fetch(srv.baseUrl + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "devcookie_" + process.pid, password: "hunter22" }),
  });
  assert.equal(reg.status, 201);
  const [line] = reg.headers.getSetCookie();
  assert.match(line, /^lorciv\.sid=/);
  assert.match(line, /HttpOnly/);
  assert.match(line, /SameSite=Lax/);
  assert.doesNotMatch(line, /Secure/, "localhost is plain HTTP");

  c.setCookie("lorciv.sid", line.split(";")[0].slice("lorciv.sid=".length));
  assert.equal((await c.get("/api/me")).status, 200);
  const out = await c.post("/api/logout");
  assert.match(out.headers.getSetCookie()[0], /^lorciv\.sid=;/);
});
