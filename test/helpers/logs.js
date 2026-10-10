"use strict";

// Captures what src/log.js writes, for tests that check a line was logged:
//
//   const logs = captureLogs();
//   ... act ...
//   assert.ok(logs.find("game.over", { game: 3, result: "1-0" }));
//   logs.restore();
//
// Each line is parsed back into { time, level, event, fields, stack }, with
// field values as the strings that were written, so a test sees what an
// operator reading the log would see.

const log = require("../../src/log");

const FIELD = /\s([^\s=]+)=("(?:[^"\\]|\\.)*"|\S*)/g;

function parse(text) {
  const [line, ...stack] = text.replace(/\n$/, "").split("\n");
  const [time, level, event] = line.split(/\s+/, 3);
  const fields = {};
  for (const m of line.matchAll(FIELD)) {
    fields[m[1]] = m[2].startsWith("\"") ? JSON.parse(m[2]) : m[2];
  }
  return { time, level: level.toLowerCase(), event, fields, stack: stack.map((s) => s.trim()) };
}

// Captures at `level` (default debug, i.e. everything) until restore().
function captureLogs(level = "debug") {
  const lines = [];
  const previousWrite = log.setWrite((text) => lines.push(parse(text)));
  const previousLevel = log.getLevel();
  log.setLevel(level);
  // The first line with this event whose fields include all of `fields`.
  const find = (event, fields = {}) =>
    lines.find((l) => l.event === event &&
      Object.entries(fields).every(([k, v]) => l.fields[k] === String(v)));
  return {
    lines,
    find,
    // find(), retried until it matches: some lines are written just after the
    // client has its answer (http.request on the response's close).
    async waitFor(event, fields = {}, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const line = find(event, fields);
        if (line) return line;
        if (Date.now() > deadline) {
          throw new Error(`no ${event} ${JSON.stringify(fields)} logged within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    restore() {
      log.setWrite(previousWrite);
      log.setLevel(previousLevel);
    },
  };
}

module.exports = { captureLogs, parse };
