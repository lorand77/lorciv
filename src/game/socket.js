"use strict";

// Socket.IO infrastructure and the game events. The handshake reuses the SAME
// Express session (io.engine.use), every incoming event re-checks that
// session, and every handler runs under a try/catch so one failure cannot
// take the process down. This module owns every Socket.IO event; the rooms
// (rooms.js) own the state (see docs/design.md, "The game on the server").

const { Server } = require("socket.io");
const log = require("../log");
const sessionMiddleware = require("../auth/session");
const queries = require("../db/queries");
const config = require("../config");
const rooms = require("./rooms");

// Everyone looking at a game, players and spectators, sits in this room and
// receives every state broadcast and every chat message.
const gameRoom = (gameId) => `game:${gameId}`;
// Everyone on the lobby page: told when the lists changed, and who is about.
const LOBBY = "lobby";
const CHAT_MAX = 300;
const CHAT_HISTORY = 50;

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

  // rooms.js knows nothing about sockets; it says what happened and this
  // module tells the people concerned.
  rooms.events.on("state", (room) => broadcastState(io, room));
  rooms.events.on("lobby", () => io.to(LOBBY).emit("lobby:changed"));
  rooms.events.on("turn", (room) => {
    const s = room.seats[room.game.currentPlayer];
    if (s && s.kind === "human") {
      io.to(userRoom(s.userId)).emit("turn:yours", { gameId: room.gameId, deadline: room.deadline });
    }
  });

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

    on("lobby:enter", () => { socket.join(LOBBY); sendPresence(io); });
    on("game:join", (payload, ack) => handleJoin(io, socket, payload, ack));
    on("game:action", (payload, ack) => handleAction(io, socket, payload, ack));
    on("game:leave", (payload, ack) => handleLeave(io, socket, payload, ack));
    on("chat:send", (payload, ack) => handleChat(io, socket, payload, ack));

    on("disconnect", (reason) => {
      socket.log.info("socket.disconnect", { reason });
      sendPresence(io);
    });
  });

  return io;
}

function roomFor(payload) {
  const gameId = Number(payload?.gameId);
  return Number.isInteger(gameId) ? rooms.getRoom(gameId) : null;
}

// Who is on the lobby page, once per person however many tabs.
function sendPresence(io) {
  const ids = io.sockets.adapter.rooms.get(LOBBY);
  const seen = new Map();
  for (const id of ids ?? []) {
    const s = io.sockets.sockets.get(id);
    if (s && !seen.has(s.userId)) seen.set(s.userId, { userId: s.userId, username: s.username });
  }
  io.to(LOBBY).emit("lobby:presence", [...seen.values()]);
}

// Join a game's room and get its full state plus the recent chat. A user with
// a seat plays; anyone else watches (mySeat null). The same event resumes after
// a reload or a reconnect, so the client never needs a separate "catch me up".
function handleJoin(io, socket, payload, ack) {
  const room = roomFor(payload);
  if (!room) {
    const gameId = Number(payload?.gameId);
    const row = Number.isInteger(gameId) ? queries.getGameById.get(gameId) : null;
    return reply(ack, { ok: false, error: row && row.status === "lobby" ? "not_started" : "no_such_game" });
  }
  socket.join(gameRoom(room.gameId));
  socket.log.debug("game.join", { game: room.gameId, seat: rooms.seatOf(room, socket.userId) });
  const state = rooms.viewFor(room, socket.userId);
  state.chat = queries.listChat.all(room.gameId, CHAT_HISTORY).reverse().map(chatView);
  reply(ack, { ok: true, state });
}

// A player hands their seat to the AI for good.
function handleLeave(io, socket, payload, ack) {
  const room = roomFor(payload);
  if (!room) return reply(ack, { ok: false, error: "no_such_game" });
  reply(ack, rooms.leaveGame(room, socket.userId));
}

const chatView = (m) => ({ id: m.id, userId: m.user_id, username: m.username, text: m.text, at: m.created_at });

// Chat goes to everyone in the game's room, players and spectators alike; the
// sender must have joined the game. The text is never logged.
function handleChat(io, socket, payload, ack) {
  const room = roomFor(payload);
  if (!room) return reply(ack, { ok: false, error: "no_such_game" });
  if (!socket.rooms.has(gameRoom(room.gameId))) return reply(ack, { ok: false, error: "not_joined" });
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text || text.length > CHAT_MAX) return reply(ack, { ok: false, error: "bad_text" });
  const info = queries.insertChat.run(room.gameId, socket.userId, text);
  const msg = chatView(queries.getChatById.get(Number(info.lastInsertRowid)));
  io.to(gameRoom(room.gameId)).emit("chat:message", { gameId: room.gameId, ...msg });
  reply(ack, { ok: true });
}

// A player's action: seat, freshness, then the shared validator inside
// rooms.applyPlayerAction. `seq` is the state the client acted on; a stale one
// is refused and that client is re-synced, so nobody acts on an old view.
function handleAction(io, socket, payload, ack) {
  const room = roomFor(payload);
  if (!room) return reply(ack, { ok: false, error: "no_such_game" });
  const seat = rooms.seatOf(room, socket.userId);
  if (seat === null) return reply(ack, { ok: false, error: "not_seated" });
  if (payload.seq !== room.seq) {
    reply(ack, { ok: false, error: "stale", seq: room.seq });
    socket.emit("game:state", rooms.viewFor(room, socket.userId));
    return;
  }
  const action = {
    type: payload.type, unitId: payload.unitId, cityId: payload.cityId,
    q: payload.q, r: payload.r, key: payload.key,
  };
  // On success rooms.js emits "state" and the room is broadcast from there.
  reply(ack, rooms.applyPlayerAction(room, seat, socket.userId, action));
}

// Each socket gets its own view (rooms.viewFor), so a per-seat filter such as
// fog of war would change nothing here.
function broadcastState(io, room) {
  const ids = io.sockets.adapter.rooms.get(gameRoom(room.gameId));
  if (!ids) return;
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s) s.emit("game:state", rooms.viewFor(room, s.userId));
  }
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
