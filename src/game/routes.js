"use strict";

// REST side of games: creating one and listing them. Playing happens over the
// socket (src/game/socket.js); the rooms (src/game/rooms.js) hold the state.
// Mounted at /api/games.

const crypto = require("crypto");
const express = require("express");
const queries = require("../db/queries");
const rooms = require("./rooms");
const { requireAuth } = require("../auth/middleware");
const settings = require("../shared/settings");

const router = express.Router();

// The seats of a new game, or an error message. Today a game has exactly one
// human seat, the requester's; open seats for other people come with the
// lobby (M3). Kinds and difficulties are checked against the shared lists,
// never trusted.
function parseSeats(input, userId) {
  if (!Array.isArray(input) || input.length !== settings.SEATS) {
    return { error: `A game has ${settings.SEATS} seats.` };
  }
  const seats = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i] || {};
    if (s.kind !== "human" && s.kind !== "ai") return { error: "A seat is human or ai." };
    const difficulty = s.difficulty ?? "prince";
    if (!settings.DIFFICULTIES.includes(difficulty)) return { error: "Unknown difficulty." };
    seats.push({ seat: i, kind: s.kind, userId: s.kind === "human" ? userId : null, difficulty });
  }
  if (seats.filter((s) => s.kind === "human").length !== 1) {
    return { error: "Exactly one seat is yours; the others are AI for now." };
  }
  return { seats };
}

router.post("/", requireAuth, (req, res) => {
  const body = req.body || {};
  const parsed = parseSeats(body.seats, req.session.userId);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const turnTime = body.turnTime ?? settings.DEFAULT_TURN_TIME;
  if (!settings.turnTimeOf(turnTime)) return res.status(400).json({ error: "Unknown turn time." });
  const seed = Number.isInteger(body.seed) && body.seed >= 0 ? body.seed >>> 0 : crypto.randomInt(0, 0x7fffffff);

  const room = rooms.createGame({
    hostId: req.session.userId,
    seats: parsed.seats,
    seed,
    settings: { turnTime },
  });
  return res.status(201).json({ id: room.gameId });
});

router.get("/", requireAuth, (req, res) => {
  const rows = queries.listGamesForUser.all(req.session.userId);
  return res.json(rows.map((row) => ({ ...rooms.summary(row), mySeat: row.my_seat })));
});

// Anyone signed in may look at any game: spectating is open.
router.get("/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? queries.getGameById.get(id) : null;
  if (!row) return res.status(404).json({ error: "No such game." });
  const mine = queries.getSeats.all(id).find((s) => s.user_id === req.session.userId);
  return res.json({ ...rooms.summary(row), seed: row.seed, settings: JSON.parse(row.settings), mySeat: mine ? mine.seat : null });
});

module.exports = router;
