"use strict";

// GET /api/leaderboard — every active account with its record over finished
// games, and abandoned games two or more people played (a loss for each):
// games played (seats held) and games won while still playing the seat, top
// 100 by wins; those yet to play show 0 / 0 at the bottom. Sorting and the cut happen in SQL (queries.leaderboard).
// Mounted at /api/leaderboard.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json(queries.leaderboard.all());
});

module.exports = router;
