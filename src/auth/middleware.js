"use strict";

// Gate for REST routes that require a logged-in user. Pages protect themselves
// client-side by calling /api/me and redirecting on 401 (see public/js/authGuard.js).
// A deactivated account is refused even with a live session: the deactivate
// command deletes its sessions, but a login racing it could still create one.

const queries = require("../db/queries");

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required." });
  }
  if (queries.isDeactivated.get(req.session.userId)) {
    return res.status(401).json({ error: "This account has been deactivated." });
  }
  return next();
}

module.exports = { requireAuth };
