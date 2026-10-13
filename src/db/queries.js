"use strict";

// Thin prepared-statement layer (no ORM). Statements are prepared once at load
// and reused — better-sqlite3 is synchronous, so callers use .get()/.run()/.all()
// directly. Keep all SQL here so the rest of the app stays SQL-free.

const db = require("./index");

// A seat `s` in a game `g` whose civ was eliminated, as of the game's last
// snapshot (civs are indexed by seat). The server aborts a game once no human
// civ is left in it, so being wiped out ends a game without a winner.
const ELIMINATED = "json_extract(g.snapshot, '$.game.civs[' || s.seat || '].isEliminated') = 1";

// A seat `s` in a game `g` that counts for the player's record, on the
// leaderboard and on their profile alike. A finished game counts; so does an
// abandoned one (aborted after it started) that two or more people played, as
// a loss for each of them: walking out on other people is not a way to keep a
// defeat off the board. So does an abandoned game in which the seat's civ was
// eliminated, solo or not: that is a loss, not a walk-out. Any other solo game
// abandoned does not count, nor a table cancelled before it started. user_id
// stays on a seat the AI took over, so those who left are counted.
//
// "Played" means made a move: an action row of theirs other than a leave (the
// server's timeouts have no user). Someone who never moved, whose turns ran
// out until the AI took the seat, has not played the game, so it is no loss of
// theirs and does not make an abandoned game one of two.
const COUNTED = `
  (g.status = 'finished'
   OR (g.status = 'aborted' AND g.started_at IS NOT NULL
       AND (${ELIMINATED}
            OR (SELECT COUNT(DISTINCT m.user_id) FROM game_actions m
                WHERE m.game_id = g.id AND m.user_id IS NOT NULL
                  AND json_extract(m.action, '$.type') <> 'leave') >= 2)))
  AND EXISTS (SELECT 1 FROM game_actions m
              WHERE m.game_id = g.id AND m.user_id = s.user_id
                AND json_extract(m.action, '$.type') <> 'leave')`;
// A counted seat that won: a win is the person's only while they still played
// the seat; one the AI took over and then won is their game but not their win.
const WON = "g.status = 'finished' AND g.winner_seat = s.seat AND s.kind = 'human'";

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

  // --- account deletion (src/db/deleteUser.js) ---
  // Human seats the user holds in games that are still going: deletion waits
  // for these (deactivate first; the turn clock hands them to the AI).
  liveSeatsOf: db.prepare(`
    SELECT g.id, g.status, s.seat FROM game_seats s JOIN games g ON g.id = s.game_id
    WHERE s.user_id = @id AND s.kind = 'human' AND g.status = 'active'
  `),
  // Tables the user is at: hosted ones are cancelled, other seats released.
  tablesHostedBy: db.prepare("SELECT id FROM games WHERE host_id = @id AND status = 'lobby'"),
  releaseTableSeatsOf: db.prepare(`
    UPDATE game_seats SET kind = 'open', user_id = NULL, joined_at = NULL
    WHERE user_id = @id AND game_id IN (SELECT id FROM games WHERE status = 'lobby')
  `),
  deletionSummary: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM game_seats s JOIN games g ON g.id = s.game_id
        WHERE s.user_id = @id AND g.status IN ('finished', 'aborted')) AS games,
      (SELECT COUNT(*) FROM games WHERE host_id = @id AND status = 'lobby') AS tables,
      (SELECT COUNT(*) FROM game_seats s JOIN games g ON g.id = s.game_id
        WHERE s.user_id = @id AND g.status = 'lobby' AND g.host_id != @id) AS tableSeats,
      (SELECT COUNT(*) FROM chat_messages WHERE user_id = @id) AS chat,
      (SELECT COUNT(*) FROM friendships WHERE requester_id = @id OR addressee_id = @id) AS friendships,
      (SELECT COUNT(*) FROM user_achievements WHERE user_id = @id) AS achievements
  `),
  deleteChatOf: db.prepare("DELETE FROM chat_messages WHERE user_id = @id"),
  deleteAchievementsOf: db.prepare("DELETE FROM user_achievements WHERE user_id = @id"),
  deleteFriendshipsOf: db.prepare("DELETE FROM friendships WHERE requester_id = @id OR addressee_id = @id"),
  // The row itself stays, because seats and action rows point at it and are
  // the other players' record too. Registration allows only [A-Za-z0-9_], so
  // nobody can ever register a `deleted-<id>` name.
  scrubDeletedUser: db.prepare(`
    UPDATE users
       SET username = 'deleted-' || id, password_hash = NULL, prefs = NULL,
           deactivated_at = COALESCE(deactivated_at, datetime('now'))
     WHERE id = @id
  `),

  // --- leaderboard (src/game/leaderboard.js) ---
  // Every active account, played or not: games played and games won over
  // counted games (COUNTED, above), top 100 by wins. The left joins keep an
  // account with no counted game as 0 / 0, ranked below everyone who played.
  leaderboard: db.prepare(`
    SELECT u.id, u.username,
           COUNT(g.id) AS games,
           SUM(CASE WHEN ${WON} THEN 1 ELSE 0 END) AS wins
    FROM users u
    LEFT JOIN game_seats s ON s.user_id = u.id
    LEFT JOIN games g ON g.id = s.game_id AND ${COUNTED}
    WHERE u.deactivated_at IS NULL
    GROUP BY u.id
    ORDER BY wins DESC, games = 0, games ASC, u.username COLLATE NOCASE ASC
    LIMIT 100
  `),

  // --- profile stats (src/stats/routes.js) ---
  // One row per counted game of the user (the same games the leaderboard
  // counts): the seat, whether it won, how the game ended, whether the seat's
  // civ was eliminated in a game abandoned after, and how many people sat down
  // in it. A seat keeps its user_id when the AI takes it over, and a table's
  // seats are released before it starts, so `people` is the number who
  // started the game.
  statsGames: db.prepare(`
    SELECT s.seat, g.status, CASE WHEN ${WON} THEN 1 ELSE 0 END AS won,
           CASE WHEN g.status = 'aborted' AND ${ELIMINATED} THEN 1 ELSE 0 END AS eliminated,
           (SELECT COUNT(*) FROM game_seats o WHERE o.game_id = g.id AND o.user_id IS NOT NULL) AS people
    FROM game_seats s JOIN games g ON g.id = s.game_id
    WHERE s.user_id = ? AND ${COUNTED}
  `),
  // Games the user is playing right now (a seat still theirs, not the AI's).
  statsInProgress: db.prepare(`
    SELECT COUNT(*) AS n FROM game_seats s JOIN games g ON g.id = s.game_id
    WHERE s.user_id = ? AND s.kind = 'human' AND g.status = 'active'
  `),

  // --- achievements (src/achievements/service.js) ---
  // Ended games not yet looked at by this version of the awarding (?),
  // oldest first: at boot, every game from before achievements existed or
  // before the catalogue last grew (the backfill), and any a restart cut
  // short. A table cancelled before it started has no snapshot and nothing to
  // award.
  listUnawardedGames: db.prepare(`
    SELECT id FROM games
    WHERE status IN ('finished', 'aborted') AND snapshot IS NOT NULL
      AND (achievements_version IS NULL OR achievements_version < ?)
    ORDER BY finished_at, id
  `),
  markGameAwarded: db.prepare(
    "UPDATE games SET achievements_at = datetime('now'), achievements_version = ? WHERE id = ?"
  ),
  setSeatCaptures: db.prepare("UPDATE game_seats SET captures = ? WHERE game_id = ? AND seat = ?"),
  // The seats of one game that count for their person (COUNTED), active
  // accounts only: whether the seat won, and how many people sat down.
  achievementSeats: db.prepare(`
    SELECT s.seat, s.user_id, u.username, CASE WHEN ${WON} THEN 1 ELSE 0 END AS won,
           (SELECT COUNT(*) FROM game_seats o WHERE o.game_id = g.id AND o.user_id IS NOT NULL) AS people
    FROM game_seats s JOIN games g ON g.id = s.game_id JOIN users u ON u.id = s.user_id
    WHERE g.id = ? AND u.deactivated_at IS NULL AND ${COUNTED}
    ORDER BY s.seat
  `),
  // A user's counted games in the order they ended: the seat, whether it won,
  // and the cities taken in it (0 until its achievements are awarded). With
  // @at and @gameId, only the games that ended up to that one, so a game
  // awarded late (the backfill) is credited with the record as it stood then.
  achievementRecord: db.prepare(`
    SELECT s.seat, CASE WHEN ${WON} THEN 1 ELSE 0 END AS won, COALESCE(s.captures, 0) AS captures
    FROM game_seats s JOIN games g ON g.id = s.game_id
    WHERE s.user_id = @userId AND ${COUNTED}
      AND (@at IS NULL OR g.finished_at < @at OR (g.finished_at = @at AND g.id <= @gameId))
    ORDER BY g.finished_at, g.id
  `),
  getUserAchievement: db.prepare("SELECT tier FROM user_achievements WHERE user_id = ? AND key = ?"),
  // Insert, or raise the tier. A lower or equal tier is a no-op, so `changes`
  // says whether anything was earned and awarding twice is harmless.
  awardAchievement: db.prepare(`
    INSERT INTO user_achievements (user_id, key, tier, earned_at, game_id)
    VALUES (@userId, @key, @tier, COALESCE(@at, datetime('now')), @gameId)
    ON CONFLICT (user_id, key) DO UPDATE SET
      tier = excluded.tier, earned_at = excluded.earned_at, game_id = excluded.game_id
    WHERE excluded.tier > user_achievements.tier
  `),
  listAchievements: db.prepare(
    "SELECT key, tier, earned_at, game_id FROM user_achievements WHERE user_id = ? ORDER BY earned_at DESC, key"
  ),

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
  // The games a user holds a seat in, newest activity first. user_seat is
  // their seat; my_seat the same, but only while the user still plays it: a
  // seat handed to the AI keeps its user_id, so the game stays listed, but it
  // is to watch now.
  listGamesForUser: db.prepare(`
    SELECT g.*, s.seat AS user_seat, CASE WHEN s.kind = 'human' THEN s.seat END AS my_seat
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

  // --- friendships (src/friends/routes.js) ---
  // The row between two users, whichever of them asked.
  findFriendship: db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = @a AND addressee_id = @b) OR (requester_id = @b AND addressee_id = @a)
  `),
  getFriendshipById: db.prepare("SELECT * FROM friendships WHERE id = ?"),
  createFriendRequest: db.prepare("INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)"),
  acceptFriendRequest: db.prepare(`
    UPDATE friendships SET status = 'accepted', responded_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `),
  deleteFriendship: db.prepare("DELETE FROM friendships WHERE id = ?"),
  // Every friendship and request of a user, with the other person; friends
  // first, then by name. A deactivated or deleted person is left out, and
  // comes back with their friendships if the account is reactivated.
  listFriendshipsForUser: db.prepare(`
    SELECT f.id, f.status, f.created_at, f.responded_at, f.requester_id, f.addressee_id,
           u.id AS other_id, u.username AS other_username
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = @me OR f.addressee_id = @me) AND u.deactivated_at IS NULL
    ORDER BY f.status = 'accepted' DESC, u.username COLLATE NOCASE
  `),

  // --- display settings (src/settings/routes.js) ---
  getUserPrefs: db.prepare("SELECT prefs FROM users WHERE id = ?"),
  setUserPrefs: db.prepare("UPDATE users SET prefs = ? WHERE id = ?"),

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
