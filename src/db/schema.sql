-- lorciv database schema. Idempotent (IF NOT EXISTS) — safe to run on every
-- boot. Written to port cleanly to Postgres later (no SQLite-only types).
--
-- Only CREATEs: adding a column to a table that already exists goes through
-- addColumnIfMissing in src/db/index.js, or older databases never get it.
--
-- The `sessions` table is not here: the session store creates it when
-- src/auth/session.js first loads (see better-sqlite3-session-store).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  -- argon2 hash. An account without one can never log in.
  password_hash TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Set by `npm run user:deactivate`: no login, nothing visible. NULL = active.
  -- The row stays so game history keeps its names and reactivating restores
  -- everything.
  deactivated_at TEXT
);

-- A game: who sits where, its settings, and the engine's latest state as one
-- JSON snapshot (src/shared/snapshot.js), overwritten after every action. The
-- snapshot is what a room is rebuilt from after a restart and what every
-- client renders. `lobby` is a table waiting for players (M3); a game created
-- today is `active` at once.
CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('lobby', 'active', 'finished', 'aborted')),
  host_id       INTEGER NOT NULL REFERENCES users(id),
  seed          INTEGER NOT NULL,
  settings      TEXT    NOT NULL,            -- JSON: { turnTime }
  snapshot      TEXT,                        -- JSON, NULL while in the lobby
  seq           INTEGER NOT NULL DEFAULT 0,  -- actions applied so far
  turn          INTEGER NOT NULL DEFAULT 1,
  current_seat  INTEGER NOT NULL DEFAULT 0,
  turn_deadline TEXT,                        -- when the current human turn expires (M3)
  winner_seat   INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);

-- The four seats of a game. `human` seats belong to a user; `ai` seats are
-- played by the server; `open` seats wait for someone in the lobby (M3).
CREATE TABLE IF NOT EXISTS game_seats (
  game_id      INTEGER NOT NULL REFERENCES games(id),
  seat         INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('open', 'human', 'ai')),
  user_id      INTEGER REFERENCES users(id),
  difficulty   TEXT    NOT NULL DEFAULT 'prince',
  missed_turns INTEGER NOT NULL DEFAULT 0,   -- consecutive expired turns (M3)
  joined_at    TEXT,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX IF NOT EXISTS idx_game_seats_user ON game_seats (user_id);

-- Every player action, in order: an audit trail and the raw material for
-- replays. AI turns are not rows; they follow deterministically from the
-- endTurn that triggered them.
CREATE TABLE IF NOT EXISTS game_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  seq        INTEGER NOT NULL,
  seat       INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id),   -- NULL when the server acted (a timer)
  action     TEXT    NOT NULL,               -- JSON: { type, unitId, cityId, q, r, key }
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_id, seq)
);

-- In-game chat, one room per game for players and spectators alike. Kept so
-- the people in a game can talk; swept CHAT_RETENTION_DAYS after the game
-- ends (src/db/retention.js).
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_game ON chat_messages (game_id, id);
