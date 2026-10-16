"use strict";

// GET /health, for the external uptime check (Better Stack, see "monitoring"
// in docs/setup.md). pm2 restarts a crashed process; this catches what pm2
// cannot see: the box or Caddy down, the event loop stuck, the database
// unreadable, the disk filling up. 200 { ok: true } or 503 { ok: false },
// nothing else: the URL is public. Why it failed goes to the log instead.

const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./db/index");
const log = require("./log");

// Below this share of the database's disk free, report unhealthy: on the
// 8 GB server that is ~800 MB, time to clean up before SQLite cannot write.
const MIN_FREE = 0.1;

// Reads a real page, so the query reaches the database file.
const ping = db.prepare("SELECT 1 FROM users LIMIT 1");

function health(req, res) {
  try {
    ping.get();
    const { bavail, blocks } = fs.statfsSync(path.dirname(config.DB_PATH));
    if (bavail / blocks < MIN_FREE) {
      log.error("health.failed", { reason: "disk_low", free_pct: Math.floor((bavail / blocks) * 100) });
      return res.status(503).json({ ok: false });
    }
    res.json({ ok: true });
  } catch (err) {
    log.error("health.failed", { reason: "error", err });
    res.status(503).json({ ok: false });
  }
}

module.exports = { health };
