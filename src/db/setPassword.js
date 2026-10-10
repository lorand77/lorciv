"use strict";

// `npm run user:password -- <username>` — set a user's password from the
// command line (ops use: a player forgot theirs, there is no self-service
// reset flow). Safe to run while the server is up: better-sqlite3 in WAL mode
// handles the concurrent write.
//
// The new password is never taken as an argument, so it does not end up in
// shell history or `ps` output. It is read either:
//   - interactively, with echo disabled, when stdin is a terminal, or
//   - from stdin (first line) otherwise:  echo "s3cret" | npm run user:password -- alice
//
// Hashing matches src/auth/routes.js (argon2 defaults) and enforces the same
// length limits, so the account behaves exactly as if registered with it.
// Existing sessions for the user are NOT invalidated; restarting the server
// with a new SESSION_SECRET logs everyone out if that is needed.

const readline = require("readline");
const argon2 = require("argon2");
const config = require("../config");

const MIN_PASSWORD = 6; // keep both in sync with src/auth/routes.js
const MAX_PASSWORD = 128;

function usage(msg) {
  if (msg) console.error("error:", msg);
  console.error("usage: npm run user:password -- <username>");
  process.exit(2);
}

// Prompt on the terminal with echo suppressed. Resolves with the entered line.
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let muted = false;
    // Swallow echoed characters once the prompt itself has been written.
    rl._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      muted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

// Non-interactive: first line of stdin, without the trailing newline.
function readStdinLine() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.split(/\r?\n/)[0]));
    process.stdin.on("error", reject);
  });
}

async function readPassword() {
  if (!process.stdin.isTTY) return readStdinLine();
  const first = await promptHidden("New password: ");
  const second = await promptHidden("Repeat password: ");
  if (first !== second) usage("passwords do not match");
  return first;
}

async function main() {
  const [username] = process.argv.slice(2);
  if (!username) usage();

  // Open the DB only after argument checks so a typo doesn't touch the file.
  const queries = require("./queries");
  const user = queries.getUserByUsername.get(username);
  if (!user) usage(`no such user: ${username}`);

  const password = await readPassword();
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    usage(`password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters`);
  }

  const hash = await argon2.hash(password);
  const info = queries.updatePassword.run(hash, user.id);
  if (info.changes !== 1) {
    console.error("error: update affected", info.changes, "rows");
    process.exit(1);
  }
  console.log(`password updated for ${user.username} (id ${user.id}) in ${config.DB_PATH}`);
}

main().catch((err) => {
  console.error("failed:", err.message);
  process.exit(1);
});
