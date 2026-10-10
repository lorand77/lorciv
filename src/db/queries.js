"use strict";

// Thin prepared-statement layer (no ORM). Statements are prepared once at load
// and reused — better-sqlite3 is synchronous, so callers use .get()/.run()/.all()
// directly. Keep all SQL here so the rest of the app stays SQL-free.

const db = require("./index");

module.exports = {
  // --- users ---
  createUser: db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)"),
  // Registration refuses a name that exists in any casing; login matches exactly.
  getUserByUsernameNoCase: db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  // Full row incl. password_hash — for login verification only.
  getUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  // Safe public view (no hash) — for /api/me and general lookups.
  getUserById: db.prepare("SELECT id, username, created_at FROM users WHERE id = ?"),
  // The same, but only while the account is active: what anyone other than
  // the user sees. Deactivated users are a 404.
  getActiveUserById: db.prepare(
    "SELECT id, username, created_at FROM users WHERE id = ? AND deactivated_at IS NULL"
  ),
  isDeactivated: db.prepare("SELECT 1 FROM users WHERE id = ? AND deactivated_at IS NOT NULL"),
  deactivateUser: db.prepare(
    "UPDATE users SET deactivated_at = datetime('now') WHERE id = ? AND deactivated_at IS NULL"
  ),
  reactivateUser: db.prepare(
    "UPDATE users SET deactivated_at = NULL WHERE id = ? AND deactivated_at IS NOT NULL"
  ),
  updatePassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
};
