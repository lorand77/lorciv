"use strict";

// Opens the SQLite database, applies the schema and the migrations, and
// exports the handle. Loading this module fixes the database path, which is
// why the test helper sets DB_PATH before anything under src/ is required.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config");
const log = require("../log");

// Ensure the data/ directory exists before opening the file.
fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

const db = new Database(config.DB_PATH);

// WAL persists with the file (better concurrent reads); foreign_keys is a
// per-connection pragma, so it must be set on every open.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Apply the (idempotent) schema.
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

// Names that differ only in case are one name. Registration checks this too,
// but only an index closes the race between two simultaneous registrations. An
// older database may already hold such pairs; then the index cannot be built,
// registration's own check still stands, and the log says so.
try {
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)"
  );
} catch (err) {
  const dupes = db
    .prepare("SELECT username FROM users GROUP BY username COLLATE NOCASE HAVING COUNT(*) > 1")
    .all()
    .map((r) => r.username);
  // The index is skipped until one name of each pair is renamed.
  log.warn("db.case_duplicates", { names: dupes.join(",") });
}

// --- migrations ---
// schema.sql only ever CREATEs, which is idempotent; adding a column to a table
// that already exists needs ALTER, which is not. Apply those here instead, so a
// database created before a column existed picks it up on the next boot.
// Returns true when it actually added the column, so a caller can run a
// one-time backfill alongside it.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info("db.migrated", { added: `${table}.${column}` });
  return true;
}

// 2026-10-11: display settings (the colour scheme). NULL is the defaults, so
// existing users need no backfill.
addColumnIfMissing("users", "prefs", "TEXT");

// 2026-10-12: achievements. NULL means not awarded yet, so every game that
// ended before is picked up at boot (src/achievements/service.js): that is
// the backfill.
addColumnIfMissing("games", "achievements_at", "TEXT");
addColumnIfMissing("game_seats", "captures", "INTEGER");

// 2026-10-13: the awarding's version. NULL on every game awarded before it,
// so the boot awards them again under today's catalogue (the civ
// achievements); awarding only ever raises, so that is safe.
addColumnIfMissing("games", "achievements_version", "INTEGER");

module.exports = db;
module.exports.addColumnIfMissing = addColumnIfMissing;
