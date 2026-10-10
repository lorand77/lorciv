"use strict";

// The terms and privacy pages must be readable by someone without an account:
// the login card asks people to agree to them before they register. Guard
// against either page picking up authGuard (which would bounce them to login).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

for (const page of ["/terms.html", "/privacy.html"]) {
  test(`${page} is served without a session and without the auth guard`, async () => {
    const res = await fetch(srv.baseUrl + page);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.doesNotMatch(html, /authGuard\.js/);
    assert.doesNotMatch(html, /shell\.js/);
  });
}

test("the login card links to both pages", async () => {
  const html = await (await fetch(srv.baseUrl + "/login.html")).text();
  assert.match(html, /href="\/terms\.html"/);
  assert.match(html, /href="\/privacy\.html"/);
});
