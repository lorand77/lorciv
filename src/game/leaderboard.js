"use strict";

// GET /api/leaderboard — active accounts with their record over finished
// games: games played (seats held) and games won while still playing the
// seat, top 100 by wins. Sorting and the cut happen in SQL (queries.leaderboard).
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
