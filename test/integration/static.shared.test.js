"use strict";

// The engine in src/shared is served at /js/* ahead of public/js, so one copy
// serves the server and the browser; page scripts still fall through.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test("the engine is served at /js and the page scripts fall through", async () => {
  const cases = [
    ["/js/hex.js", /function hexDistance/],
    ["/js/state.js", /const UNIT_DEFS/],
    ["/js/game.js", /class Game/],
    ["/js/snapshot.js", /SNAPSHOT_VERSION/],
    ["/js/settings.js", /ACTION_TYPES/],
    ["/js/actions.js", /function applyAction/],
    ["/js/renderer.js", /class HexRenderer/],
    ["/js/shell.js", /app-rail/],
    ["/js/net.js", /function connectSocket/],
  ];
  for (const [p, re] of cases) {
    const res = await fetch(srv.baseUrl + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type"), /javascript/, p);
    assert.match(await res.text(), re, p);
  }
  const png = await fetch(srv.baseUrl + "/assets/terrain-hills.png");
  assert.equal(png.status, 200);
  assert.match(png.headers.get("content-type"), /image\/png/);
});
