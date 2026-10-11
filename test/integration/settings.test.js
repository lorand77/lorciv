"use strict";

// /api/settings: the colour scheme, dark unless chosen otherwise, validated to
// exactly two values, kept per user and across sessions.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, client, db } = require("../helpers/server");

let srv, me;
before(async () => {
  srv = await startServer();
  me = await registerUser(srv.baseUrl, "styler");
});
after(async () => { await srv.close(); });

test("dark unless chosen otherwise; signed out is a 401", async () => {
  const res = await me.c.get("/api/settings");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { scheme: "dark" });
  assert.equal((await client(srv.baseUrl).get("/api/settings")).status, 401);
  assert.equal((await client(srv.baseUrl).put("/api/settings", { scheme: "light" })).status, 401);
});

test("light is saved, for this user only, and outlasts the session", async () => {
  const res = await me.c.put("/api/settings", { scheme: "light" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { scheme: "light" });

  const other = await registerUser(srv.baseUrl, "plain");
  assert.equal((await other.c.get("/api/settings")).body.scheme, "dark");

  const again = client(srv.baseUrl);
  assert.equal((await again.post("/api/login", { username: me.user.username, password: me.password })).status, 200);
  assert.equal((await again.get("/api/settings")).body.scheme, "light");
});

test("anything but dark or light is refused, and nothing is saved", async () => {
  for (const scheme of ["sepia", "", "LIGHT", 1, null, ["light"], { scheme: "dark" }]) {
    const res = await me.c.put("/api/settings", { scheme });
    assert.equal(res.status, 400, JSON.stringify(scheme));
    assert.match(res.body.error, /scheme/);
  }
  assert.equal((await me.c.get("/api/settings")).body.scheme, "light");
});

test("a body without a scheme changes nothing; unknown fields are not stored", async () => {
  const res = await me.c.put("/api/settings", { colour: "#ff0000" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { scheme: "light" });
  const row = db().prepare("SELECT prefs FROM users WHERE id = ?").get(me.user.id);
  assert.deepEqual(JSON.parse(row.prefs), { scheme: "light" });
});

test("stored settings that are malformed read as the defaults", async () => {
  for (const prefs of ["not json", "null", JSON.stringify({ scheme: "sepia" })]) {
    db().prepare("UPDATE users SET prefs = ? WHERE id = ?").run(prefs, me.user.id);
    assert.deepEqual((await me.c.get("/api/settings")).body, { scheme: "dark" }, prefs);
  }
});
