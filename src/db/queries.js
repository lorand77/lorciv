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

  // --- games (src/game/rooms.js, src/game/routes.js) ---
  createGame: db.prepare(`
    INSERT INTO games (status, host_id, seed, settings, snapshot, seq, turn, current_seat, started_at)
    VALUES ('active', ?, ?, ?, ?, 0, 1, 0, datetime('now'))
  `),
  insertSeat: db.prepare(`
    INSERT INTO game_seats (game_id, seat, kind, user_id, difficulty, joined_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
  `),
  getGameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  // Seats with the player's name; the AI seats have none.
  getSeats: db.prepare(`
    SELECT s.seat, s.kind, s.user_id, s.difficulty, s.missed_turns, u.username
    FROM game_seats s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.game_id = ? ORDER BY s.seat
  `),
  // The games a user holds a seat in, newest activity first.
  listGamesForUser: db.prepare(`
    SELECT g.id, g.status, g.turn, g.current_seat, g.winner_seat, g.created_at, g.updated_at,
           s.seat AS my_seat
    FROM games g JOIN game_seats s ON s.game_id = g.id AND s.user_id = ?
    ORDER BY g.updated_at DESC, g.id DESC
  `),
  // One action's writes: the new snapshot and the row's summary columns.
  saveGameState: db.prepare(`
    UPDATE games SET snapshot = ?, seq = ?, turn = ?, current_seat = ?, status = ?, winner_seat = ?,
      finished_at = CASE WHEN ? = 'finished' AND finished_at IS NULL THEN datetime('now') ELSE finished_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `),
  insertAction: db.prepare(
    "INSERT INTO game_actions (game_id, seq, seat, user_id, action) VALUES (?, ?, ?, ?, ?)"
  ),
  listActions: db.prepare(
    "SELECT seq, seat, user_id, action, created_at FROM game_actions WHERE game_id = ? ORDER BY seq"
  ),
};
