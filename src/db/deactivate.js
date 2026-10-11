"use strict";

// `npm run user:deactivate -- <username>` / `npm run user:reactivate -- <username>`
// — take an account out of the site, or bring it back (ops use; there is no
// admin UI). A deactivated user cannot log in and is shown nowhere: not on the
// leaderboard, in friends lists or as a profile. Nothing is deleted: game
// history keeps their name, and reactivating restores everything, friends too.
//
// Deactivating also deletes the user's sessions, so every open tab is logged
// out on its next request. Sockets live in the server process, out of reach
// from here; the server's deactivation sweep disconnects them within
// DEACTIVATION_SWEEP_MS. Safe to run while the server is up (WAL handles the
// write).

const config = require("../config");

const MODES = ["deactivate", "reactivate"];

function usage(msg) {
  if (msg) console.error("error:", msg);
  console.error("usage: npm run user:deactivate -- <username>");
  console.error("       npm run user:reactivate -- <username>");
  process.exit(2);
}

function main() {
  const [mode, username] = process.argv.slice(2);
  if (!MODES.includes(mode) || !username) usage();

  // Open the DB only after argument checks so a typo doesn't touch the file.
  const db = require("./index");
  const queries = require("./queries");
  const user = queries.getUserByUsernameNoCase.get(username);
  if (!user) usage(`no such user: ${username}`);

  if (mode === "reactivate") {
    if (queries.reactivateUser.run(user.id).changes === 0) {
      console.log(`${user.username} (id ${user.id}) is not deactivated; nothing to do`);
      return;
    }
    console.log(`reactivated ${user.username} (id ${user.id}) in ${config.DB_PATH}`);
    return;
  }

  if (queries.deactivateUser.run(user.id).changes === 0) {
    console.log(`${user.username} (id ${user.id}) is already deactivated; nothing to do`);
    return;
  }
  // The sessions table belongs to the session store, which creates it when the
  // server first loads src/auth/session.js, so it may not exist yet. That is
  // also why this statement is not in queries.js, which prepares on load.
  const hasSessions = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get();
  const ended = hasSessions
    ? db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(user.id).changes
    : 0;
  console.log(
    `deactivated ${user.username} (id ${user.id}) in ${config.DB_PATH}; ` +
    `${ended} session(s) ended`
  );
}

main();
