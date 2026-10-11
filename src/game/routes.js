"use strict";

// REST side of games: tables in the lobby (create, take or give up a seat,
// start, cancel) and the lists the lobby page shows. Playing happens over the
// socket (src/game/socket.js); the rooms (src/game/rooms.js) hold the state.
// Mounted at /api/games.

const crypto = require("crypto");
const express = require("express");
const queries = require("../db/queries");
const rooms = require("./rooms");
const { requireAuth } = require("../auth/middleware");
const settings = require("../shared/settings");

const router = express.Router();
router.use(requireAuth);

// The seats of a new table, or an error message. Exactly one seat is the
// requester's; the others are open (for someone in the lobby) or AI with a
// difficulty. Kinds and difficulties are checked against the shared lists.
function parseSeats(input, userId) {
  if (!Array.isArray(input) || input.length !== settings.SEATS) {
    return { error: `A game has ${settings.SEATS} seats.` };
  }
  const seats = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i] || {};
    if (!["human", "open", "ai"].includes(s.kind)) return { error: "A seat is human, open or ai." };
    const difficulty = s.difficulty ?? "prince";
    if (!settings.DIFFICULTIES.includes(difficulty)) return { error: "Unknown difficulty." };
    // A difficulty is the AI's handicap. On a human or open seat it would hand
    // a person the AI's bonuses (the form never sends one; a hand-made request
    // could), so those seats are always prince.
    seats.push({ seat: i, kind: s.kind, userId: s.kind === "human" ? userId : null, difficulty: s.kind === "ai" ? difficulty : "prince" });
  }
  if (seats.filter((s) => s.kind === "human").length !== 1) {
    return { error: "Exactly one seat is yours." };
  }
  return { seats };
}

// How a rooms.js refusal answers over HTTP.
const STATUS = {
  no_such_game: 404, no_such_seat: 404, not_lobby: 409, seat_taken: 409, already_seated: 409,
  not_host: 403, not_yours: 403, host: 409, in_progress: 403,
};
const MESSAGE = {
  no_such_game: "No such game.", no_such_seat: "No such seat.", not_lobby: "That game has started.",
  seat_taken: "That seat is taken.", already_seated: "You already have a seat in this game.",
  not_host: "Only the host can do that.", not_yours: "That is not your seat.",
  host: "The host cannot leave; cancel the table instead.",
  in_progress: "The replay opens when the game is over.",
};
function refuse(res, error) {
  return res.status(STATUS[error] ?? 400).json({ error: MESSAGE[error] ?? "Refused." });
}

function withMine(row, userId) {
  const mine = queries.getSeats.all(row.id).find((s) => s.user_id === userId);
  return { ...rooms.summary(row), seed: row.seed, mySeat: mine ? mine.seat : null };
}

router.post("/", (req, res) => {
  const body = req.body || {};
  const parsed = parseSeats(body.seats, req.session.userId);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const turnTime = body.turnTime ?? settings.DEFAULT_TURN_TIME;
  if (!settings.turnTimeOf(turnTime)) return res.status(400).json({ error: "Unknown turn time." });
  const seed = Number.isInteger(body.seed) && body.seed >= 0 ? body.seed >>> 0 : crypto.randomInt(0, 0x7fffffff);

  const { gameId, status } = rooms.createGame({
    hostId: req.session.userId,
    seats: parsed.seats,
    seed,
    settings: { turnTime },
  });
  return res.status(201).json({ id: gameId, status });
});

// The games and tables the user holds a seat in, newest activity first.
router.get("/", (req, res) => {
  const rows = queries.listGamesForUser.all(req.session.userId);
  return res.json(rows.map((row) => ({ ...rooms.summary(row), mySeat: row.my_seat })));
});

// Tables with an open seat.
router.get("/open", (req, res) => {
  return res.json(queries.listOpenTables.all().map((row) => withMine(row, req.session.userId)));
});

// Games being played, to watch.
router.get("/live", (req, res) => {
  return res.json(queries.listLiveGames.all().map((row) => withMine(row, req.session.userId)));
});

// Anyone signed in may look at any game: spectating is open.
router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? queries.getGameById.get(id) : null;
  if (!row) return refuse(res, "no_such_game");
  return res.json(withMine(row, req.session.userId));
});

// Everything the replay page needs to rebuild a game: the setup the engine
// started from (kept in every snapshot) and the recorded actions. Tables have
// no snapshot and nothing to replay. A game still being played has none
// either: its history, step by step, is something a player could study
// against the people still playing it.
router.get("/:id/replay", (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? queries.getGameById.get(id) : null;
  if (!row || !row.snapshot) return refuse(res, "no_such_game");
  if (row.status === "active") return refuse(res, "in_progress");
  return res.json({
    ...withMine(row, req.session.userId),
    setup: JSON.parse(row.snapshot).setup,
    actions: queries.listActions.all(id).map((a) => ({ seq: a.seq, seat: a.seat, action: JSON.parse(a.action), at: a.created_at })),
  });
});

function seatParams(req) {
  const id = Number(req.params.id);
  const seat = Number(req.params.seat);
  return { id: Number.isInteger(id) ? id : -1, seat: Number.isInteger(seat) ? seat : -1 };
}

router.post("/:id/seats/:seat/join", (req, res) => {
  const { id, seat } = seatParams(req);
  const user = queries.getUserById.get(req.session.userId);
  const out = rooms.joinSeat(id, seat, user);
  if (out.error) return refuse(res, out.error);
  return res.json(withMine(queries.getGameById.get(id), req.session.userId));
});

router.post("/:id/seats/:seat/leave", (req, res) => {
  const { id, seat } = seatParams(req);
  const out = rooms.leaveSeat(id, seat, req.session.userId);
  if (out.error) return refuse(res, out.error);
  return res.json(withMine(queries.getGameById.get(id), req.session.userId));
});

router.post("/:id/start", (req, res) => {
  const id = Number(req.params.id);
  const out = rooms.startGame(Number.isInteger(id) ? id : -1, req.session.userId);
  if (out.error) return refuse(res, out.error);
  return res.json({ id, status: "active" });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const out = rooms.cancelTable(Number.isInteger(id) ? id : -1, req.session.userId);
  if (out.error) return refuse(res, out.error);
  return res.json({ ok: true });
});

module.exports = router;
