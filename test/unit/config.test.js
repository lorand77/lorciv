"use strict";

// src/config.js reads its settings from the environment when loaded, so each
// case here loads a fresh copy under a controlled environment.

const path = require("path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG = require.resolve("../../src/config");
const VARS = [
  "PORT", "SESSION_SECRET", "DB_PATH", "DEACTIVATION_SWEEP_MS",
  "AUTH_WINDOW_MS", "LOGIN_MAX_FAILURES", "REGISTER_MAX", "HASH_MAX_CONCURRENT", "LOG_LEVEL",
];

function loadConfig(env = {}) {
  const saved = {};
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  Object.assign(process.env, env);
  delete require.cache[CONFIG];
  try {
    return require(CONFIG);
  } finally {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    delete require.cache[CONFIG];
  }
}

describe("config", () => {
  test("defaults when nothing is set", () => {
    const c = loadConfig();
    assert.equal(c.PORT, 3000);
    assert.equal(c.SESSION_SECRET, "dev-insecure-secret-change-me");
    assert.equal(c.DB_PATH, path.resolve(__dirname, "../../data/lorciv.sqlite"));
    assert.equal(c.DEACTIVATION_SWEEP_MS, 30000);
    assert.equal(c.AUTH_WINDOW_MS, 900000);
    assert.equal(c.LOGIN_MAX_FAILURES, 10);
    assert.equal(c.REGISTER_MAX, 5);
    assert.equal(c.HASH_MAX_CONCURRENT, 2);
    assert.equal(c.LOG_LEVEL, "info");
  });

  test("environment overrides are parsed as integers", () => {
    const c = loadConfig({
      PORT: "8080", SESSION_SECRET: "s3cret", DB_PATH: "/tmp/x.sqlite",
      DEACTIVATION_SWEEP_MS: "5000", AUTH_WINDOW_MS: "60000",
      LOGIN_MAX_FAILURES: "3", REGISTER_MAX: "1", HASH_MAX_CONCURRENT: "4",
      LOG_LEVEL: "debug",
    });
    assert.equal(c.PORT, 8080);
    assert.equal(c.SESSION_SECRET, "s3cret");
    assert.equal(c.DB_PATH, "/tmp/x.sqlite");
    assert.equal(c.DEACTIVATION_SWEEP_MS, 5000);
    assert.equal(c.AUTH_WINDOW_MS, 60000);
    assert.equal(c.LOGIN_MAX_FAILURES, 3);
    assert.equal(c.REGISTER_MAX, 1);
    assert.equal(c.HASH_MAX_CONCURRENT, 4);
    assert.equal(c.LOG_LEVEL, "debug");
  });

  test("unparseable numbers fall back to the defaults", () => {
    const c = loadConfig({ PORT: "eighty", DEACTIVATION_SWEEP_MS: "", REGISTER_MAX: "many" });
    assert.equal(c.PORT, 3000);
    assert.equal(c.DEACTIVATION_SWEEP_MS, 30000);
    assert.equal(c.REGISTER_MAX, 5);
  });

  test("an explicit 0 survives for every numeric setting", () => {
    const c = loadConfig({ PORT: "0", DEACTIVATION_SWEEP_MS: "0", LOGIN_MAX_FAILURES: "0" });
    assert.equal(c.PORT, 0);
    assert.equal(c.DEACTIVATION_SWEEP_MS, 0);
    assert.equal(c.LOGIN_MAX_FAILURES, 0);
  });
});
