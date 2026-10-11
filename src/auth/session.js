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

// The cookie, as express-session sets it and logout clears it. `secure` is
// "auto" in development (set only over HTTPS) and always on in production,
// where the __Host- name requires it (see SESSION_COOKIE in src/config.js): a
// request that reached the app over plain HTTP gets no cookie at all.
const COOKIE = {
  httpOnly: true,           // not readable from JS — mitigates XSS theft
  sameSite: "lax",
  secure: config.PRODUCTION ? true : "auto",
  path: "/",
};

const sessionMiddleware = session({
  store: new Store({
    client: db,
    // Periodically purge expired rows from the sessions table.
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  name: config.SESSION_COOKIE,
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    ...COOKIE,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

module.exports = sessionMiddleware;
// For res.clearCookie, which needs a boolean: a __Host- cookie is only
// overwritten by one that is Secure too.
module.exports.clearOptions = { ...COOKIE, secure: config.PRODUCTION };
