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

Milestones M0 to M4 of the plan are done and the site is live at
`lorciv.lorand77.dev`: accounts and sessions work; the engine lives in
`src/shared/`; the server runs games in rooms, persisted after every action and
rebuilt at boot; tables in the lobby seat up to four people with AI in the
other seats; turn timers end an absent player's turn and hand the seat to the
AI after too many misses; the game page plays through the server with chat and
survives a reload and a server restart. Of the polish (M5), account deletion,
the leaderboard and replays exist. The sections below describe what exists.
The last section lists what is still ahead.

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
               retention.js (the chat sweep), reset.js and the user CLI
               scripts (setPassword, deactivate, deleteUser)
  game/        rooms.js (live games: engine, seats, persistence), socket.js
               (every Socket.IO event), routes.js (/api/games),
               leaderboard.js (/api/leaderboard)
  shared/      the engine, served at /js/ ahead of public/ (see "The engine")
               hex.js state.js mapgen.js game.js ai.js snapshot.js settings.js
               actions.js replay.js
public/
  index.html login.html lobby.html game.html replay.html leaderboard.html
  terms.html privacy.html
  css/         styles.css (every page but the game), game.css (game and replay)
  assets/      terrain and resource PNGs
  js/          login.js net.js authGuard.js shell.js lobby.js leaderboard.js
               renderer.js (the canvas map) ui.js (the game page)
               replay-page.js (the replay page)
tools/         simulate.js — N AI-only games, by hand
test/          unit/, integration/, helpers/ (server.js, logs.js)
docs/          CLAUDE.md design.md plan.md setup.md
```

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
- **Same origin only** (`src/auth/origin.js`). `lax` keeps other sites out but
  not other hosts of this one: `lorchess.lorand77.dev` is the same site to a
  browser, so a script there would have the cookie sent with a socket it
  opens to LorCiv, or with a form it posts. WebSockets and body-less posts are
  outside CORS, so the server checks: when a request carries an `Origin`
  (every WebSocket handshake and every POST from a browser does, and a page
  cannot set it), its host must be the `Host` the request was sent to.
  Socket.IO's `allowRequest` applies it to every handshake; on `/api` it
  applies to everything but GET, HEAD and OPTIONS, before any route runs (403).
  No Origin passes (curl, the tests); `null` does not. Comparing with `Host`
  needs no configured URL: it holds on localhost and behind Caddy, which
  passes `Host` through.
- Usernames that differ only in case are one name: registration refuses the
  second, and a `COLLATE NOCASE` unique index backs that check where the
  database allows it (an old database with such pairs boots with a warning).
  Login matches the exact spelling.
- **Username policy** (`src/auth/usernamePolicy.js`): beyond 3–20 of
  `[A-Za-z0-9_]`, registration refuses names containing "lor" anywhere (the
  owner's prefix, shared with LorChess; this knowingly costs Taylor and Lord),
  with one exception: `lorand`, the owner's own name, in exactly that spelling
  (no capitals, no digits, nothing appended),
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
  the server sweeps them every `DEACTIVATION_SWEEP_MS`. A seat the person
  holds in a live game is left to the turn clock, like any absent player's.
- **Deletion** (`npm run user:delete`, `src/db/deleteUser.js`) is built on
  deactivation. The `users` row cannot go, because seats and action rows point
  at it and the games are the other players' record too. So it stays, renamed
  `deleted-<id>` (a name registration can never produce), without a password,
  and deactivated. What is only the person's is deleted in one transaction: the
  chat they wrote and their sessions; tables they host are cancelled and seats
  they hold at other tables released. A human seat in a live game refuses the
  deletion: deactivate first, let the clock hand the seat over, then delete (a
  game with no clock never will; its other players can leave it). The command
  shows counts, wants the username typed back, turns on `secure_delete` and
  checkpoints the WAL afterwards, so the content does not linger in the file.
  It runs in its own process, so the lobby pages of others learn of a cancelled
  table on their next refresh.
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
  without `ip`: `auth.busy` (`warn`, the argon2 cap), `auth.origin_refused`
  (`warn`, `via=http|socket`, `origin`, and for http `method` and `path`: a
  request from another host's page), `auth.logout`, and
  `auth.register_error`, `auth.login_error`, `auth.logout_error` (`error`,
  an exception). `auth.login_failed` has `reason=wrong_password`,
  `unknown_user` or `deactivated`, and `user`/`name` from the account's own
  record when there is one: what was typed as the username is never logged,
  because people sometimes type their password there.
- **Sockets:** `socket.connect`, `socket.disconnect` (`reason`), both with
  `user`/`name` from `socket.log`; `socket.handler_failed` (`error`, the
  per-event wrapper: `event`, `err`) and `socket.task_failed` (`error`,
  `safely`: `task`, `err`).
- **Games:** `game.table` (`game`, `host`, `seed`, `seats`: a table created),
  `game.join_seat`, `game.leave_seat` (`game`, `seat`, `user`), `game.cancel`,
  `game.start` (`game`, `host`, `seed`, `turn_time`, `seats`), `game.resume`
  (`game`, `seq`, `turn`, `status`: a room rebuilt from the database),
  `game.timeout` (`game`, `seat`, `user`, `missed`: a turn the server ended),
  `game.takeover` (`game`, `seat`, `user`, `reason=timeout|leave`), `game.over`
  (`game`, `winner`, `turn`, `seq`), `game.abort` (`game`, `reason=no_humans`),
  `game.abandon_sweep` (`aborted`, `days`), `game.persist_failed` (`error`: the
  write after an action failed and the room was rolled back),
  `game.sweep_failed` (`error`), `game.resume_failed` (`error`, `game`, `err`:
  a game that could not be rebuilt at boot and was skipped), `game.join` (`game`, `seat` or
  `watcher=true`), and `game.action` once per accepted player action (`game`,
  `seq`, `turn`, `seat`, `type`: the kind of action, never its payload, which
  `game_actions` holds). `game.action_refused` (`type`, `error`) at `debug`.
  The server's own actions have their own lines (`game.timeout`,
  `game.takeover`).
- **Process, continued:** `process.resumed` (`games`: active games rebuilt at boot).
- **Chat:** `chat.retention` (`removed`, `days`), `chat.retention_failed`
  (`error`). Never the text.
- **Data:** `db.migrated` (`added=<table>.<column>`), `db.case_duplicates`
  (`warn`, `names`).

What is never logged, and where personal data may appear:

- **Users** appear as `user=<id> name=<username>`, always together: the name
  for reading, the id because a deleted account's name can be registered again.
- **IPs** appear only on the `auth.*` lines above, for dealing with password
  guessing and mass sign-ups. Never on requests, sockets or games.
- **Never:** passwords or hashes, session ids, cookies, request bodies, query
  strings, chat text. As a safety net the logger writes any field named
  `password`, `hash`, `cookie`, `session` or `secret` as `[redacted]`.

## Database

`src/db/schema.sql` only ever `CREATE`s, which is idempotent. Adding a column to
a table that already exists needs `ALTER`, so those go through
`addColumnIfMissing` in `src/db/index.js`, which runs at every boot and brings
an older database up to date. A new column on an existing table therefore needs
a line there, or existing databases never get it. There are no migrations yet.

Tables: `users` (id, username, password_hash, created_at, deactivated_at);
`sessions`, which the session store creates itself; `games` (status, host,
seed, settings JSON, the snapshot JSON, seq, turn, current seat, deadline,
winner, timestamps), `game_seats` (one row per seat: open, human or ai, the
user, the difficulty, missed turns), `game_actions` (every player action in
order, as JSON, plus the server's `timeout` and `leave` rows) and
`chat_messages`. The snapshot column is overwritten after every action; it is
what a room is rebuilt from. The action rows are an audit trail and the raw
material for replays; AI turns are not rows, since they follow
deterministically from the end of turn that triggered them. Chat is swept
`CHAT_RETENTION_DAYS` after a game ends (`src/db/retention.js`, started from
`src/server.js` so the tests do not run it on their own).

## Sockets

`src/game/socket.js` owns every Socket.IO event. The infrastructure: the
session handshake and per-event re-check described under Authentication, the
`welcome` event with the user's id and name, a `session:<sid>` room (for
logout) and a `user:<id>` room (for messages that must reach every tab a
person has open), the deactivation sweep, and the `on()` wrapper that catches a
handler's exception, logs it and fails the caller's ack. Socket.IO runs
listeners with no try/catch of its own and better-sqlite3 throws
synchronously, so without the wrapper one bad event would take the process,
and every live game, down. The game events are `game:join`, `game:action`,
`game:leave` and `chat:send`, and the lobby's `lobby:enter`, described under
"The game on the server" and "Playing together". The module also listens to
`rooms.events` and does the telling: `game:state` to every socket in a game's
room with its own view, `lobby:changed` to the lobby room, `turn:yours` to the
`user:<id>` room of the seat whose turn began.

## Pages and the shell

`login.html` (`login.js`) posts to register or login and goes to `lobby.html`
on success. `index.html` redirects to login. `public/js/shell.js` builds the
top bar and the left rail on every signed-in page except the game, and
`authGuard.js` fills the user bar in it; shell loads first so the user bar it
creates is the one authGuard finds. The stylesheet is dark by default with a
light scheme behind `<html data-scheme="light">`; nothing sets it yet, and
there is no settings page. There is no theme customisation: that was
LorChess's board colours and piece images, which have no counterpart here.

`lobby.html` (`lobby.js`) is the lobby: open tables, a form for a new table,
the user's games, live games to watch, who is online. `game.html` (`ui.js`,
`game.css`) is the game. Both are described under "The game on the server" and
"Playing together". The game page has no shell: the map wants the whole
viewport, so its sidebar carries the link back to the lobby and the user bar.

## Terms and privacy

`public/terms.html` and `public/privacy.html` are plain static pages without
`shell.js` or `authGuard.js`, because people must be able to read them before
they have an account; `test/integration/static.legal.test.js` keeps them
public. They are linked from the login card and from the bottom of the rail.
Acceptance is implied by registering and is not recorded.

The privacy policy states facts that the code and operations decide. If one of
these changes, update the page and its date in the same commit: what is
stored (the account, the session, the games a player takes part in with every
action and the result, visible to every signed-in player since spectating is
open, and in-game chat, seen by everyone in the game and deleted
`CHAT_RETENTION_DAYS` after it ends); what deletion removes and keeps (see
Authentication); sessions last 7 days
(`src/auth/session.js`); IPs live in the throttle's memory for
`AUTH_WINDOW_MS` (15 min) and are written only on the `auth.*` log lines;
what the logs hold and their 14-day lifetime (log rotation, `docs/setup.md`);
nothing is visible when signed out; there is no analytics. The page also
promises nightly backups to Backblaze B2 kept for at most 90 days, which M4
sets up; check it again then. The contact address is `lorciv@lorand77.dev`.
The page describes the game as it is; the backups it promises run nightly on
the server (`scripts/backup.sh`, `docs/setup.md`).

## The engine: `src/shared/`

The engine is the JavaScript port of Civ Lite from `civ_lite-old/`, about
2,300 lines: hex math, the catalogues and entities, map generation, the rules
and turn loop, and the AI. It was already separate from the canvas UI,
runnable headless in Node, and deterministic from a seed. M1 moved it here
and made the changes a server needs.

### Files

| file | holds | M1 change |
|---|---|---|
| `hex.js` | hex math (`hexNeighbors`, `hexDistance`, `hexesInRange`, `hexLine`, `axialRound`, `hexToPixel`, `pixelToHex`, `hexCorners`, `HEX_SIZE`) | split from the renderer |
| `state.js` | catalogues (units, techs, buildings, improvements, resources, terrain), `Unit`, `City`, `Civilization`, movement and line of sight | units and cities carry an `id` |
| `mapgen.js` | seeded map generation and the PRNG | the PRNG exposes `getState`/`setState` |
| `game.js` | `Game`: rules, combat, yields, production, tech, `endTurn`, score | ids, `setup`, five order methods, score history, AI state |
| `ai.js` | `aiTakeTurn`, `runCpuTurns` | strategy memory moved onto the game |
| `snapshot.js` | `serializeGame`, `deserializeGame`, format version 2 | from the old save code, extended |
| `settings.js` | the allowlists: difficulties, turn times, action names | new |
| `actions.js` | `applyAction`, the one validator for player actions | new |
| `replay.js` | `replayAll`: a game's states rebuilt from its seed and action rows | new (M5) |

The canvas renderer that used to share `hex.js` is `public/js/renderer.js`,
moved as it was except that it loads its images from `/assets/`. The old
`simulate.js` is `tools/simulate.js`. The old page (`index.html`, `style.css`,
`ui.js`) stays in `civ_lite-old/` until M2 rewrites it against the server.

### One file, two runtimes

`src/app.js` mounts `src/shared/` at `/js/` ahead of `public/`, as LorChess
does, so `/js/game.js` is the engine and `/js/shell.js` falls through to
`public/js/`. The engine files are classic scripts that refer to each other by
bare names (`UNIT_DEFS`, `hexDistance`, `Game`), and they stay that way: a
factory wrapper would have touched every cross-file reference in 2,300 lines
for no runtime gain. Each file is strict and has a Node header and a Node
tail, the convention LorChess's `lorfish.js` uses:

```js
// Node: the files this one reads as bare names, hoisted onto globalThis.
// Browser: they are globals already, from the earlier <script> tags.
if (typeof module !== "undefined" && module.exports) {
  Object.assign(globalThis, require("./hex"), require("./state"));
}
...
if (typeof module !== "undefined" && module.exports) module.exports = { Game, ... };
```

Browser load order: `hex`, `state`, `mapgen`, `game`, `snapshot`, `settings`,
`actions`, then `renderer`. The game page never loads `ai.js`; the replay page
does, because it re-runs the AI (see "Looking back"). Nothing in
`src/shared/` touches `document`, `window`, `localStorage` or Node-only APIs;
`test/unit/engine.load.test.js` greps for it. The moved files keep the
original's single quotes and four-space indent: match the file you are in.

### Identity

Units and cities have an integer `id` from `game.nextId`, assigned at the
three places the engine creates them: the starting units, production
(`_completeItem`, also reached by buying) and `foundCity`. A city keeps its id
through capture, and its buildings except the palace, which belongs to its
civ: a conqueror would otherwise collect a palace's yields for every capital
it took (the original did, a departure made on 2026-10-11). A civ that takes
its own original capital back gets its palace back; the palace is not moved
to another city while the capital is lost. After a capture the captured city
and the loser's remaining cities pick their worked tiles again, so no city
works a tile its civ no longer owns. `game.unitById(id)` and
`game.cityById(id)` are linear scans over the civs; a game has a few dozen of
each, and a scan beats keeping an index in step with every capture. Clients
name a unit or city by id and never by position; object identity never
crosses the wire.

### Rules changed from the original (2026-10-11)

- **A new unit needs room.** `unitSpawnTile` gives the city tile, else the
  first neighbour whose slot for that kind of unit is free and that holds no
  other civ's unit, civilian or city, else nothing. With nothing, buying the
  unit is refused before any gold is spent, and finished production waits at
  the head of the queue, progress kept, until room frees up. The original put
  the unit on the city tile regardless, so two units shared one tile and a
  tile pointed at only one of them; a game reloaded from its snapshot then
  differed from the live one, which broke replays.
- **No victory while a civ can still found.** A civ with no original capital
  but a settler keeps the game open. Without that, in an all-human game the
  first civ to found held every original capital there was and won on turn 2.
  A civ with neither city nor settler can never found and does not count.
- **Buying counts the work done.** `buyCost(city, key)` is twice the
  production still needed: the item at the head of the queue counts its
  progress, anything else costs twice its full cost. Buying the head item
  spends that progress; a building then leaves the queue and a unit's next
  copy starts from zero. The original charged full price and left a bought
  building in the queue, where its production was wasted. The game page's buy
  buttons show `buyCost`, so they agree with the server.

### Engine API

The methods the AI calls kept their signatures and return shapes:
`moveUnit(unit, q, r, cost)`, `doAttack(unit, q, r)` (returns a message),
`canFoundCity`/`foundCity`, `upgradeUnit`, `buyItem` (`[ok, message]`),
`startImprovement` (boolean), `endTurn()`.

Five methods, all returning `[ok, message]`, replace what the old UI mutated
directly; their rules are the old UI's rules:

- `fortify(unit)`: military, moves left, not already fortified. Adds the first
  quarter of fortify bonus at once, as the old button did.
- `heal(unit)`: military, full moves (has not moved this turn), not healing.
- `skip(unit)`: moves left; sets them to zero.
- `setProduction(city, key)`, after `canProduce(city, key)`: `key` is a unit
  or a building other than the palace; its tech is known; a unit needing a
  resource needs a tile of it owned by the civ; a building is not already
  built. Replaces the queue with that one item and resets progress, as the
  old list did.
- `setResearch(civ, key)`: the tech is not known and its prerequisites are.
  It may replace research in progress, as the old tree allowed.

Also on the game: `setup` (seed and the flags the civs were created with, so a
snapshot can rebuild the same map); `scoreHistory`, one entry per completed
round, recorded by `endTurn` when the turn counter advances (`computeScore`
per civ; the victory graph draws it); `aiState`, the per-civ strategy memory
that used to be a module-level object in `ai.js` and would have been shared by
every game on the server; and the PRNG's state, because bankruptcy draws from
it mid-game. `ai.js` has `runCpuTurns(game, maxTurn)`: while there is no
winner and the current civ is a CPU, take its turn and end it. It also stops
the moment the last human civ is eliminated: the turn order skips eliminated
civs, so otherwise the AI would play the rest of the game in that one call,
seconds of a blocked server (an AI-only game, which has no human to lose,
plays on). The simulator, the tests and `rooms.js` all use it.

**Determinism.** The map comes from the seed, combat has no randomness, the
AI has none, and the only mid-game draw is bankruptcy from the seeded PRNG.
So two games with the same seed and the same actions are identical, and a
game resumed from any snapshot continues exactly as the unresumed one would.
`test/unit/engine.determinism.test.js` checks both.

### `actions.js`: the one validator

`applyAction(game, seat, action)` returns `{ ok: true, message }` or
`{ ok: false, error, message }`. It is the only way a player's intent reaches
the engine, on the server (M2) and, for previews, in the browser. Checks, in
order: the game has no winner; `action.type` is in `settings.ACTION_TYPES`;
`seat` is the current player and not eliminated; the unit or city named by id
exists and belongs to the seat; a `key` is a string the catalogue holds as
its own property (`Object.hasOwn`), because `UNIT_DEFS[key]` alone accepts
`"constructor"` and the rest of `Object.prototype`, and an array that
stringifies to a real key; the move is legal by the engine
(`getReachableTiles` for `move`, which also gives the cost;
`getAttackableTiles` for `attack`; `canFoundCity`; `canProduce`; the Game
method's own check for the rest); then apply. `error` is a short code for the
client to switch on (`game_over`, `unknown_action`, `not_your_turn`,
`no_such_unit`, `no_such_city`, `not_yours`, `illegal`); `message` is the
engine's own wording where it has one.

| action | args | applies |
|---|---|---|
| `move` | unitId, q, r | `moveUnit` with the cost from `getReachableTiles` |
| `attack` | unitId, q, r | `doAttack` |
| `foundCity` | unitId | `foundCity` after `canFoundCity`; a settler with moves left |
| `buildImprovement` | unitId, key | `startImprovement`; a worker with moves left, key in `IMPROVEMENT_DEFS` |
| `fortify`, `heal`, `skip`, `upgrade` | unitId | the method of that name (`upgradeUnit`) |
| `setProduction`, `buy` | cityId, key | `setProduction`; `buyItem` after `canProduce` |
| `setResearch` | key | `setResearch` |
| `endTurn` | — | `endTurn` only; running the AI seats that follow is the server's job (`rooms.js`, M2) |

Handing a seat to the AI (`leave` in the plan) is not an engine action: it is
`civ.isCpu = true`, done by `rooms.js`.

### `snapshot.js`

Format version 2, the old save format plus what a resumed game needs:

```
{ version: 2,
  setup: { seed, cpuFlags, difficultyFlags },          // the map regenerates from the seed
  game:  { turn, currentPlayer, winner, nextId, rngState, scoreHistory, aiState,
           civs: [{ playerIndex, isCpu, gold, science, culture, currentResearch,
                    techsResearched, isEliminated, pendingMessages, researchJustCompleted,
                    originalCapital, cities: [{ id, ... }], units: [{ id, ... }] }] },
  tileMutations: [{ q, r, owner, improvement }] }      // tiles that differ from the generated map
```

`isCpu` is saved per civ as well as in `setup`, because a seat can be handed
to the AI mid-game. `serializeGame(game)` and `deserializeGame(obj)`;
deserialize throws on any other version. The old localStorage and file
download/upload functions are gone: from M2 the server holds every save.
Measured on a whole AI-only game: 6 KB at turn 25, 19 KB at turn 125. During
development a version bump means `npm run db:reset`; once games exist in
production, a bump comes with a migration in this file.

### `settings.js`

`DIFFICULTIES` (`prince`, `king`, `emperor`; a test checks they are the keys
of the engine's `DIFFICULTY_DEFS`), `TURN_TIMES` (`none`, `1m`, `3m`, `10m`,
`1h`, `1d`, `3d`, each with its milliseconds and label; `turnTimeOf(key)`),
`DEFAULT_TURN_TIME` (`3m`), `MISSED_TURN_LIMIT` (3), `SEATS` (4) and
`ACTION_TYPES`. The server resolves every key a client sends against these;
nothing else keeps a list.

### Tests

`test/unit/engine.*.test.js`: every shared file loads in Node and keeps to
the two-runtime rules; two games from one seed are identical, and a game
resumed from a snapshot matches the original to the end; serialize after
deserialize is the identity at several points of a game, and the snapshot
carries ids, random state, score history, AI memory and `isCpu`; a batch of
AI-only games finishes with unique ids and one score entry per round;
`applyAction` refuses the wrong seat, a finished game, an unknown type, a
unit that is not the seat's, an unreachable tile, an unknown item and a key
that is not the catalogue's own, and applies each valid action; the AI stops
when the last human civ falls; the settings agree with the engine's
catalogues.
`test/integration/static.shared.test.js`: `/js/game.js` is served and
`/js/shell.js` still falls through. The engine tests take about 20 s, most of
it AI play.

## The game on the server

The server holds the authoritative state. `src/game/rooms.js` keeps one
in-memory room per live game: the engine instance, its seats, its settings and
the JSON last written to the database. Clients are never trusted for legality,
turn or seat.

- **Creating a game.** `POST /api/games` (`src/game/routes.js`) with four
  seats, each `human`, `open` or `ai` with a difficulty, an optional seed and
  a turn-time key. Exactly one seat is human and it is the requester's. Every
  key is checked against `src/shared/settings.js`, never trusted. A
  difficulty is the AI's handicap, so only an `ai` seat keeps one: a human or
  open seat is stored as `prince` whatever the request says, and the start
  gives every non-AI seat `prince` too, so no person ever plays with the AI's
  bonuses. With no open
  seat the game starts at once; otherwise it waits in the lobby as a table
  (see "Playing together"). Starting builds the engine from the seed, lets the
  AI seats before the first human seat take their turn, and writes the seats
  and the first snapshot; the page then navigates to `game.html?id=<id>`.
  `GET /api/games` lists the games and tables the user holds a seat in,
  newest activity first; `GET /api/games/:id` is readable by anyone signed
  in, because spectating is open.
- **Joining.** `game:join {gameId}` answers with the full state
  (`rooms.viewFor`): the sequence number `seq`, status, winner, settings, the
  seats with their players' names, the caller's own seat (`null` for a
  spectator) and the snapshot. The socket joins the `game:<id>` room. The same
  event serves the first load, a reload and a reconnect; there is no separate
  catch-up.
- **Acting.** `game:action {gameId, seq, type, ...}`. The server finds the
  caller's seat (a spectator gets `not_seated`), refuses a `seq` that is not
  the room's with `stale` and sends that socket the current state, so nobody
  acts on an old view, then `rooms.applyPlayerAction`: the seat's pending
  messages are cleared (they went out with the previous state), the shared
  validator applies the action, the AI seats up to the next human play at once
  (`runCpuTurns`) so the next human sees the whole round, victory is checked,
  the deadline is computed if the turn changed hands, `seq` increments, and the snapshot,
  the row's summary columns, the action row and any seat change are written in
  one transaction (`commit` in `rooms.js`; the same path serves the server's
  own `timeout` and `leave` actions). If the write fails the room is rebuilt
  from the last written snapshot and the player gets `server_error`. If
  anything throws before the write (the validator, the engine, the AI), the
  room is rebuilt the same way before the error goes on to the socket's
  wrapper (`socket.handler_failed`) or the sweep (`game.sweep_failed`), so
  memory never holds a half-applied action the database and the action log
  do not (`guarded` in `rooms.js`). On
  success every socket in the room gets `game:state` with its own view, and
  the ack carries the engine's message (a combat result, a founded city).
  Only the fields an action can carry are stored: `type`, `unitId`, `cityId`,
  `q`, `r`, `key`.
- **Per-seat views.** `viewFor(room, seat)` is called once per socket on every
  broadcast and returns the snapshot without `rngState` and `aiState`
  (`clientSnapshot`): the engine is deterministic, so with them a player
  could run the AI ahead or know what a bankruptcy will take. The browser's
  Game is for previews and needs neither; the database keeps the full
  snapshot, and replays get everything once the game is over. The seed stays,
  since the map is rebuilt from it. If fog of war ever comes, this is the one
  place to filter.
- **Victory.** `game.winner` set: status `finished`, `winner_seat` and
  `finished_at` on the row, `game.over` in the log; further actions answer
  `game_over`.
- **Restarts.** `rooms.resumeAll()` runs when the app is built: every active
  game is rebuilt from its snapshot and seats (`game.resume`), its deadline
  read back, and the sweeps start. A game is never lost to a restart, and a
  turn that ran out while the server was down ends on the first sweep. A game
  that cannot be rebuilt (a snapshot version with no migration, a hand-edited
  row) is logged (`game.resume_failed`) and left in the database as it is; it
  does not keep the other games, or the server, from starting.

### The game page

`public/game.html` with `public/js/ui.js` and `public/css/game.css`, rewritten
from the original's page. The page never changes game state. It keeps a local
`Game` built from the latest snapshot (`deserializeGame`) for previews only:
reachable and attackable tiles, yields, costs, which techs are available, what
a city may build (`canProduce`). Every click or key that means something
becomes one `game:action`; the ack shows the engine's message; the following
`game:state` broadcast replaces the local game and redraws. One action is in
flight at a time (`pending`), and the end-turn button says so. The server
broadcasts before it answers, so the ack redraws the sidebar's buttons once
`pending` is clear. The action is sent with an ack timeout (30 s), whose
callback also fires, with an error, when the connection drops first; a plain
ack would be dropped and leave the page locked.

- **Selection is by id**, re-resolved after every snapshot: our unit with
  moves left stays selected, so a move keeps the unit under the cursor; a unit
  out of moves, a dead unit or someone else's is dropped. A tile may hold our
  military unit, civilian and city at once: the first click selects the first
  of them, each further click on the same tile the next, round and round, so
  a garrison never hides its city's panel.
- **Input is locked** when it is not our turn: the action buttons, the
  production list and the tech tree still show, but send nothing, and the
  status line says whose turn it is ("Waiting for Greece (AI)…"). A spectator
  sees the current civ's panel and "Watching".
- **Messages:** the civ's `pendingMessages` from the snapshot (research done,
  production finished, written during its own end of turn) show in the Event
  panel at the start of the next turn; the server clears them on the seat's
  next action. An AI civ's are cleared by `runCpuTurns` before each of its
  turns, since nobody reads them. The tech tree opens by itself at the start of our turn when
  nothing is being researched, as the original did.
- **Victory** shows the original overlay with the score graph from the
  snapshot's `scoreHistory`, and a button back to the lobby.
- **Keys:** the original's shortcuts (Enter ends the turn, F founds, M/A/P
  start an improvement, K/H/U, S and T for the overlays, arrows pan), ignored
  while typing, with Ctrl, Cmd or Alt held, and for Enter on a focused button
  or link, which presses that instead; C centres the map. A held Enter ends
  one turn, not one per repeat, and End Turn is held for a second when a turn
  of ours begins: with only AI seats in between, the next turn is ours again
  before a double-click's second click lands. A button clicked with the mouse
  gives up its focus (Leave always does, after its confirmation), so a later
  Enter never presses it by accident.
- **The map** opens centred on our capital (else another city or unit of
  ours; a spectator's on the civ to move), and the Centre button or C brings
  it back. Pan and zoom always keep part of the map on screen.
- **Connection:** the socket reconnects on its own; every `connect` re-sends
  `game:join`, so a reload or a server restart lands on the current state. A
  refused handshake (`unauthorized`) sends the page to login. A disconnect the
  server initiated (logout in another tab, an expired session, deactivation)
  is one Socket.IO does not recover from by itself: `net.js` asks `/api/me`,
  goes to login on a 401 and reconnects otherwise, for the lobby as well.
- **Gone from the original:** the setup screen, quicksave, export and import
  (the server holds every game), and the local AI loop.

### The lobby page

`public/lobby.html` with `public/js/lobby.js`, called "Play" wherever a
player sees it (the rail, the page title, the "← Play" link on the game and
replay pages); the code and the URL keep the name lobby. It has a new-game
form (seat 0 is yours; seats 1–3 are AI with a difficulty each; seed; turn
time) built from the engine's own catalogues, so it offers exactly what the
server accepts, and the list of your games with turn, whose turn it is and a
link to play or view.
Open seats, presence and watching other people's games come with M3.

## Playing together: tables, timers, chat

### Tables

A game starts life as a **table**: a `games` row with status `lobby`, no
snapshot and no room. The host's `POST /api/games` names the seats; the open
ones wait for people. `GET /api/games/open` lists tables with an open seat.
`POST /api/games/:id/seats/:seat/join` takes a seat (one per person per game;
a taken seat, an AI seat or a started game answer 409),
`POST .../seats/:seat/leave` gives it back (the host cannot leave; the host
cancels the table with `DELETE /api/games/:id`). `POST /api/games/:id/start`,
host only, turns the table into a game: open seats left become AI seats at the
easiest level, the engine is built, the AI seats before the first human take
their turn, the first snapshot and the first deadline are written, and the
room exists from then on. The game page answers `not_started` for a table.
Tables and games nobody has touched for `ABANDON_DAYS` are aborted, at boot and
once an hour (`game.abandon_sweep`).

The lobby page shows: a "Your turn" panel when a game waits for you; open
tables with Join on their open seats, and Start or Cancel for the host, Leave
for other players; the new-table form; live games to watch; your games; who is
online. It sits in the `lobby` socket room: `lobby:changed` makes it refetch
the lists (sent when a table changes or a game's status or turn changes, not
on every move), `lobby:presence` is who is on the page, `turn:yours` refetches
and, when the tab is in the background and the browser allows, shows a
notification. A button asks for that permission; browsers only grant it on a
click.

### Turn timers

Each table has a `turnTime` key from `settings.TURN_TIMES` (default `3m`;
`none` means no clock). When a human seat's turn begins, the room computes
`deadline` (now plus the turn time; null for AI seats, for `none` and for
games that are over) and writes it to `turn_deadline` in the same transaction
as the action that began the turn. Actions within the turn leave it alone:
the clock measures the whole turn, not the time since the last move, which
would let a player hold the turn forever with a move a minute. Every `DEADLINE_SWEEP_MS` (1 s)
`sweepDeadlines` ends every human turn whose deadline has passed: the server
applies `endTurn` for the seat (an action row of type `timeout`, user null),
counts a missed turn on the seat, and at `MISSED_TURN_LIMIT` (3) hands the seat
to the AI (`game.takeover`): the seat's kind becomes `ai`, the civ's `isCpu`
is set, and the AI plays it from then on. Acting resets the count.
Disconnecting by itself does nothing: with games that may last days, the clock
is the only judge of absence. `game:leave` hands a seat over at once, for good.
A seat the AI took over keeps its `user_id`: the game stays in that person's
list, and their view carries `formerSeat` so the page can say what happened.
With no human left in the game, because every human seat was handed to the
AI or every human civ was eliminated, the game is **aborted** (`game.abort`,
`reason=no_humans`) rather than played out by the AI, and it is aborted before
the AI would have played, which matters: a whole AI game takes seconds. A
human civ eliminated by the AI mid-round stops `runCpuTurns` right there. A
game lost that way is therefore not on the leaderboard, like one left.

### Several humans in one game

Seats take turns in seat order; the AI seats between two humans play the
moment the human before them ends their turn, so each human sees everything
that happened since their last move at once. A person may hold seats in any
number of games. `turn:yours` reaches every tab a player has open.

### Chat

One chat per game, for players and spectators alike: this game has no hidden
information for a spectator to leak. `chat:send {gameId, text}` from a socket
that has joined the game, 1 to 300 characters after trimming, stored in
`chat_messages` and sent to the game's room as `chat:message`; `game:join`
returns the last 50 as `chat`. The text is never logged.
`src/db/retention.js` deletes the chat of games that ended more than
`CHAT_RETENTION_DAYS` ago (default 30; `-1` keeps it), at boot and daily.

### The game page, continued

A Players panel lists the seats with the civ, the player or "AI", a marker on
the seat to move and the missed-turn count of an absent player; the status
line carries the time left on the clock, red under thirty seconds; a Leave
button hands the seat to the AI after a confirmation, while the "← Play"
link in the top bar (on the replay page too) only goes to the lobby, the
seat kept and the clock running;
a Chat panel shows the
history and sends; `turn:yours` while the tab is in the background changes
the title and, if allowed, shows a notification. A seat the AI took over, an
abandoned game and a table that has not started each have their own status
line.

## Looking back: leaderboard and replays

**Leaderboard.** `GET /api/leaderboard` (`src/game/leaderboard.js`,
`queries.leaderboard`): every active account with a seat in a finished game,
with games played and games won, top 100 by wins, the sort and the cut in SQL.
A win counts for the person who was still playing the seat at the end; a seat
the AI took over and then won is the person's game but not their win.
Deactivated and deleted accounts are left off. `leaderboard.html` renders it
and marks the viewer's row.

**Replays.** The engine is deterministic and the server recorded every action
in order, including its own `timeout` and `leave` rows, so a game's states can
be rebuilt rather than stored. `src/shared/replay.js` does it the way
`rooms.js` played it: start the engine from the snapshot's `setup` and let the
AI seats before the first human play; then for each action, a player's action
clears the seat's pending messages and goes through `applyAction`, a `timeout`
is an `endTurn` plus a missed turn with the takeover at the limit, a `leave`
flips the seat to AI; after each, the AI seats up to the next human play and
victory is checked, unless no human is left (no human seat, or none whose
civ is still in the game), in which case the server abandoned the game and
the replay stops there too. `replayAll(record)` returns
every state as a snapshot and a one-line label per step, or the first action
the rules refuse, which would mean the record is corrupt.
`test/integration/replay.test.js` plays a two-human game with a timeout, a
takeover and a leave through the server and checks that the replay reproduces
every stored snapshot exactly: the determinism of the engine, tested on a real
game. `GET /api/games/:id/replay` returns the setup and the actions (404 for a
table, which has nothing to replay; 403 for a game still being played, whose
step-by-step history a player could study against the people still playing
it); `replay.html` (`replay-page.js`) rebuilds
the states in the browser in slices, so a long game does not freeze the page,
and shows them on the game's canvas with a slider, step buttons, play at three
speeds and the arrow keys. It is linked from every finished or abandoned
game in the lobby and from the victory screen. The replay page loads `ai.js`;
the game page does not.

## Decided, not yet built

Left of the plan's polish (M5, `docs/plan.md`): a finished-game summary page
(the victory screen on the game page serves today), broadcasting after each AI
civ if the round jump feels wrong, touch and small-screen layout, and deleting
`civ_lite-old/` and the `lorchess/` reference copy once the game page has been
checked against the original. Ideas kept for later: fog of war (the per-seat
view function is the hook), simultaneous turns, maps sized to the number of
players, more civs.
