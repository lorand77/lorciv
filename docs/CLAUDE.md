# LorCiv

Multiplayer Civ Lite: Node 24, Express 5, Socket.IO and better-sqlite3 on the
server; vanilla JS in the browser. No bundler, no framework, no build step.
The architecture and the reasons behind it, and what is decided but not built
yet, are in `docs/design.md`; running and deploying is in `docs/setup.md`.
Read `docs/design.md` before changing anything under `src/game/` or
`src/shared/`.

## Commands

- `npm test` — whole suite. Run it before calling any change done.
  `TEST_LOG=1` shows the server's logs, which the tests silence by default.
  In an interactive shell `npm` is the Socket wrapper, whose permission model
  blocks the tests' temporary database: run `node --run test` or `\npm test`
  there. A plain shell (a tool, a script) has no alias and `npm test` is fine.
- `npm run test:coverage` — the suite with Node's built-in coverage report;
  fails if lines, branches or functions drop below 98 / 91 / 96 %. Files no
  test loads (`src/server.js`, `public/js/`) are not listed.
- `npm run dev` — http://localhost:3001 with `--watch`; loads `.env` if present.
  Every env-driven constant is declared in `src/config.js`.
- `npm run db:reset` deletes the local database. Ask before running it.
- `npm run user:password|user:deactivate|user:reactivate|user:delete -- <name>`
  — the account CLIs in `src/db/` (see `docs/setup.md`); they change real
  accounts and `user:delete` cannot be undone, so never run them unasked.
  `npm start` is the production entry.

## Layout

- `src/app.js` builds the app; `src/server.js` only listens. Tests boot
  `app.js` on a random port against a throwaway database, one per test file.
- The full tree is under "Layout" in `docs/design.md`; what follows is what
  you need to find your way.
- `src/<area>/routes.js` — Express routers mounted at `/api/<area>` in `app.js`
  (auth at `/api` itself, `src/game/routes.js` at `/api/games`; the leaderboard
  router is `src/game/leaderboard.js`, at `/api/leaderboard`).
  `src/game/socket.js` owns every Socket.IO event; `src/game/rooms.js` owns
  the live games: the engine instance per game, its seats, and saving them
  (the game, seat and action rows).
- `src/auth/` — `routes.js` (register, login, logout, me), `session.js` (one
  session for REST and the socket handshake), `origin.js` (the same-origin
  check on `/api` and sockets), `middleware.js` (`requireAuth`), `throttle.js`
  (login and register limits), `usernamePolicy.js`.
- `src/db/` — `index.js` (open, schema, migrations), `schema.sql`,
  `queries.js`, `retention.js` (the chat sweep, started by `server.js` only),
  `reset.js`, and the account CLIs `setPassword.js`, `deactivate.js`,
  `deleteUser.js`.
- `src/shared/` — the game engine, loaded by browser and Node alike and served
  at `/js/`: `hex`, `state`, `mapgen`, `game`, `ai` (server and the replay
  page), `snapshot`, `settings`, `actions`, `replay`, and `achievements` (the
  catalogue, for the server and the profile). Player actions go through
  `actions.js` and nowhere else.
- `src/achievements/` — awarding: `service.js` queues each ended game (and at
  boot every one not yet awarded), `worker.js` replays it off the main thread
  through `analyze.js`, `routes.js` is `/api/achievements`.
- `public/*.html` pages with their scripts in `public/js/`; `shell.js` builds
  the top bar and rail, `authGuard.js` bounces signed-out visitors to login,
  `net.js` wraps the Socket.IO client. `login.html`/`login.js` signs in or
  registers (no shell, no guard); `index.html` redirects there.
  `css/styles.css` styles every page but the game and the replay, which use
  `css/game.css` and have no shell either.
  `game.html` is the game: `ui.js` (renders snapshots, sends actions, chat),
  `renderer.js` (the canvas map). `lobby.html`/`lobby.js` is the
  lobby: tables, seats, your games, live games, presence. `replay.html`/
  `replay-page.js` rebuilds a game from its actions; `leaderboard.html`/
  `leaderboard.js` ranks players. `profile.html` is the profile: `profile.js`
  runs the tabs `stats.js`, `history.js` (My Games), `achievementsPage.js` and
  `friendsPage.js`; `friends.js` is the friends client and control;
  `achievementToast.js` (styled by `css/toast.css`) shows new achievements on
  the game page and the lobby. `customize.html`/
  `customize.js` sets the colour scheme, which `theme.js` applies on every
  page with the shell and on `terms.html` and `privacy.html`. A page script
  must not share a name with a file in `src/shared/`, which is served at `/js/`
  first. `public/assets/` holds the
  terrain and resource images.
- `src/health.js` — `GET /health` for the uptime monitor (see "monitoring" in
  `docs/setup.md`), mounted ahead of the session and the request log.
- `scripts/backup.sh` — the nightly database backup to B2, run by cron on the
  server (see `docs/setup.md`).
- `tools/simulate.js` — N AI-only games on every core, win rates by seat with
  the AI flavors fixed, rotated or mirrored (`--seats`) and by flavor; run by
  hand, never loaded by the app.
- `experiments/<date>-<name>/` — one folder per simulation experiment: a
  `README.md` (question, design, exact commands, results, discussion) and the
  raw output it rests on. Never loaded by the app.
- `test/unit`, `test/integration` — `node --test`. `test/helpers/server.js`
  boots the server; `test/helpers/logs.js` captures log lines for assertions.

## Conventions

- No new dependencies. Node built-ins first; if a package seems necessary, ask.
- CommonJS, `"use strict"`, double quotes, semicolons. Match the file you are in.
- Raw SQL prepared statements in `src/db/queries.js`; no ORM, no query builder.
- Every module opens with a comment saying what it does and why. Keep that up.
- Never trust the client. Seat, turn, legality, game settings and timers are
  decided or re-checked on the server; the browser's engine is for previews.
- Commit subjects are short and imperative; a `feat:`/`fix:` prefix is optional.
- When a design decision changes, update `docs/design.md` in the same commit.
- Server code logs through `src/log.js` with a fixed event name and fields
  (`log.info("game.over", { game, winner })`), never `console.*`. The events,
  and what must never be logged, are under "Logging" in `docs/design.md`.
  What the logs hold is stated in `public/privacy.html`: keep it true.

## Gotchas

- `schema.sql` only CREATEs. A new column on an existing table also needs an
  `addColumnIfMissing` line in `src/db/index.js`, or old databases never get it.
- Test files must `require("../helpers/server")` before anything that loads
  `src/db/index.js` (pure modules such as `src/shared/*` are fine without it);
  the database path is fixed when `src/db/index.js` loads.
- The CSP (`src/app.js`) runs scripts only from files on this origin: no
  inline `<script>`, `onclick=` or `javascript:` URL in a page, and nothing
  loaded from another host. `test/integration/headers.test.js` scans
  `public/*.html` for the first three; the header itself enforces the last.
- `src/shared/*.js` runs in two runtimes: keep the UMD tail at the bottom and
  use no Node-only or DOM-only APIs.
- A change that makes the same actions on the same seed play out differently
  (combat, production, the AI, map generation) must bump `RULES_VERSION` in
  `src/shared/game.js`, or replays of older games break: see "Rules versions"
  in `docs/design.md`.
- An achievement that games already awarded could have earned needs
  `AWARDS_VERSION` in `src/achievements/service.js` bumped, or only new games
  will ever earn it.
- Catalogues (difficulties, turn-time presets, action names) are allowlists in
  `src/shared/`. Add entries there, not in ad-hoc lists elsewhere.
- Native modules need a rebuild after `npm ci` or `npm install` because `ignore-scripts` is
  on globally, and that rebuild must bypass the Socket wrapper (`\npm rebuild`),
  which otherwise silently produces no binary: see "run the app" in `docs/setup.md`.
- In an interactive shell `npm` is aliased to `socket npm`; in a script or a
  tool's shell it is plain npm. Use `socket npm` explicitly where the wrapper is
  wanted, `\npm` where it is not.
