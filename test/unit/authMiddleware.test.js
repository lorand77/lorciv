"use strict";

// requireAuth in src/auth/middleware.js: the gate on every protected REST route.
// It looks the user up to refuse deactivated accounts, so it needs the
// throwaway database: load the helper first.

require("../helpers/server");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { requireAuth } = require("../../src/auth/middleware");
const queries = require("../../src/db/queries");

function fakeRes() {
  return {
    code: null,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function run(req) {
  const res = fakeRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  return { res, called };
}

describe("requireAuth", () => {
  test("lets a logged-in session through and sends nothing", () => {
    const { res, called } = run({ session: { userId: 7 } });
    assert.equal(called, true);
    assert.equal(res.code, null);
    assert.equal(res.body, null);
  });

  test("rejects a session without a user", () => {
    const { res, called } = run({ session: {} });
    assert.equal(called, false);
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { error: "Authentication required." });
  });

  test("rejects a request with no session at all", () => {
    const { res, called } = run({});
    assert.equal(called, false);
    assert.equal(res.code, 401);
  });

  test("rejects a session whose user was cleared", () => {
    for (const userId of [null, undefined, ""]) {
      const { called, res } = run({ session: { userId } });
      assert.equal(called, false, String(userId));
      assert.equal(res.code, 401);
    }
  });

  test("rejects the session of a deactivated account", () => {
    const id = Number(queries.createUser.run("gatekept", "x").lastInsertRowid);
    assert.equal(run({ session: { userId: id } }).called, true);
    queries.deactivateUser.run(id);
    const { res, called } = run({ session: { userId: id } });
    assert.equal(called, false);
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { error: "This account has been deactivated." });
  });
});
