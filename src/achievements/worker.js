"use strict";

// The achievements worker thread: replays one ended game at a time
// (analyze.js) off the main thread, which a long game's AI turns would
// otherwise block for seconds. Gets { gameId, setup, actions, snapshot },
// answers { gameId, ...analysis }. Never touches the database.

const { parentPort } = require("worker_threads");
const { analyzeGame } = require("./analyze");

parentPort.on("message", (job) => {
  let out;
  try {
    out = analyzeGame(job);
  } catch (err) {
    out = { ok: false, error: "threw", message: String(err && err.stack || err) };
  }
  parentPort.postMessage({ gameId: job.gameId, ...out });
});
