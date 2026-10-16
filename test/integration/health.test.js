"use strict";

// GET /health, the uptime check's endpoint (src/health.js): a bare ok, no
// session and no log line while healthy; a 503 and a health.failed line
// saying why when the disk is low or a check throws.

const fs = require("fs");
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");

let srv;
let logs;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
beforeEach(() => { logs = captureLogs(); });
afterEach(() => logs.restore());

test("healthy: 200 { ok: true }, no cookie, no log line", async () => {
  const c = client(srv.baseUrl);
  const res = await c.get("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.headers.get("set-cookie"), null);
  // An /api request afterwards is logged; /health before it is not.
  await c.get("/api/me");
  await logs.waitFor("http.request", { route: "/api/me" });
  assert.deepEqual(logs.lines.map((l) => l.event), ["http.request"]);
});

test("a nearly full disk answers 503 and logs how much is free", async (t) => {
  t.mock.method(fs, "statfsSync", () => ({ bavail: 5, blocks: 100 }));
  const res = await client(srv.baseUrl).get("/health");
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false });
  const line = logs.find("health.failed", { reason: "disk_low", free_pct: 5 });
  assert.equal(line.level, "error");
});

test("a check that throws answers 503 without the error, which goes to the log", async (t) => {
  t.mock.method(fs, "statfsSync", () => { throw new Error("EIO: i/o error"); });
  const res = await client(srv.baseUrl).get("/health");
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false });
  const line = logs.find("health.failed", { reason: "error" });
  assert.equal(line.fields.err, "Error: EIO: i/o error");
});
