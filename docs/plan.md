# lorciv — project plan

Written 2026-10-09, open points settled 2026-10-10, before any code. This is a plan, not a description of the
code. Once milestones land, `docs/design.md` describes the actual state (the
lorchess practice) and this file is only history.

lorciv is a multiplayer web version of the civ lite game in `civ_lite-old/`:
up to four seats, each a signed-in human or a server-run AI, playing the same
turn-based 4X game. It is a fully separate app from lorchess, on the same
stack and conventions: Node 24, Express 5, Socket.IO, better-sqlite3, vanilla
JS in the browser, no bundler, no framework, no build step.

## 1. Scope

In v1:

- accounts (register, login, sessions), copied from lorchess
- a lobby where a host opens a table, sets the seats and starts the game
- 1–4 human seats, the rest AI with a difficulty; the engine always runs four civs
- server-authoritative play over Socket.IO; the browser only renders and previews
- games that last days: a player leaves and comes back, a turn timer keeps
  the game moving, an absent player's seat is handed to the AI
- games survive a server restart
- spectating and in-game chat
- a list of my games, showing whose turn it is
- production deployment (pm2, Caddy, backups), copied from lorchess

Not in v1, kept as ideas (section 9): simultaneous turns, fog of war, more
than four civs, ratings, replays, email notifications, mobile layout.

## 2. Decisions

Agreed on 2026-10-09:

1. **Server-authoritative.** The server owns one engine instance per game.
   Clients send actions; the server validates, applies, persists and broadcasts.
2. **Full snapshot after every action.** The serialized game (the format of
   the old `persistence.js`) is what the server stores and what clients get.
   No action replay on the client. Measured on a full AI-only game: 6 KB at
   turn 25, 19 KB at turn 125, so bandwidth is not a concern.
3. **Sequential turns**, as the engine already does. No simultaneous turns.
4. **Games may span days.** Resume from snapshot; a per-game turn timer; on
   expiry the turn is ended for the player, and after too many missed turns
   the seat becomes an AI seat.
5. **AI runs on the server.** Measured: an AI civ turn takes 5 ms on
   average and 57 ms at worst, a whole 244-turn AI-only game 4.4 s. It runs on
   the main thread; no worker.
6. **Scaffolding is copied from lorchess** and becomes lorciv's own code.
   Nothing is shared at runtime; accounts, databases and domains are separate.

Proposed in this plan (section 8 lists them for sign-off):

7. A user may be in several games at once. lorchess allows one live game per
   user, but a civ game lasts days, so that rule would make the app unusable.
8. All active games are rebuilt into memory at boot, not lazily on the first
   join. Turn timers have to re-arm whether or not anyone is connected, and
   there will never be many games.
9. One timer mechanism for both "one sitting" and "over days" games: the
   turn time is a per-game setting from a preset list, and the missed-turn
   limit is a second setting.
10. Score history moves into the engine, so it is part of the snapshot and
    every client can draw the victory graph.
11. Broadcasts go through a per-seat view function from day one. It returns
    the whole snapshot for now; if fog of war ever comes, it is the one place
    that changes.
12. Tables waiting for players are `games` rows with status `lobby`, not
    in-memory offers as in lorchess, so a table can wait for players across
    a restart and the "my games" list has one source.

## 3. Architecture

### 3.1 Repository layout

```
lorciv/
  package.json            same dependencies as lorchess
  docs/                   CLAUDE.md, design.md, setup.md, plan.md
  src/
    app.js server.js config.js log.js        copied
    auth/                                    copied: routes, session, middleware, throttle, usernamePolicy
    db/   index.js schema.sql queries.js     copied pattern; lorciv tables
    shared/                                  the engine, loaded by server AND browser
      hex.js        hex math only (the renderer moves out)
      state.js      data catalogues, Unit, City, Civilization, movement, LOS
      mapgen.js     seeded map generation
      game.js       Game: rules, combat, production, tech, endTurn, score
      ai.js         aiTakeTurn (server only, but it lives with the engine)
      snapshot.js   serialize / deserialize (from persistence.js)
      settings.js   allowlists: difficulties, turn-time presets, action names
    game/
      rooms.js      in-memory live games: engine, seats, sockets, timers, persistence
      socket.js     every Socket.IO event
      lobby.js      tables, seats, presence
      routes.js     /api/games REST
  public/
    login.html lobby.html game.html
    css/styles.css
    js/   net.js authGuard.js shell.js theme.js login.js   copied
          renderer.js   HexRenderer (canvas), from hex.js
          ui.js         the game page, refactored from the old ui.js
          lobby.js
    assets/   terrain and resource PNGs, from civ_lite-old
  test/  unit/ integration/ helpers/
  scripts/ backup.sh
```

`src/shared/` is mounted at `/js/` ahead of `public/`, exactly as in lorchess,
so one file serves Node and the browser with the UMD tail the engine files
already have.

### 3.2 What runs where

- **Server:** the engine, for truth. Validates every action against it, runs
  the AI seats, decides victory.
- **Browser:** the same engine, over the latest snapshot, for previews only:
  reachable tiles, attackable tiles, yields, costs, which techs are available.
  It never advances the state itself. The browser does not load `ai.js`.

### 3.3 One action, end to end

```
client   game:action { gameId, seq, type, ...args }  --ack-->  { ok } | { ok:false, error }
server   room lookup -> seat of this user -> game active -> this seat's turn
         -> type in the allowlist -> type-specific check with the engine
            (unit belongs to seat, target in getReachableTiles, enough gold, ...)
         -> apply through a Game method
         -> if type is endTurn: game.endTurn(); while the current seat is AI
            and there is no winner: aiTakeTurn + endTurn
         -> persist snapshot + action row in one transaction
         -> broadcast game:state to the room (viewFor(seat) per socket)
         -> game:over when a winner appears
```

`seq` is the snapshot sequence number the client last saw. A stale `seq` is
refused with `stale`; the client re-syncs from the next broadcast. The server
is authoritative regardless; this only stops a client acting on an old view.

Every handler, timer callback and boot step runs under try/catch, as in
lorchess: Socket.IO has none of its own and better-sqlite3 throws
synchronously.

The action set, from what the old UI does today:

| action           | args                | engine check                                  |
|------------------|---------------------|-----------------------------------------------|
| move             | unitId, q, r        | target in getReachableTiles                   |
| attack           | unitId, q, r        | target in getAttackableTiles                  |
| foundCity        | unitId              | canFoundCity                                  |
| buildImprovement | unitId, key         | worker, key in allowlist, terrain, tech       |
| fortify          | unitId              | military, moves left, not fortified           |
| heal             | unitId              | military, full moves, not healing             |
| skip             | unitId              | moves left                                    |
| upgrade          | unitId              | upgradeUnit's own checks                      |
| setProduction    | cityId, key         | key in units+buildings, tech, resource        |
| buy              | cityId, key         | buyItem's own checks                          |
| setResearch      | key                 | canResearch                                   |
| endTurn          | —                   | —                                             |
| leave            | —                   | seat becomes AI (replaces "resign")           |

### 3.4 Turns and timers

Seats take turns in order, skipping eliminated civs, as the engine does now.
After a human seat ends its turn the server runs every following AI seat at
once and broadcasts once, so the next human sees the result of the whole
round. (If that feels like a jump, a later step can broadcast after each AI
civ; the engine already stops at each boundary.)

Per game, two settings chosen at the table:

- **turn time**: a preset from `settings.js`, e.g. none, 1 min, 3 min,
  10 min, 1 hour, 1 day, 3 days. "None" is for people who trust each other.
- **missed-turn limit**: how many consecutive expired turns before a seat is
  handed to the AI, e.g. 3.

When a human seat's turn begins, the server stores `turn_deadline` on the
games row and arms a timer. On expiry it ends the turn for the player (units
stay put; cities and research carry on), counts a missed turn for the seat,
and broadcasts. Any action by the player resets the count. At the limit, the
seat's civ gets `isCpu = true`, the seat row becomes `ai`, the player is told,
and the AI plays it from then on. A player can also `leave` and hand the seat
over at once. Disconnecting by itself does nothing: with days-long games the
timer is the only clock.

A game ends by domination as today. If no human seat remains, the game is
aborted rather than played out by AIs.

### 3.5 Persistence

Tables (users and sessions are copied from lorchess):

```
games        id, status (lobby|active|finished|aborted), host_id, seed,
             settings (JSON: turn time, missed-turn limit),
             snapshot (JSON, overwritten on every action), seq,
             turn, current_seat, turn_deadline, winner_seat,
             created_at, started_at, finished_at, updated_at
game_seats   game_id, seat (0–3), kind (open|human|ai), user_id, difficulty,
             missed_turns, joined_at          PK (game_id, seat)
game_actions game_id, seq, seat, user_id, action (JSON), created_at
             an audit trail and the raw material for replays; prunable
chat_messages copied from lorchess
```

The snapshot is the old `persistence.js` format plus unit and city ids, AI
strategy state and score history, with its `version` bumped. During
development a version bump simply means `npm run db:reset`; once games exist
in production, a bump comes with a migration function in `snapshot.js`.

**Restart:** at boot every `active` game is loaded into a room and its
deadline re-armed; an already-expired deadline fires immediately. No resume
window and no restart sweep, unlike lorchess. A separate sweep aborts games
with no action for `ABANDON_DAYS` (default 30).

### 3.6 Lobby

A **table** is a `games` row with status `lobby`: the host picks the settings
and the four seats (open, AI with difficulty, or themselves), and other users
take open seats from the lobby page. The host starts the game when no open
seat remains, or lets remaining open seats become AI. The lobby page shows:
open tables, my games with whose turn it is and the deadline, live games to
watch, and recent finished games. Presence is copied from lorchess.

### 3.7 Client

Three pages: login, lobby, game. `game.html?id=<id>` plays, `?watch=<id>`
spectates.

The game page keeps the old canvas renderer unchanged and refactors `ui.js`:

- The page holds the latest snapshot deserialized into a local `Game`, its
  `seq`, and `mySeat`. Every broadcast replaces the local game and redraws.
- Selection is by unit or city id and is re-resolved after each snapshot,
  since the objects are replaced.
- Click handlers and keyboard shortcuts emit actions instead of mutating; the
  action is applied only when the next snapshot arrives. The lorchess
  "move source" pattern fits: a remote source for players, a spectator source
  that can never act.
- Input is locked when it is not my turn, with a banner naming the seat to
  move, the player behind it and the countdown to the deadline.
- Per-turn messages (research done, production finished) travel in the
  broadcast as `events` for the seat they belong to, and the server clears
  them from the state after sending.
- The victory overlay and score graph read `scoreHistory` from the snapshot.
- "Your turn" when the tab is in the background: title flash, and the browser
  Notification API where the user allows it. The lobby page shows a badge.

### 3.8 Validation and trust

As in lorchess, the client is never trusted. Action names, improvement keys,
production items, tech keys, difficulties and turn-time presets are allowlists
in `src/shared/`, resolved on the server. Seat and turn are checked on every
action. The server-side engine decides legality; the browser's previews are a
courtesy.

## 4. Milestones

Each milestone ends with its tests green and `docs/design.md` updated to
describe what now exists.

### M0 — Repository and scaffolding (small) — done 2026-10-10

- `package.json` with lorchess's dependencies; `.gitignore` for `lorchess/`,
  `data/`, `.env`, `node_modules/`.
- Copy and de-chess: `app.js`, `server.js`, `config.js`, `log.js`, `auth/*`,
  `db/index.js`, `schema.sql` (users, sessions), the user part of
  `queries.js`, `test/helpers/server.js`, `login.html`, `net.js`,
  `authGuard.js`, `shell.js`, `theme.js`, `login.js`, `styles.css`.
- `docs/CLAUDE.md` (conventions), `docs/design.md` (the decisions above),
  `docs/setup.md` (the root `setup.md` moved and adapted).
- Done when: register and login work in the browser, the copied auth tests
  pass under `npm test`.

### M1 — Engine in `src/shared/` (medium) — done 2026-10-10

- Move `state.js`, `mapgen.js`, `game.js`, `ai.js`; split `hex.js` into hex
  math (shared) and `renderer.js` (public). Assets to `public/assets/`.
- Stable ids: `Unit.id`, `City.id` from a per-game counter; `game.unitById`
  and `game.cityById`; ids serialized.
- Game methods for what the UI mutates directly today: `fortify`, `heal`,
  `skip`, `setProduction`, `setResearch`. Every action method returns
  `[ok, message]`.
- AI strategy state moves from the module-level `_civStrategies` in `ai.js`
  onto the game and into the snapshot.
- Score history recorded by the engine at each round wrap.
- `snapshot.js` from `persistence.js`, without localStorage and file download.
- `settings.js` allowlists.
- `tools/simulate.js` from the old `simulate.js`.
- Tests: the same seed and actions give the same final state; serialize then
  deserialize is the identity; a batch of AI-only games finishes without
  throwing; each action method refuses what it should.
- Done when: `src/shared/` has no DOM reference and the tests pass.

### M2 — Server game loop (large) — done 2026-10-10

- Schema: `games`, `game_seats`, `game_actions`; `queries.js`.
- `rooms.js`: create, load, persist, apply action, run AI seats, timers.
- `socket.js`: `game:join` (full state back), `game:action` (ack),
  `game:leave`; `game:state`, `game:over` broadcasts.
- `routes.js`: create a game, list mine, get one.
- A minimal "new game" page: four seat selectors and Start; the real lobby is M3.
- `game.html` and the `ui.js` refactor (3.7); `renderer.js` as is.
- Tests (socket.io-client, as lorchess): create, join, act, illegal actions
  refused with the right error, end turn runs the AI seats, snapshot and
  action rows written, a restarted server resumes the game.
- Done when: one person plays a full game against three AIs in the browser,
  through the server, surviving a page reload and a server restart. This is
  the old game with its brain moved to the server, and the milestone that
  proves the architecture.

### M3 — Multiplayer (large) — done 2026-10-11

- `lobby.html` and `lobby.js`: tables, seats, presence, my games, watch list.
- Turn timers, missed turns, AI takeover, `leave`.
- Several concurrent games per user.
- Eager rebuild at boot; abandoned-game sweep.
- Spectating (`game:watch`) and chat (copied).
- "Your turn" signals.
- Tests: two humans alternate with AIs between them; a timer expiry ends the
  turn; the limit converts the seat; a spectator cannot act; the lobby refuses
  a taken seat.
- Done when: two people and two AIs play a game over two sessions with a
  restart in between.

### M4 — Production (small)

- On the lorchess EC2 instance: system user `lorciv`, its own `.env` with
  `PORT=3001`, its own pm2 process, a second Caddy site block for
  `lorciv.lorand77.dev`, log rotation, `scripts/backup.sh` to its own B2
  bucket or prefix, `docs/setup.md` final.
- Done when: live at the chosen hostname with a nightly backup.

### M5 — Polish (as wanted, in any order)

- Finished-game page with the score graph; replay from `game_actions`.
- Profile and settings pages (copied).
- A simple leaderboard (wins).
- Broadcast after each AI civ, with the old 100 ms pacing, if the round jump
  feels wrong.
- Touch and small-screen layout (the renderer already handles touch input).
- Delete `civ_lite-old/` (everything is ported after M2) and the `lorchess/`
  reference copy (after M4).

## 5. Testing

- `node --test`, as lorchess: `test/unit` for the engine, `test/integration`
  for the server through `test/helpers/server.js` and socket.io-client.
- Timers are tested with short presets set through the environment, the way
  lorchess tests its grace period.
- Browser tests stay optional and external (Playwright, no new dependency),
  copied from lorchess if and when they earn their keep.
- Coverage thresholds as in lorchess once the suite is in place.

## 6. Conventions

lorchess's `docs/CLAUDE.md` applies, copied and adapted: CommonJS, strict mode,
double quotes, raw SQL prepared statements, no new dependencies without
asking, a header comment per module, logging through `src/log.js` with fixed
event names, `docs/design.md` updated in the same commit as a design change,
never trust the client.

## 7. Risks

- **The `ui.js` refactor is the biggest single piece of client work.** It is
  done inside M2 against a working server, one handler at a time, with the
  old page as the reference for behaviour.
- **Snapshot format churn** while the engine changes. The version field and
  `db:reset` cover development; a migration function covers production.
- **Four civs are hardcoded** in names, colours, AI flavors and start
  placement. v1 keeps four civs and fills empty seats with AI. Two-player
  maps with two civs would be engine work later.
- **Module-level state in `ai.js`** would leak between games on one server.
  Fixed in M1 before any server code exists.
- **Timers across restarts.** The deadline lives in the database and is
  re-armed at boot; tested in M3.
- **Days-long games and a 7-day session cookie** are fine: the game waits,
  the player logs in again.

## 8. Decisions taken on 2026-10-10

The open questions of the first draft, answered:

1. **Hosting:** lorciv runs on the lorchess EC2 instance, as its own process
   under its own system user, on its own port (assumed 3001) behind the same
   Caddy, at `lorciv.lorand77.dev`. Separate database, separate `.env`,
   separate pm2 entry; the two apps share nothing but the machine.
2. **Several games at once per user:** yes.
3. **Always four civs in v1**, empty seats filled by AI: yes.
4. **Turn-time presets:** none, 1 min, 3 min, 10 min, 1 h, 1 day, 3 days.
   **Default 3 min.** Missed-turn limit 3.
5. **Username policy** copied from lorchess unchanged, "lor" rule included.
6. **Single player versus AI goes through the server too.** No local mode.

## 9. Ideas for later

Simultaneous turns, fog of war and exploration, maps sized to the number of
players, more civs, ratings across multi-player results, email or push
notifications for "your turn", replays with scrubbing, hall of fame.
