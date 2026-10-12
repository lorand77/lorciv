"use strict";

// Achievements API: what a player has earned, for the profile's Achievements
// tab. Public to any signed-in user, like the rest of a profile.
//
//   GET /api/achievements        your own
//   GET /api/achievements/:id    anyone's (a deactivated or deleted account is a 404)
//
// Both answer { earned: [{ key, tier, earnedAt, gameId }], progress }, where
// progress holds the counts behind the tiered achievements. The catalogue
// (names, icons, thresholds) is src/shared/achievements.js, served at
// /js/achievements.js. Mounted at /api/achievements.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const achievements = require("./service");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json(achievements.listFor(req.session.userId));
});

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad user id." });
  if (!queries.getActiveUserById.get(id)) return res.status(404).json({ error: "No such player." });
  res.json(achievements.listFor(id));
});

module.exports = router;
