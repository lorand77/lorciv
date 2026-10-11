# LorCiv

Multiplayer Civ Lite: Node 24, Express 5, Socket.IO and better-sqlite3 on the
server; vanilla JS in the browser. No bundler, no framework, no build step.
The architecture and the reasons behind it are in `docs/design.md`; what is
not built yet, and in which order it will be, is `docs/plan.md`; running and
deploying is in `docs/setup.md`. Read `docs/design.md` before changing anything
under `src/game/` or `src/shared/`.

## Commands

- `npm test` — whole suite. Run it before calling any change done.
  `TEST_LOG=1` shows the server's logs, which the tests silence by default.
  In an interactive shell `npm` is the Socket wrapper, whose permission model
  blocks the tests' temporary database: run `node --run test` or `\npm test`
  there. A plain shell (a tool, a script) has no alias and `npm test` is fine.
- `npm run test:coverage` — the suite with Node's built-in coverage report.
  Files no test loads (`src/server.js`, CLI scripts, `public/js/`) are not listed.
- `npm run dev` — http://localhost:3001 with `--watch`; loads `.env` if present.
  Every env-driven constant is declared in `src/config.js`.
- `npm run db:reset` deletes the local database. Ask before running it.

## Layout

- `src/app.js` builds the app; `src/server.js` only listens. Tests boot
  `app.js` on a random port against a throwaway database, one per test file.
- `src/<area>/routes.js` — Express routers mounted at `/api/<area>` in `app.js`
  (auth is mounted at `/api` itself). `src/game/socket.js` owns every
  Socket.IO event; `src/game/rooms.js` owns the live games: the engine
  instance per game, its seats, and every write to the database.
- `src/shared/` — the game engine, loaded by browser and Node alike and served
  at `/js/`: `hex`, `state`, `mapgen`, `game`, `ai` (server only), `snapshot`,
  `settings`, `actions`. Player actions go through `actions.js` and nowhere else.
- `public/*.html` pages with their scripts in `public/js/`; `shell.js` builds
  the top bar and rail, `authGuard.js` bounces signed-out visitors to login.
  `game.html` is the game: `ui.js` (renders snapshots, sends actions, chat),
  `renderer.js` (the canvas map), `game.css`. `lobby.html`/`lobby.js` is the
  lobby: tables, seats, your games, live games, presence. `public/assets/`
  holds the terrain and resource images.
- `src/db/retention.js` — the chat sweep, started by `server.js` only.
- `scripts/backup.sh` — the nightly database backup to B2, run by cron on the
  server (see `docs/setup.md`).
- `tools/simulate.js` — N AI-only games with win counts; run by hand, never
  loaded by the app.
- `test/unit`, `test/integration` — `node --test`. `test/helpers/server.js`
  boots the server; `test/helpers/logs.js` captures log lines for assertions.
- `civ_lite-old/` — the single-player original. Everything in it is ported;
  it is kept only until the game page has been checked against it in a
  browser, then deleted.
- `lorchess/` — gitignored reference copy of the sister project the scaffolding
  was copied from. Never required at runtime; delete it when no longer needed.

## Conventions

- No new dependencies. Node built-ins first; if a package seems necessary, ask.
- CommonJS, `"use strict"`, double quotes, semicolons. Match the file you are in.
- Raw SQL prepared statements in `src/db/queries.js`; no ORM, no query builder.
- Every module opens with a comment saying what it does and why. Keep that up.
- Never trust the client. Seat, turn, legality, game settings and timers are
  decided or re-checked on the server; the browser's engine is for previews.
- Commit subjects are short and imperative; a `feat:`/`fix:` prefix is optional.
- When a design decision changes, update `docs/design.md` in the same commit.
  When a milestone lands, move its detail from `docs/plan.md` to `docs/design.md`.
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
- `src/shared/*.js` runs in two runtimes: keep the UMD tail at the bottom and
  use no Node-only or DOM-only APIs.
- Catalogues (difficulties, turn-time presets, action names) are allowlists in
  `src/shared/`. Add entries there, not in ad-hoc lists elsewhere.
- Native modules need a rebuild after `npm install` because `ignore-scripts` is
  on globally, and that rebuild must bypass the Socket wrapper (`\npm rebuild`),
  which otherwise silently produces no binary: see "run the app" in `docs/setup.md`.
- In an interactive shell `npm` is aliased to `socket npm`; in a script or a
  tool's shell it is plain npm. Use `socket npm` explicitly where the wrapper is
  wanted, `\npm` where it is not.
