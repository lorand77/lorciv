"use strict";

// Deactivated accounts: `npm run user:deactivate` ends their sessions and
// refuses their logins, and their sockets are swept. Reactivating brings all
// of it back.

process.env.DEACTIVATION_SWEEP_MS = "100";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { startServer, client, registerUser, connectSocket, waitFor } = require("../helpers/server");
const queries = require("../../src/db/queries");

const CLI = path.join(__dirname, "../../src/db/deactivate.js");

// Run the command against the test database, as ops would against the real one.
function cli(mode, username) {
  const r = spawnSync(process.execPath, [CLI, mode, username], { env: process.env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const deactivate = (u) => queries.deactivateUser.run(u.user.id);
const reactivate = (u) => queries.reactivateUser.run(u.user.id);

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

describe("the command", () => {
  test("ends the user's sessions and refuses their login until reactivated", async () => {
    const alice = await registerUser(srv.baseUrl, "alice");
    const name = alice.user.username;

    const off = cli("deactivate", name);
    assert.equal(off.code, 0, off.out);
    assert.match(off.out, /deactivated .*; 1 session\(s\) ended/);
    assert.equal((await alice.c.get("/api/me")).status, 401);

    const login = await client(srv.baseUrl).post("/api/login", { username: name, password: alice.password });
    assert.equal(login.status, 403);
    assert.deepEqual(login.body, { error: "This account has been deactivated." });
    // Without the password, it is the same answer as for anyone else.
    const wrong = await client(srv.baseUrl).post("/api/login", { username: name, password: "wrong-password" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, { error: "Invalid username or password." });

    assert.match(cli("deactivate", name).out, /already deactivated/);
    const on = cli("reactivate", name.toUpperCase());
    assert.equal(on.code, 0, on.out);
    assert.match(on.out, /reactivated/);
    assert.match(cli("reactivate", name).out, /not deactivated/);
    const back = await client(srv.baseUrl).post("/api/login", { username: name, password: alice.password });
    assert.equal(back.status, 200);
  });

  test("refuses unknown users and unknown modes", () => {
    assert.equal(cli("deactivate", "no_such_user_x").code, 2);
    assert.equal(cli("vanish", "anyone").code, 2);
  });
});

describe("a session that outlives the deactivation", () => {
  // A login racing the command can create a session after it deleted them.
  test("is refused on REST and at the socket handshake", async () => {
    const bob = await registerUser(srv.baseUrl, "bob");
    deactivate(bob);
    const me = await bob.c.get("/api/me");
    assert.equal(me.status, 401);
    assert.deepEqual(me.body, { error: "This account has been deactivated." });
    await assert.rejects(connectSocket(srv.baseUrl, bob.c.cookie()), /unauthorized/);
    reactivate(bob);
    assert.equal((await bob.c.get("/api/me")).status, 200);
  });
});

describe("sockets", () => {
  test("an idle socket is disconnected by the sweep", async () => {
    const heidi = await registerUser(srv.baseUrl, "heidi");
    const s = await connectSocket(srv.baseUrl, heidi.c.cookie());
    const dropped = waitFor(s, "disconnect", 2000);
    deactivate(heidi);
    assert.equal(await dropped, "io server disconnect");
  });
});
