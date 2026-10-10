"use strict";

// Throttling for /api/login and /api/register. Both run argon2, which is
// deliberately expensive, so without limits anyone could guess passwords
// without end, create accounts by the thousand, or simply keep the CPU of a
// two-vCPU server busy hashing. Two defences, both in memory (a restart
// forgets them, which is fine for a single server):
//
//   - per-key sliding windows: failed logins and registrations per client IP;
//   - a global cap on argon2 calls in flight, which holds however many IPs
//     the load comes from. A request over the cap is refused, not queued.
//
// Limits come from src/config.js; the tests raise them in test/helpers/server.js.

const config = require("../config");

// Counts events per key over the last `windowMs`. `blocked` only looks;
// `hit` records one event.
function createLimiter(max, windowMs) {
  const hits = new Map(); // key -> timestamps of recent events, oldest first

  function recent(key, now) {
    const kept = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
  }

  return {
    blocked: (key) => recent(key, Date.now()).length >= max,
    hit(key) {
      const now = Date.now();
      hits.set(key, [...recent(key, now), now]);
    },
    // Drop keys whose events have all expired, so one-off visitors do not
    // pile up in the Map for ever.
    sweep() {
      const now = Date.now();
      for (const key of hits.keys()) recent(key, now);
    },
    size: () => hits.size,
  };
}

const loginFailures = createLimiter(config.LOGIN_MAX_FAILURES, config.AUTH_WINDOW_MS);
const registrations = createLimiter(config.REGISTER_MAX, config.AUTH_WINDOW_MS);

setInterval(() => {
  loginFailures.sweep();
  registrations.sweep();
}, 60 * 1000).unref();

// Claim one of the argon2 slots. Returns a release function, or null when all
// slots are taken. Release in a `finally`; releasing twice is harmless.
let hashesInFlight = 0;
function acquireHashSlot() {
  if (hashesInFlight >= config.HASH_MAX_CONCURRENT) return null;
  hashesInFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hashesInFlight--;
  };
}

module.exports = { createLimiter, loginFailures, registrations, acquireHashSlot };
