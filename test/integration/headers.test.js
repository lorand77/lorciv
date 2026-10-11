"use strict";

// Every response carries the CSP (scripts only from this origin and only as
// files; inline styles allowed; no framing, since a sibling *.lorand77.dev
// page could otherwise frame the game and trick a click), says nosniff, and
// does not name the server software. No page may need an inline script. Outside production the session cookie has a
// plain name of its own, not LorChess's connect.sid.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

test("pages, scripts and API answers carry the CSP and may not be framed", async () => {
  for (const path of ["/login.html", "/game.html", "/js/ui.js", "/js/game.js", "/api/me"]) {
    const res = await fetch(srv.baseUrl + path);
    assert.equal(res.headers.get("content-security-policy"), CSP, path);
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

test("no page has an inline script or event handler, which script-src 'self' would block", async () => {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "../../public");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file}: inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file}: inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${file}: javascript: URL`);
  }
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
