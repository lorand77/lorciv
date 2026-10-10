"use strict";

// The session middleware, built once and exported so it can be shared between
// Express and the Socket.IO handshake — one auth mechanism for both.
// The store comes from better-sqlite3-session-store, which is GPL-3.0-only
// (see docs/licenses.md); keep it a dependency, never copy its code here.

const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const db = require("../db/index");
const config = require("../config");

// The upstream store never unref's its expiry-sweep timer, so that timer alone
// would hold the process open once the server has closed (a graceful shutdown,
// or a test run). Same sweep, but it no longer keeps the process alive.
class Store extends SqliteStore {
  startInterval() {
    this.expiredTimer = setInterval(this.clearExpiredSessions.bind(this), this.expired.intervalMs);
    this.expiredTimer.unref();
  }
}

const sessionMiddleware = session({
  store: new Store({
    client: db,
    // Periodically purge expired rows from the sessions table.
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,           // not readable from JS — mitigates XSS theft
    sameSite: "lax",
    secure: "auto",           // secure over HTTPS (prod, via trust proxy); off on localhost HTTP
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

module.exports = sessionMiddleware;
