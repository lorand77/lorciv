"use strict";

// Drops in-game chat CHAT_RETENTION_DAYS after a game ends. The conversation
// matters while the players are still there; keeping it for ever means every
// message anyone has sent lives in the database and in every backup. A
// negative setting disables the sweep. Started from src/server.js, so the
// tests (which boot src/app.js) do not run it on their own.

const config = require("../config");
const queries = require("./queries");
const log = require("../log");

const DAY_MS = 24 * 60 * 60 * 1000;

function sweepChat(days = config.CHAT_RETENTION_DAYS) {
  if (days < 0) return 0;
  const removed = queries.deleteOldChat.run(`-${days} days`).changes;
  if (removed) log.info("chat.retention", { removed, days });
  return removed;
}

function startChatRetention() {
  if (config.CHAT_RETENTION_DAYS < 0) return;
  const run = () => {
    try { sweepChat(); } catch (err) { log.error("chat.retention_failed", { err }); }
  };
  run();
  setInterval(run, DAY_MS).unref();
}

module.exports = { sweepChat, startChatRetention };
