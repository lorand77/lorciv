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
  // A game starts life as a table in the lobby; startGame makes it active.
  createTable: db.prepare("INSERT INTO games (status, host_id, seed, settings) VALUES ('lobby', ?, ?, ?)"),
  insertSeat: db.prepare(`
    INSERT INTO game_seats (game_id, seat, kind, user_id, difficulty, joined_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
  `),
  takeSeat: db.prepare(`
    UPDATE game_seats SET kind = 'human', user_id = ?, joined_at = datetime('now')
    WHERE game_id = ? AND seat = ? AND kind = 'open'
  `),
  releaseSeat: db.prepare(
    "UPDATE game_seats SET kind = 'open', user_id = NULL, joined_at = NULL WHERE game_id = ? AND seat = ?"
  ),
  // Open seats left at the start are played by the server at the easiest level.
  fillOpenSeats: db.prepare(
    "UPDATE game_seats SET kind = 'ai', difficulty = 'prince' WHERE game_id = ? AND kind = 'open'"
  ),
  // A human seat handed to the AI keeps its user_id, so the game stays in that
  // person's list and the record says who sat there.
  setSeatKind: db.prepare("UPDATE game_seats SET kind = ? WHERE game_id = ? AND seat = ?"),
  setMissedTurns: db.prepare("UPDATE game_seats SET missed_turns = ? WHERE game_id = ? AND seat = ?"),
  startGame: db.prepare(`
    UPDATE games SET status = 'active', snapshot = ?, seq = 0, turn = ?, current_seat = ?, turn_deadline = ?,
      started_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status = 'lobby'
  `),
  abortGame: db.prepare(`
    UPDATE games SET status = 'aborted', finished_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status IN ('lobby', 'active')
  `),
  getGameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  // Tables in the lobby with at least one open seat, newest first.
  listOpenTables: db.prepare(`
    SELECT g.* FROM games g
    WHERE g.status = 'lobby' AND EXISTS (SELECT 1 FROM game_seats s WHERE s.game_id = g.id AND s.kind = 'open')
    ORDER BY g.created_at DESC LIMIT 50
  `),
  // Games being played, for the lobby's watch list.
  listLiveGames: db.prepare("SELECT * FROM games WHERE status = 'active' ORDER BY updated_at DESC LIMIT 50"),
  // Every active game, rebuilt into memory at boot so turn timers run.
  listActiveGameIds: db.prepare("SELECT id FROM games WHERE status = 'active'"),
  // Tables and games nobody has touched for a while; param like '-30 days'.
  sweepAbandoned: db.prepare(`
    UPDATE games SET status = 'aborted', finished_at = datetime('now'), updated_at = datetime('now')
    WHERE status IN ('lobby', 'active') AND updated_at < datetime('now', ?)
  `),
  listAbandonable: db.prepare(
    "SELECT id FROM games WHERE status IN ('lobby', 'active') AND updated_at < datetime('now', ?)"
  ),
  // Seats with the player's name; the AI seats have none.
  getSeats: db.prepare(`
    SELECT s.seat, s.kind, s.user_id, s.difficulty, s.missed_turns, u.username
    FROM game_seats s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.game_id = ? ORDER BY s.seat
  `),
  // The games a user holds a seat in, newest activity first.
  listGamesForUser: db.prepare(`
    SELECT g.*, s.seat AS my_seat
    FROM games g JOIN game_seats s ON s.game_id = g.id AND s.user_id = ?
    ORDER BY g.updated_at DESC, g.id DESC
  `),
  // One action's writes: the new snapshot and the row's summary columns.
  saveGameState: db.prepare(`
    UPDATE games SET snapshot = ?, seq = ?, turn = ?, current_seat = ?, status = ?, winner_seat = ?, turn_deadline = ?,
      finished_at = CASE WHEN ? IN ('finished', 'aborted') AND finished_at IS NULL THEN datetime('now') ELSE finished_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `),
  insertAction: db.prepare(
    "INSERT INTO game_actions (game_id, seq, seat, user_id, action) VALUES (?, ?, ?, ?, ?)"
  ),
  listActions: db.prepare(
    "SELECT seq, seat, user_id, action, created_at FROM game_actions WHERE game_id = ? ORDER BY seq"
  ),

  // --- chat ---
  insertChat: db.prepare("INSERT INTO chat_messages (game_id, user_id, text) VALUES (?, ?, ?)"),
  // The latest N messages of a game, newest first (the caller reverses them).
  listChat: db.prepare(`
    SELECT m.id, m.user_id, u.username, m.text, m.created_at
    FROM chat_messages m JOIN users u ON u.id = m.user_id
    WHERE m.game_id = ? ORDER BY m.id DESC LIMIT ?
  `),
  getChatById: db.prepare(`
    SELECT m.id, m.game_id, m.user_id, u.username, m.text, m.created_at
    FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `),
  // Chat of games that ended before the cutoff; param like '-30 days'.
  deleteOldChat: db.prepare(`
    DELETE FROM chat_messages WHERE game_id IN (
      SELECT id FROM games WHERE status IN ('finished', 'aborted') AND finished_at < datetime('now', ?)
    )
  `),
};
