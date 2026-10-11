"use strict";

// The entry point: builds the app (src/app.js) and listens. Process-level
// concerns live here and only here, because the tests boot app.js directly:
// crash and signal handling, and the chat retention sweep.

const config = require("./config");
const log = require("./log");
const { createServer } = require("./app");
const { startChatRetention } = require("./db/retention");
const { version } = require("../package.json");

// An uncaught error leaves the process in an unknown state: log it, with its
// stack, and exit so pm2 starts a clean one. Without this the reason would only
// reach Node's own stderr dump, outside the log.
function crash(kind, err) {
  log.error("process.crash", { kind, err });
  process.exit(1);
}
process.on("uncaughtException", (err) => crash("uncaught_exception", err));
process.on("unhandledRejection", (err) => crash("unhandled_rejection", err));

// pm2 stops and restarts with a signal. Exiting at once is safe: everything
// that matters is already in SQLite.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log.info("process.stop", { signal });
    process.exit(0);
  });
}

// Drop chat from long-finished games, now and once a day after.
startChatRetention();

const { server } = createServer();

server.listen(config.PORT, () => {
  log.info("process.start", {
    version,
    node: process.version,
    url: `http://localhost:${config.PORT}/login.html`,
    db: config.DB_PATH,
  });
});
