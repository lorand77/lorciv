"use strict";

const path = require("path");

// An integer setting from the environment. Unlike `parseInt(x) || fallback`,
// this keeps an explicit 0 or a negative number, so a setting can give them a
// meaning. Unset or unparseable values fall back to the default.
function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// Central place for env-driven constants. Everything the environment can set
// is declared here; nothing else reads process.env.
module.exports = {
  PORT: intEnv("PORT", 3000),

  // Signs the session cookie. MUST be overridden in production via env.
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",

  // Single-file SQLite database (created on first run).
  DB_PATH: process.env.DB_PATH || path.join(__dirname, "..", "data", "lorciv.sqlite"),

  // How often the server disconnects sockets of accounts deactivated from the
  // command line (see src/game/socket.js).
  DEACTIVATION_SWEEP_MS: intEnv("DEACTIVATION_SWEEP_MS", 30000),

  // Brute-force and CPU limits on /api/login and /api/register (see
  // src/auth/throttle.js): failed logins and new accounts allowed per client
  // IP within the window, and how many argon2 hashes or verifies may run at
  // once — one per vCPU on the documented server. Past that cap a request is
  // turned away with 503 instead of queueing behind the others.
  AUTH_WINDOW_MS: intEnv("AUTH_WINDOW_MS", 15 * 60 * 1000),
  LOGIN_MAX_FAILURES: intEnv("LOGIN_MAX_FAILURES", 10),
  REGISTER_MAX: intEnv("REGISTER_MAX", 5),
  HASH_MAX_CONCURRENT: intEnv("HASH_MAX_CONCURRENT", 2),

  // How much the server logs: silent, error, warn, info or debug (src/log.js).
  // An unknown value logs a warning and falls back to info.
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
};
