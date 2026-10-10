"use strict";

// src/log.js: the logfmt line format, levels, child loggers and redaction,
// and test/helpers/logs.js, which parses those lines back for other tests.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const log = require("../../src/log");
const { captureLogs, parse } = require("../helpers/logs");

const T = new Date("2026-10-09T21:14:03.120Z");

// A logger writing into an array, stamped with a fixed time.
function logger(level = "debug") {
  const out = [];
  const l = log.createLogger({ level, write: (text) => out.push(text), now: () => T });
  return { l, out };
}

describe("log line format", () => {
  test("time, padded level, event, then fields in order", () => {
    const { l, out } = logger();
    l.info("game.over", { game: 318, result: "0-1", termination: "resign" });
    l.error("db.failed", {});
    assert.deepEqual(out, [
      "2026-10-09T21:14:03.120Z INFO  game.over game=318 result=0-1 termination=resign\n",
      "2026-10-09T21:14:03.120Z ERROR db.failed\n",
    ]);
  });

  test("an event needs no fields", () => {
    const { l, out } = logger();
    l.warn("lobby.empty");
    assert.equal(out[0], "2026-10-09T21:14:03.120Z WARN  lobby.empty\n");
  });

  test("values are quoted only when they would be ambiguous bare", () => {
    const { l, out } = logger();
    l.info("x", {
      plain: "alice", spaced: "two words", empty: "", quote: "a\"b", eq: "a=b", slash: "a\\b",
      accented: "Zoé", nl: "line\nbreak", n: 3, ok: true, none: null, skipped: undefined,
    });
    assert.equal(
      out[0],
      "2026-10-09T21:14:03.120Z INFO  x plain=alice spaced=\"two words\" empty=\"\" quote=\"a\\\"b\" " +
      "eq=\"a=b\" slash=\"a\\\\b\" accented=\"Zoé\" nl=\"line\\nbreak\" n=3 ok=true none=null\n"
    );
  });

  test("dates are ISO, objects JSON", () => {
    const { l, out } = logger();
    l.info("x", { at: T, list: [1, 2], obj: { a: 1 } });
    assert.equal(
      out[0],
      "2026-10-09T21:14:03.120Z INFO  x at=2026-10-09T21:14:03.120Z list=[1,2] obj=\"{\\\"a\\\":1}\"\n"
    );
  });

  test("an error is written as name: message, its stack frames indented below", () => {
    const { l, out } = logger();
    const err = new TypeError("Cannot read properties of undefined");
    l.error("socket.handler_failed", { event: "move", err });
    const [line, ...rest] = out[0].replace(/\n$/, "").split("\n");
    assert.equal(
      line,
      "2026-10-09T21:14:03.120Z ERROR socket.handler_failed event=move " +
      "err=\"TypeError: Cannot read properties of undefined\""
    );
    assert.ok(rest.length > 0);
    for (const frame of rest) assert.match(frame, /^ {4}at \S/);
    assert.match(rest[0], /log\.test\.js/);
  });

  test("an error without a message or a stack still makes one line", () => {
    const { l, out } = logger();
    const bare = new Error();
    bare.stack = undefined;
    l.error("x", { err: bare });
    assert.equal(out[0], "2026-10-09T21:14:03.120Z ERROR x err=Error\n");
  });

  test("a thrown non-error value is written as a plain field", () => {
    const { l, out } = logger();
    l.error("process.crash", { err: "boom" });
    assert.equal(out[0], "2026-10-09T21:14:03.120Z ERROR process.crash err=boom\n");
  });
});

describe("redaction", () => {
  test("fields named for a secret are never written", () => {
    const { l, out } = logger();
    l.info("x", {
      password: "hunter22", password_hash: "$argon2", sessionID: "abc", authToken: "t",
      cookie: "c", Authorization: "Bearer x", sid: "s", secret: "s",
    });
    assert.equal(
      out[0],
      "2026-10-09T21:14:03.120Z INFO  x password=[redacted] password_hash=[redacted] " +
      "sessionID=[redacted] authToken=[redacted] cookie=[redacted] Authorization=[redacted] " +
      "sid=[redacted] secret=[redacted]\n"
    );
  });

  test("words that merely contain a secret word are kept", () => {
    const { l, out } = logger();
    l.info("x", { side: "w", considered: 1, passwordless: true });
    assert.equal(out[0], "2026-10-09T21:14:03.120Z INFO  x side=w considered=1 passwordless=true\n");
  });

  test("redaction applies to a child's fields too", () => {
    const { l, out } = logger();
    l.child({ session: "abc" }).info("x");
    assert.equal(out[0], "2026-10-09T21:14:03.120Z INFO  x session=[redacted]\n");
  });
});

describe("levels", () => {
  test("a level writes itself and everything more severe", () => {
    const { l, out } = logger("warn");
    l.debug("d");
    l.info("i");
    l.warn("w");
    l.error("e");
    assert.deepEqual(out.map((s) => parse(s).event), ["w", "e"]);
  });

  test("debug writes everything and silent nothing", () => {
    const loud = logger("debug");
    const quiet = logger("silent");
    for (const { l } of [loud, quiet]) {
      l.debug("d");
      l.info("i");
      l.warn("w");
      l.error("e");
    }
    assert.equal(loud.out.length, 4);
    assert.equal(quiet.out.length, 0);
  });

  test("the default level is info", () => {
    const out = [];
    const l = log.createLogger({ write: (text) => out.push(text) });
    assert.equal(l.getLevel(), "info");
    l.debug("d");
    l.info("i");
    assert.equal(out.length, 1);
  });

  test("an unknown level falls back to info and says so", () => {
    const { l, out } = logger("verbose");
    assert.equal(l.getLevel(), "info");
    assert.deepEqual(out, ["2026-10-09T21:14:03.120Z WARN  log.bad_level level=verbose using=info\n"]);
    l.setLevel("toString");
    assert.equal(l.getLevel(), "info");
  });

  test("setLevel changes the level of the logger and its children", () => {
    const { l, out } = logger("error");
    const child = l.child({ area: "x" });
    child.info("before");
    l.setLevel("info");
    child.info("after");
    assert.equal(out.length, 1);
    assert.match(out[0], / after area=x\n$/);
  });

  test("the default writer is stdout", (t) => {
    const written = [];
    t.mock.method(process.stdout, "write", (text) => written.push(text));
    log.createLogger({ now: () => T }).info("x", { a: 1 });
    t.mock.restoreAll();
    assert.deepEqual(written, ["2026-10-09T21:14:03.120Z INFO  x a=1\n"]);
  });

  test("lines are stamped with the current time by default", () => {
    const out = [];
    const before = Date.now();
    log.createLogger({ write: (text) => out.push(text) }).info("x");
    const stamped = Date.parse(out[0].split(" ")[0]);
    assert.ok(stamped >= before && stamped <= Date.now());
  });
});

describe("child loggers", () => {
  test("a child adds its fields before the call's, and nests", () => {
    const { l, out } = logger();
    const req = l.child({ req: "a1b2c3d4", user: 12 });
    req.child({ name: "alice" }).info("http.request", { status: 200 });
    assert.equal(
      out[0],
      "2026-10-09T21:14:03.120Z INFO  http.request req=a1b2c3d4 user=12 name=alice status=200\n"
    );
  });

  test("a call's field overrides the child's in place", () => {
    const { l, out } = logger();
    l.child({ user: 12, name: "alice" }).info("x", { user: 7 });
    assert.equal(out[0], "2026-10-09T21:14:03.120Z INFO  x user=7 name=alice\n");
  });

  test("children share the parent's output", () => {
    const { l } = logger();
    const child = l.child({ a: 1 });
    const out = [];
    l.setWrite((text) => out.push(text));
    child.info("x");
    assert.equal(out.length, 1);
  });
});

describe("test/helpers/logs.js", () => {
  test("parse reads a line back into its parts", () => {
    const err = new Error("bad \"thing\"\nhere");
    const { l, out } = logger();
    l.error("x.y", { user: 12, name: "two words", err });
    const p = parse(out[0]);
    assert.equal(p.time, "2026-10-09T21:14:03.120Z");
    assert.equal(p.level, "error");
    assert.equal(p.event, "x.y");
    assert.deepEqual(p.fields, { user: "12", name: "two words", err: "Error: bad \"thing\"\nhere" });
    assert.ok(p.stack.length > 0 && p.stack.every((f) => f.startsWith("at ")));
  });

  test("captureLogs collects the app logger's lines and restore puts it back", () => {
    const before = log.getLevel();
    const logs = captureLogs();
    assert.equal(log.getLevel(), "debug");
    log.child({ user: 12 }).debug("game.over", { game: 3, result: "1-0" });
    assert.equal(logs.lines.length, 1);
    assert.ok(logs.find("game.over", { game: 3, user: 12 }));
    assert.equal(logs.find("game.over", { game: 4 }), undefined);
    assert.equal(logs.find("game.start"), undefined);
    logs.restore();
    assert.equal(log.getLevel(), before);
    const after = captureLogs("error");
    log.info("ignored");
    assert.equal(after.lines.length, 0);
    after.restore();
  });
});
