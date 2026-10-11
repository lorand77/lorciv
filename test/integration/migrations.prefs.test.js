"use strict";

// The users.prefs migration in src/db/index.js, run against a database in the
// shape it had before display settings existed: the column is added, the users
// already there keep their rows and read as the defaults.

require("../helpers/server");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

test("an older database gets users.prefs, empty, on the next boot", () => {
  // Today's schema minus the column, with a user, written before
  // src/db/index.js first loads.
  const old = new Database(process.env.DB_PATH);
  old.exec(fs.readFileSync(path.join(__dirname, "../../src/db/schema.sql"), "utf8"));
  old.exec("ALTER TABLE users DROP COLUMN prefs");
  const id = Number(old.prepare("INSERT INTO users (username, password_hash) VALUES ('veteran', 'x')").run().lastInsertRowid);
  old.close();

  const db = require("../../src/db");
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(cols.includes("prefs"));
  const row = db.prepare("SELECT username, prefs FROM users WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { username: "veteran", prefs: null });
  assert.equal(db.addColumnIfMissing("users", "prefs", "TEXT"), false, "a second boot adds nothing");
});
