"use strict";

// The server's logger: one line per event, logfmt, to stdout.
//
//   2026-10-09T21:14:03.120Z INFO  game.over game=318 result=0-1 termination=resign
//
// pm2 collects stdout into ~/.pm2/logs/ and pm2-logrotate keeps 14 days of it
// (docs/setup.md). Every level goes to stdout, errors included, so one file
// holds the whole story in order. The event list and what may never be logged
// are in docs/design.md under "Logging"; this module only filters, formats and
// redacts. No dependency: levels, fields and child loggers are all the server
// needs.

const config = require("./config");

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

// A field whose name contains one of these words is written as [redacted],
// whatever the caller passed. A safety net: the rule is not to pass them.
const SECRET_WORDS = new Set([
  "password", "hash", "secret", "token", "session", "sid", "cookie", "authorization",
]);

// "password_hash", "sessionID" and "authToken" all name a secret; "side" does not.
function isSecret(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SECRET_WORDS.has(word));
}

function errorText(err) {
  return err.message ? `${err.name}: ${err.message}` : err.name;
}

// Bare when that is unambiguous, JSON-quoted otherwise, so no value can break
// the line or fake a field: a newline in a message is written as "\n".
function formatValue(value) {
  if (value === null) return "null";
  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (value instanceof Error) s = errorText(value);
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  return s === "" || /[^\x21-\x7e]|["=\\]/.test(s) ? JSON.stringify(s) : s;
}

// The "at ..." frames of an error's stack, indented under its line.
function frames(err) {
  return String(err.stack || "")
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .map((l) => "    " + l.trim());
}

function format(time, level, event, fields) {
  let line = `${time.toISOString()} ${level.toUpperCase().padEnd(5)} ${event}`;
  const stacks = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isSecret(key)) {
      line += ` ${key}=[redacted]`;
      continue;
    }
    if (value instanceof Error) stacks.push(...frames(value));
    line += ` ${key}=${formatValue(value)}`;
  }
  return [line, ...stacks].join("\n") + "\n";
}

// `write` receives each finished line, newline included; `now` returns the
// time to stamp. Both are parameters for the tests. A logger and all its
// children share one level and one output.
function createLogger({
  level = "info",
  write = (text) => process.stdout.write(text),
  now = () => new Date(),
} = {}) {
  const state = { level: "info", write, now };
  const root = make(state, {});
  root.setLevel(level);
  return root;
}

function make(state, base) {
  const at = (level) => (event, fields) => {
    if (LEVELS[level] > LEVELS[state.level]) return;
    state.write(format(state.now(), level, event, { ...base, ...fields }));
  };
  const logger = {
    error: at("error"),
    warn: at("warn"),
    info: at("info"),
    debug: at("debug"),
    // A logger that adds `fields` to every line it writes.
    child: (fields) => make(state, { ...base, ...fields }),
    getLevel: () => state.level,
    // An unknown level (a typo in LOG_LEVEL) must not silence the server, nor
    // stop it from starting: fall back to info and say so.
    setLevel(level) {
      if (Object.hasOwn(LEVELS, level)) {
        state.level = level;
        return;
      }
      state.level = "info";
      logger.warn("log.bad_level", { level, using: "info" });
    },
    // Send lines somewhere else; returns the previous writer. For the tests.
    setWrite(write) {
      const previous = state.write;
      state.write = write;
      return previous;
    },
  };
  return logger;
}

const log = createLogger({ level: config.LOG_LEVEL });
log.createLogger = createLogger;

module.exports = log;
