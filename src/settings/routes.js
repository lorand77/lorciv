"use strict";

// Per-user display settings: for now only the colour scheme, dark or light.
// LorChess's board colours and uploaded images have no counterpart here (the
// map is fixed terrain art), so only the scheme was copied. Settings are a
// small JSON blob on the users row (users.prefs, NULL for the defaults);
// public/js/theme.js applies them on every page with the shell.
//
//   GET /api/settings    -> { scheme }
//   PUT /api/settings    { scheme }   ("dark" or "light")
//
// Mounted at /api/settings.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");

const router = express.Router();
router.use(requireAuth);

const DEFAULTS = { scheme: "dark" };
const SCHEMES = new Set(["dark", "light"]);

// What is stored, with anything unknown or malformed replaced by the default.
function readPrefs(userId) {
  let stored = {};
  try {
    stored = JSON.parse(queries.getUserPrefs.get(userId).prefs || "{}") || {};
  } catch {
    stored = {};
  }
  const prefs = { ...DEFAULTS };
  if (SCHEMES.has(stored.scheme)) prefs.scheme = stored.scheme;
  return prefs;
}

router.get("/", (req, res) => res.json(readPrefs(req.session.userId)));

router.put("/", (req, res) => {
  const uid = req.session.userId;
  const body = req.body || {};
  const prefs = readPrefs(uid);
  if (body.scheme !== undefined) {
    if (!SCHEMES.has(body.scheme)) {
      return res.status(400).json({ error: 'scheme must be "dark" or "light".' });
    }
    prefs.scheme = body.scheme;
  }
  queries.setUserPrefs.run(JSON.stringify(prefs), uid);
  res.json(prefs);
});

module.exports = router;
