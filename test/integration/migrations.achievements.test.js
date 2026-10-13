"use strict";

// The achievements migration in src/db/index.js, run against a database in the
// shape it had before achievements existed: games.achievements_at and
// achievements_version and game_seats.captures are added, empty, and
// user_achievements is created. An empty achievements_version is what makes
// the next boot award the old games, those awarded before it existed too.

require("../helpers/server");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

test("an older database gets the achievement columns and table on the next boot", () => {
  const old = new Database(process.env.DB_PATH);
  old.exec(fs.readFileSync(path.join(__dirname, "../../src/db/schema.sql"), "utf8"));
  old.exec("DROP TABLE user_achievements");
  old.exec("ALTER TABLE games DROP COLUMN achievements_at");
  old.exec("ALTER TABLE games DROP COLUMN achievements_version");
  old.exec("ALTER TABLE game_seats DROP COLUMN captures");
  const user = Number(old.prepare("INSERT INTO users (username, password_hash) VALUES ('veteran', 'x')").run().lastInsertRowid);
  const game = Number(old.prepare(
    "INSERT INTO games (status, host_id, seed, settings, snapshot) VALUES ('finished', ?, 1, '{}', '{}')"
  ).run(user).lastInsertRowid);
  old.prepare("INSERT INTO game_seats (game_id, seat, kind, user_id) VALUES (?, 0, 'human', ?)").run(game, user);
  old.close();

  const db = require("../../src/db");
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(cols("games").includes("achievements_at"));
  assert.ok(cols("games").includes("achievements_version"));
  assert.ok(cols("game_seats").includes("captures"));
  assert.ok(cols("user_achievements").includes("tier"));
  assert.equal(db.prepare("SELECT achievements_at FROM games WHERE id = ?").get(game).achievements_at, null);
  assert.equal(db.prepare("SELECT captures FROM game_seats WHERE game_id = ?").get(game).captures, null);
  const { AWARDS_VERSION } = require("../../src/achievements/service");
  assert.deepEqual(require("../../src/db/queries").listUnawardedGames.all(AWARDS_VERSION).map((r) => r.id), [game]);
  assert.equal(db.addColumnIfMissing("games", "achievements_at", "TEXT"), false, "a second boot adds nothing");
});
