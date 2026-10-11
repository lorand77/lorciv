"use strict";

// Player stats for the profile page: the record behind a username, over the
// same games the leaderboard counts (queries.statsGames shares its rule), so
// the two pages never disagree. Public to any signed-in user: the leaderboard
// and the games lists already show all of it.
//
//   GET /api/stats        your own
//   GET /api/stats/:id    anyone's (a deactivated or deleted account is a 404)
//
// Both carry `you: true|false`, so the page can word things for the viewer.
// Mounted at /api/stats.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const { PLAYER_NAMES } = require("../shared/game");
const { SEATS } = require("../shared/settings");

const router = express.Router();
router.use(requireAuth);

const emptyRecord = () => ({ played: 0, wins: 0, losses: 0, abandoned: 0 });

// The win rate is wins over games played, as on the leaderboard: an abandoned
// game is a game not won.
const withRate = (r) => ({ ...r, winRate: r.played ? (r.wins / r.played) * 100 : null });

function statsFor(user) {
  const total = emptyRecord();
  // By the civ the seat plays (seat i is always PLAYER_NAMES[i]), and by
  // company: alone against the AI, or with other people at the table.
  const byCiv = Array.from({ length: SEATS }, emptyRecord);
  const company = { solo: emptyRecord(), people: emptyRecord() };

  for (const g of queries.statsGames.all(user.id)) {
    const bump = (rec) => {
      rec.played++;
      if (g.won) rec.wins++;
      else if (g.status === "aborted") rec.abandoned++;
      else rec.losses++;
    };
    bump(total);
    bump(byCiv[g.seat]);
    bump(g.people > 1 ? company.people : company.solo);
  }

  return {
    user: { id: user.id, username: user.username, createdAt: user.created_at },
    record: withRate(total),
    inProgress: queries.statsInProgress.get(user.id).n,
    byCiv: byCiv.map((rec, seat) => ({ seat, civ: PLAYER_NAMES[seat], ...withRate(rec) })),
    solo: withRate(company.solo),
    withPeople: withRate(company.people),
  };
}

router.get("/", (req, res) => {
  res.json({ ...statsFor(queries.getUserById.get(req.session.userId)), you: true });
});

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad user id." });
  const user = queries.getActiveUserById.get(id);
  if (!user) return res.status(404).json({ error: "No such player." });
  res.json({ ...statsFor(user), you: id === req.session.userId });
});

module.exports = router;
