# LorCiv — Design Notes

What the code does and, more importantly, why. This describes the **current
state**, not a plan: when a decision changes, change it here in the same
commit. What is not built yet, and the order it comes in, is `docs/plan.md`;
how to run and deploy is `docs/setup.md`; conventions for working in the repo
are in `docs/CLAUDE.md`.

LorCiv is a multiplayer web version of Civ Lite, a small turn-based 4X game
(explore, expand, exploit, exterminate) on a hex map: up to four seats, each a
signed-in human or a server-run AI. It is a separate app from LorChess, on the
same stack and conventions; its generic parts (accounts, sessions, logging,
the database layer, the page shell) were copied from there and are now its own.

## Where things stand

Milestone M0 of the plan is done: accounts and sessions work, and the pages
are a login card, a placeholder lobby and the legal pages. **There is no game
yet.** The sections below describe what exists. The last section lists what
has been decided but not built.

## Tech stack

- **Express 5** — static pages + REST API.
- **Socket.IO** — rooms, auto-reconnect, acks for the live game (vs hand-rolling `ws`).
- **better-sqlite3** — single-file, synchronous, zero-ops. Schema written to port to Postgres later.
- **Raw SQL** via prepared statements in `src/db/queries.js`; no ORM.
- **express-session** + `better-sqlite3-session-store` — one session cookie serves REST and the Socket.IO handshake.
- **argon2** for password hashing.
- **No bundler, no framework.** Static HTML pages with their scripts in `public/js/`.

## Layout

```
src/
  app.js server.js config.js log.js
  auth/        routes (register, login, logout, me), session, middleware,
               throttle, usernamePolicy
  db/          index.js (open, schema, migrations), schema.sql, queries.js,
               reset.js and the user CLI scripts (setPassword, deactivate)
  game/        socket.js — Socket.IO infrastructure; game events come in M2
public/
  index.html login.html lobby.html terms.html privacy.html
  css/styles.css
  js/          login.js net.js authGuard.js shell.js
test/          unit/, integration/, helpers/ (server.js, logs.js)
docs/          CLAUDE.md design.md plan.md setup.md
```

`src/shared/` (the engine, served at `/js/` ahead of `public/`) does not exist
yet; `app.js` says where it will be mounted.

## Authentication

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`.
  Register and login both go through `startSession`, which calls
  `req.session.regenerate` first (anti-fixation) and then stores `userId`.
- **REST protection:** `requireAuth` middleware. **Page protection:**
  `public/js/authGuard.js` calls `/api/me` on load and bounces to login on 401.
  That is a UX redirect, not a security boundary; every privileged action is
  enforced server-side.
- **Socket auth:** the same session middleware is attached to the Socket.IO
  engine (`io.engine.use`). The session is reloaded from SQLite at the socket
  handshake and before every incoming event; missing or expired sessions
  cannot act, and established sockets are disconnected on validation failure.
  These checks do not refresh or recreate a session. No separate token.
  Sockets also join a room per session ID: logout and session regeneration
  disconnect every tab using the old session before returning success.
  Separate logins on the same account remain connected.
- Cookie: `httpOnly`, `sameSite: lax`, `secure: "auto"` behind `trust proxy`
  (Caddy terminates TLS), 7 days. Sessions are rows in SQLite.
- Usernames that differ only in case are one name: registration refuses the
  second, and a `COLLATE NOCASE` unique index backs that check where the
  database allows it (an old database with such pairs boots with a warning).
  Login matches the exact spelling.
- **Username policy** (`src/auth/usernamePolicy.js`): beyond 3–20 of
  `[A-Za-z0-9_]`, registration refuses names containing "lor" anywhere (the
  owner's prefix, shared with LorChess; this knowingly costs Taylor and Lord),
  names that pass for staff or for a UI label (admin, mod, bot, guest, cpu,
  player, spectator…), and English slurs and profanity. Names are compared
  lowercased, without underscores, with digits read as letters and stretched
  letters squeezed; short words only count as a whole part of the name (split
  on `_` and camelCase), so classic and Essex pass. Runs of three or more
  digits are numbers, not letters (Ryan1995). Every refusal gets one generic
  message so the lists cannot be probed, and the lists never reach the
  browser. Civilization names (Rome, Greece…) are not reserved: a player is
  always shown as "username (civ)". There is no reserved AI account: AI seats
  are seats, not users.
- **Deactivation** (`users.deactivated_at`, set by `npm run user:deactivate`):
  a flag, not a deletion, so game history will keep its names, the name stays
  taken, and reactivation restores everything. Login refuses it after the
  password check (so the message leaks nothing to someone without the
  password); `requireAuth` and the socket session check refuse it too, because
  a login racing the command can create a session after the command deleted
  them. The command runs in its own process and cannot reach live sockets, so
  the server sweeps them every `DEACTIVATION_SWEEP_MS`. Account deletion is
  not built yet (plan, M4): it needs to know which game rows to keep.
- **Throttling** (`src/auth/throttle.js`): argon2 is expensive on purpose, so
  register and login are limited. Per client IP, failed logins (unknown users
  included) and registrations that reach the hash are counted over a sliding
  window and answered with 429 past the limit; successful logins and rejected
  registrations do not count. A global cap on argon2 calls in flight (one per
  vCPU) answers 503 instead of queueing, which holds even against many IPs.
  The client IP is `req.ip`, i.e. what Caddy put in `X-Forwarded-For`; that is
  only trustworthy because the app's port is not reachable except through
  Caddy. State is in memory and a restart clears it. No per-account limit: it
  would let anyone lock a player out by typing their name. Passwords are 6–128
  characters; a longer one fails login without being verified.

## Logging

The server runs unattended, and by the time someone reports a problem the
process that knew why has moved on or restarted. The log is the only record,
so it is written for that reader: someone on the server with `less` and
`grep`, days later, reconstructing what happened.

- **One module, `src/log.js`, no dependency.** Server code logs through it and
  never calls `console.*` directly. Exempt: the CLI scripts in `src/db/`,
  whose `console.log` is a tool talking to the person running it.
- **Format: logfmt, one line per event, all to stdout.**
  ```
  2026-10-10T08:14:03.120Z INFO  auth.login user=7 name=bob ip=203.0.113.9
  2026-10-10T08:14:05.004Z ERROR socket.handler_failed user=7 name=bob event=game:action err="TypeError: ..."
      at applyAction (src/game/rooms.js:412:9)
  ```
  Time (UTC, ISO), level, event name, then `key=value` fields; values with
  spaces, quotes, `=` or anything outside printable ASCII are JSON-quoted, so
  no value can break the line or fake a field. An error is written as
  `name: message`, its stack frames on indented lines below. Every level goes
  to stdout so pm2's out log holds the whole story in order; the error log
  then only gets what bypasses the logger (Node's own crash output), so
  anything there is worth a look. The logger stamps the time itself.
- **Levels.** `error`: something failed and someone should look. `warn`:
  unexpected or slow, but served. `info`: a normal event worth a record.
  `debug`: detail for an investigation. `LOG_LEVEL` (`src/config.js`) defaults
  to `info`; an unknown value logs `log.bad_level` and uses `info`. The tests
  run `silent`, `TEST_LOG=1` makes them `debug`, and `captureLogs()` in
  `test/helpers/logs.js` lets a test assert that a line was written.
- **Event names are fixed, `area.event`** in snake_case, so a search for one
  finds all of it and this list is the full set. Fields are flat and
  lower-case; IDs are numbers (`user=12`).
- **Context is explicit.** `log.child(fields)` returns a logger that adds
  those fields to every line. Each `/api` request gets an 8-hex `req` id and
  `req.log` (with `req`, `user`, `name`); each socket gets `socket.log` (with
  `user`, `name`). Handlers log through those, so an error line and its
  request line share a `req`.

Events:

- **Process** (`src/server.js`): `process.start` (version, node, url, db
  path), `process.stop` (signal; on SIGTERM/SIGINT the process exits at once,
  which is safe because everything that matters is already in SQLite),
  `process.crash` (`error`, on `uncaughtException`/`unhandledRejection`; the
  process then exits 1 and pm2 restarts it).
- **HTTP:** `http.request` once per `/api` request when the response
  finishes: `method`, `route` (the matched pattern, e.g. `/api/me`, never the
  query string), `status`, `ms`, and `user`/`name` when signed in. `error`
  for 5xx, `warn` at 1 s or slower, `info` otherwise. 4xx stays `info`: a
  signed-out page load gets a 401 from `/api/me` every time. Static files are
  not logged. A request the client abandoned has `aborted=true`; one that
  never reached a route (unknown path, malformed JSON) has `route=unmatched`.
  Routers are mounted through `api()` in `src/app.js` so the route survives
  an error leaving its router. `http.unhandled` (`error`) is an exception no
  handler caught, with its stack; the client gets a bare 500
  `{ error: "Server error." }`, never the stack.
- **Auth** (the only lines with `ip`): `auth.register`, `auth.login`,
  `auth.login_failed`, `auth.throttled` (`warn`, with `kind=login|register`);
  without `ip`: `auth.busy` (`warn`, the argon2 cap), `auth.logout`, and
  `auth.register_error`, `auth.login_error`, `auth.logout_error` (`error`,
  an exception). `auth.login_failed` has `reason=wrong_password`,
  `unknown_user` or `deactivated`, and `user`/`name` from the account's own
  record when there is one: what was typed as the username is never logged,
  because people sometimes type their password there.
- **Sockets:** `socket.connect`, `socket.disconnect` (`reason`), both with
  `user`/`name` from `socket.log`; `socket.handler_failed` (`error`, the
  per-event wrapper: `event`, `err`) and `socket.task_failed` (`error`,
  `safely`: `task`, `err`).
- **Data:** `db.migrated` (`added=<table>.<column>`), `db.case_duplicates`
  (`warn`, `names`).

What is never logged, and where personal data may appear:

- **Users** appear as `user=<id> name=<username>`, always together: the name
  for reading, the id because a deleted account's name can be registered again.
- **IPs** appear only on the `auth.*` lines above, for dealing with password
  guessing and mass sign-ups. Never on requests, sockets or games.
- **Never:** passwords or hashes, session ids, cookies, request bodies, query
  strings, uploaded content. As a safety net the logger writes any field named
  `password`, `hash`, `cookie`, `session` or `secret` as `[redacted]`.

## Database

`src/db/schema.sql` only ever `CREATE`s, which is idempotent. Adding a column to
a table that already exists needs `ALTER`, so those go through
`addColumnIfMissing` in `src/db/index.js`, which runs at every boot and brings
an older database up to date. A new column on an existing table therefore needs
a line there, or existing databases never get it. There are no migrations yet.

Tables: `users` (id, username, password_hash, created_at, deactivated_at) and
`sessions`, which the session store creates itself. Game tables come with M2.

## Sockets

`src/game/socket.js` is infrastructure only for now: the session handshake and
per-event re-check described under Authentication, the `welcome` event with
the user's id and name, a `session:<sid>` room (for logout) and a
`user:<id>` room (for messages that must reach every tab a person has open),
the deactivation sweep, and the `on()` wrapper that catches a handler's
exception, logs it and fails the caller's ack. Socket.IO runs listeners with
no try/catch of its own and better-sqlite3 throws synchronously, so without
the wrapper one bad event would take the process, and every live game, down.
The game events are registered in this file as they are built.

## Pages and the shell

Three pages. `login.html` (`login.js`) posts to register or login and goes to
`lobby.html` on success. `lobby.html` is a placeholder until M3. `index.html`
redirects to login. `public/js/shell.js` builds the top bar and the left rail
on every signed-in page, and `authGuard.js` fills the user bar in it; shell
loads first so the user bar it creates is the one authGuard finds. The
stylesheet is dark by default with a light scheme behind
`<html data-scheme="light">`; nothing sets it yet, and there is no settings
page. There is no theme customisation: that was LorChess's board colours and
piece images, which have no counterpart here.

## Terms and privacy

`public/terms.html` and `public/privacy.html` are plain static pages without
`shell.js` or `authGuard.js`, because people must be able to read them before
they have an account; `test/integration/static.legal.test.js` keeps them
public. They are linked from the login card and from the bottom of the rail.
Acceptance is implied by registering and is not recorded.

The privacy policy states facts that the code and operations decide. If one of
these changes, update the page and its date in the same commit: what is
stored (today: the account and the session); sessions last 7 days
(`src/auth/session.js`); IPs live in the throttle's memory for
`AUTH_WINDOW_MS` (15 min) and are written only on the `auth.*` log lines;
what the logs hold and their 14-day lifetime (log rotation, `docs/setup.md`);
nothing is visible when signed out; there is no analytics. The page also
promises nightly backups to Backblaze B2 kept for at most 90 days, which M4
sets up; check it again then. The contact address is `lorciv@lorand77.dev`.
When games, chat and spectating arrive (M2, M3), "What we store" and "Who can
see it" must grow with them.

## Decided, not yet built

These decisions are made and the plan (`docs/plan.md`) builds on them. They
move up into the sections above as the code lands.

1. **Server-authoritative.** The server owns one engine instance per game;
   clients send actions, the server validates, applies, persists and broadcasts.
2. **Full snapshot after every action**, in the format of the old game's
   save file. Measured at 6–19 KB over a whole game. No action replay on the client.
3. **Sequential turns**, as the engine already does.
4. **Games may span days**: resume from snapshot, a per-game turn timer
   (presets none, 1 min, 3 min, 10 min, 1 h, 1 day, 3 days; default 3 min),
   and a missed-turn limit (3) after which the seat is handed to the AI.
5. **AI runs on the server**, on the main thread: a civ's turn takes 5 ms on
   average and 57 ms at worst. Its module-level strategy state moves onto
   the game in M1.
6. **A user may be in several games at once.** Unlike LorChess's one-at-a-time.
7. **All active games are rebuilt at boot**, not lazily, so turn timers re-arm
   whether or not anyone is connected.
8. **Always four civs**; empty seats are AI. The engine is hardcoded to four.
9. **Single player versus AI goes through the server too.** No local mode.
10. **Broadcasts go through a per-seat view function** that returns everything
    for now, so fog of war could be added in one place later.
11. **Tables waiting for players are `games` rows** with status `lobby`.
12. **Hosting:** the LorChess EC2 instance, own user, own port (3001), own
    database, behind the same Caddy, at `lorciv.lorand77.dev`.
