"use strict";

// src/auth/throttle.js: the sliding-window limiter behind the login and
// registration limits, and the cap on argon2 calls in flight.

process.env.HASH_MAX_CONCURRENT = "2";

const { describe, test, mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter, acquireHashSlot } = require("../../src/auth/throttle");

afterEach(() => mock.timers.reset());

describe("createLimiter", () => {
  test("blocks a key once it has had `max` events, and only that key", () => {
    const limiter = createLimiter(3, 60000);
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.blocked("a"), false);
      limiter.hit("a");
    }
    assert.equal(limiter.blocked("a"), true);
    assert.equal(limiter.blocked("b"), false);
  });

  test("events older than the window stop counting", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const limiter = createLimiter(2, 60000);
    limiter.hit("a");
    mock.timers.tick(30000);
    limiter.hit("a");
    assert.equal(limiter.blocked("a"), true);
    mock.timers.tick(30000); // the first event is now exactly a window old
    assert.equal(limiter.blocked("a"), false);
  });

  test("sweep forgets keys whose events have all expired", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const limiter = createLimiter(5, 60000);
    limiter.hit("old");
    mock.timers.tick(45000);
    limiter.hit("new");
    mock.timers.tick(20000);
    limiter.sweep();
    assert.equal(limiter.size(), 1);
    assert.equal(limiter.blocked("new"), false);
  });
});

describe("acquireHashSlot", () => {
  test("hands out HASH_MAX_CONCURRENT slots, then refuses until one is released", () => {
    const first = acquireHashSlot();
    const second = acquireHashSlot();
    assert.equal(typeof first, "function");
    assert.equal(typeof second, "function");
    assert.equal(acquireHashSlot(), null);

    first();
    first(); // releasing twice must not free a slot someone else holds
    const third = acquireHashSlot();
    assert.equal(typeof third, "function");
    assert.equal(acquireHashSlot(), null);

    second();
    third();
  });
});
