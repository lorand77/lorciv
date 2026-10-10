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
