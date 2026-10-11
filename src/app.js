"use strict";

// Builds the Express app and the HTTP server, with Socket.IO attached, but
// does not listen. src/server.js is the entry point that listens; the
// integration tests boot the very same thing on a random port.

const crypto = require("crypto");
const http = require("http");
const path = require("path");
const express = require("express");
const log = require("./log");
const sessionMiddleware = require("./auth/session");
const authRoutes = require("./auth/routes");
const gameRoutes = require("./game/routes");
const leaderboardRoutes = require("./game/leaderboard");
const { attachSockets } = require("./game/socket");
const rooms = require("./game/rooms");

// At or over this, a request is logged as a warning.
const SLOW_MS = 1000;

// One http.request line per /api request, written once the response is done
// or the client gave up, and req.log for the handlers, which carries the same
// request id. The user is read again at the end: login creates it, logout
// ends it. See "Logging" in docs/design.md.
function requestLog(req, res, next) {
  const started = performance.now();
  const user = req.session.userId;
  const name = req.session.username;
  req.log = log.child({ req: crypto.randomBytes(4).toString("hex"), user, name });
  res.on("close", () => {
    const status = res.statusCode;
    const ms = Math.round(performance.now() - started);
    const level = status >= 500 ? "error" : ms >= SLOW_MS ? "warn" : "info";
    req.log[level]("http.request", {
      user: req.session?.userId ?? user,
      name: req.session?.username ?? name,
      method: req.method,
      // The pattern, never the URL: lines group by endpoint and nothing the
      // client put in the path or query string is written.
      route: req.route && req.mount ? req.mount + String(req.route.path) : "unmatched",
      status,
      ms,
      aborted: res.writableFinished ? undefined : true,
    });
  });
  next();
}

// Errors no handler dealt with: Express 5 passes thrown errors and rejected
// promises here. Logged with the request id and the stack, answered with
// neither. Express's own handler would print to stderr, outside the log.
// body-parser's errors (malformed JSON, oversized body) are the client's.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) (req.log || log).error("http.unhandled", { err });
  res.status(status).json({ error: status === 500 ? "Server error." : "Bad request." });
}

function createServer() {
  const app = express();

  // Behind a TLS-terminating reverse proxy in prod (Caddy on the EC2 server).
  // Trust one proxy hop so req.secure reflects the real HTTPS connection via
  // X-Forwarded-Proto — required for the session cookie's secure:"auto" to
  // activate over HTTPS.
  app.set("trust proxy", 1);

  // --- API: JSON body parsing, sessions, routers ---
  app.use(sessionMiddleware);
  app.use("/api", requestLog);
  app.use(express.json());
  // Routers are mounted through here so the request log can name the route
  // even after an error has left its router (Express resets req.baseUrl on
  // the way out).
  const api = (mount, router) =>
    app.use(mount, (req, res, next) => { req.mount = mount; next(); }, router);
  api("/api", authRoutes);
  api("/api/games", gameRoutes);
  api("/api/leaderboard", leaderboardRoutes);

  // --- Static assets ---
  // One copy of the game engine, in src/shared, served at /js/*. Mounted before
  // the public static handler so /js/game.js resolves here while /js/shell.js
  // and the other page scripts fall through to public/js (see docs/design.md).
  app.use("/js", express.static(path.join(__dirname, "shared")));

  // Static UI (login.html, lobby.html, css, assets, public/js/*).
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(errorHandler);

  // Wrap Express in an http.Server so Socket.IO can share the same port.
  const server = http.createServer(app);
  const io = attachSockets(server);
  app.set("io", io); // Auth routes revoke sockets when their session ends.
  // Every active game comes back into memory now, so turn timers run whether
  // or not anyone opens the game, and the sweeps start.
  rooms.resumeAll();
  return { app, server, io };
}

module.exports = { createServer };
