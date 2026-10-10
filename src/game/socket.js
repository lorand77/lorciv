"use strict";

// Socket.IO infrastructure: the handshake reuses the SAME Express session
// (io.engine.use), every incoming event re-checks that session, and every
// handler runs under a try/catch so one failure cannot take the process down.
//
// The game events (joining a game, acting, watching) are registered here too,
// as they are built: this module owns every Socket.IO event, and the modules
// it calls own the state (see docs/design.md).

const { Server } = require("socket.io");
const log = require("../log");
const sessionMiddleware = require("../auth/session");
const queries = require("../db/queries");
const config = require("../config");

// One room per user, so a message for a person reaches every tab they have
// open instead of whichever socket we happened to pick.
const userRoom = (userId) => `user:${userId}`;

// Engine.IO may have loaded the cookie before logout, and an established
// connection may outlive its session. Check the store without saving/touching
// it so a stale socket cannot recreate or extend a revoked/expired session.
function reloadSocketSession(socket, done) {
  const session = socket.request.session;
  if (!session || !session.userId) return done(new Error("unauthorized"));
  session.reload((err) => {
    const current = socket.request.session;
    if (
      err || !current.userId ||
      (socket.userId != null && current.userId !== socket.userId) ||
      queries.isDeactivated.get(current.userId)
    ) {
      return done(new Error("unauthorized"));
    }
    done(null, current);
  });
}

function attachSockets(httpServer) {
  const io = new Server(httpServer);

  // `npm run user:deactivate` runs in another process and cannot reach these
  // sockets. An idle one never sends the event that would re-check it, so
  // sweep them. unref'd so it never holds the process open by itself.
  setInterval(() => safely("deactivation sweep", () => {
    for (const socket of io.of("/").sockets.values()) {
      if (queries.isDeactivated.get(socket.userId)) socket.disconnect(true);
    }
  }), config.DEACTIVATION_SWEEP_MS).unref();

  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    reloadSocketSession(socket, (err, session) => {
      if (err) return next(err);
      socket.userId = session.userId;
      socket.username = session.username;
      socket.log = log.child({ user: session.userId, name: session.username });
      next();
    });
  });

  io.on("connection", (socket) => {
    // All tabs sharing a cookie leave together; another login on the same
    // account has its own session room and stays connected.
    socket.join(`session:${socket.request.sessionID}`);
    socket.use((_packet, next) => {
      reloadSocketSession(socket, (err) => {
        if (err) return socket.disconnect(true);
        next();
      });
    });
    socket.log.info("socket.connect");
    socket.emit("welcome", { userId: socket.userId, username: socket.username });
    socket.join(userRoom(socket.userId));

    // Socket.IO runs listeners with no try/catch of its own, so an exception
    // in a handler (better-sqlite3 raises synchronously) would take the whole
    // process down, and every live game with it. Log it, fail the caller's
    // acknowledgement if there is one, and carry on.
    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        try {
          handler(payload, ack);
        } catch (err) {
          socket.log.error("socket.handler_failed", { event, err });
          reply(ack, { ok: false, error: "Server error." });
        }
      });
    };

    on("disconnect", (reason) => socket.log.info("socket.disconnect", { reason }));
  });

  return io;
}

function reply(ack, obj) {
  if (typeof ack === "function") ack(obj);
}

// Timer callbacks and the connection setup run outside the per-event wrapper
// in attachSockets; the same rule applies to them: log, never crash.
function safely(label, fn) {
  try {
    fn();
  } catch (err) {
    log.error("socket.task_failed", { task: label, err });
  }
}

module.exports = { attachSockets, reply, safely, userRoom };
