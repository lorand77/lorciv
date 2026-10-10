"use strict";

// In-memory authoritative state for live games. The server owns one engine
// instance (src/shared/game.js) per game; clients are never trusted for
// legality, turn or seat. Rooms are keyed by gameId and map 1:1 to the
// Socket.IO room `game:<id>`. After every accepted action the whole game is
// written to the games row as a snapshot, so a room can be rebuilt from the
// database at any time (a restart, a first join after one).

const db = require("../db/index");
const queries = require("../db/queries");
const log = require("../log");
const { Game, PLAYER_NAMES } = require("../shared/game");
const { runCpuTurns } = require("../shared/ai");
const { serializeGame, deserializeGame } = require("../shared/snapshot");
const { applyAction } = require("../shared/actions");

const rooms = new Map(); // gameId -> room

function seatsFromRows(rows) {
  return rows.map((r) => ({
    seat: r.seat,
    kind: r.kind,
    userId: r.user_id,
    username: r.username ?? null,
    difficulty: r.difficulty,
  }));
}

function makeRoom(gameId, game, { seq, status, settings, hostId, seats, snapshotJson }) {
  return {
    gameId,
    game,
    seq,
    status,
    settings,
    hostId,
    seats,
    // The JSON last written to the database: what viewFor hands out, and what
    // the room falls back to if a write fails.
    lastSnapshot: snapshotJson,
  };
}

// Creating a game writes the games row, its seats and the first snapshot in one
// transaction, then keeps the room in memory.
const insertGame = db.transaction((hostId, seed, settings, snapshotJson, seats) => {
  const info = queries.createGame.run(hostId, seed, JSON.stringify(settings), snapshotJson);
  const gameId = Number(info.lastInsertRowid);
  for (const s of seats) {
    const userId = s.kind === "human" ? s.userId : null;
    queries.insertSeat.run(gameId, s.seat, s.kind, userId, s.difficulty, userId);
  }
  return gameId;
});

// seats: [{ seat, kind: 'human'|'ai', userId?, difficulty }], validated by the caller.
function createGame({ hostId, seats, seed, settings }) {
  const game = new Game({
    seed,
    cpuFlags: seats.map((s) => s.kind !== "human"),
    difficultyFlags: seats.map((s) => s.difficulty),
  });
  const snapshotJson = JSON.stringify(serializeGame(game));
  const gameId = insertGame(hostId, seed, settings, snapshotJson, seats);
  const room = makeRoom(gameId, game, {
    seq: 0,
    status: "active",
    settings,
    hostId,
    seats: seatsFromRows(queries.getSeats.all(gameId)),
    snapshotJson,
  });
  rooms.set(gameId, room);
  log.info("game.create", {
    game: gameId, host: hostId, seed,
    seats: seats.map((s) => `${s.kind}:${s.difficulty}`).join(","),
  });
  return room;
}

// The live room, rebuilt from the database if this process has not seen the
// game yet (a restart, or a game nobody has opened since boot). null for an
// unknown game or one still in the lobby.
function getRoom(gameId) {
  const live = rooms.get(gameId);
  if (live) return live;
  const row = queries.getGameById.get(gameId);
  if (!row || !row.snapshot) return null;
  const game = deserializeGame(JSON.parse(row.snapshot));
  const room = makeRoom(gameId, game, {
    seq: row.seq,
    status: row.status,
    settings: JSON.parse(row.settings),
    hostId: row.host_id,
    seats: seatsFromRows(queries.getSeats.all(gameId)),
    snapshotJson: row.snapshot,
  });
  rooms.set(gameId, room);
  log.info("game.resume", { game: gameId, seq: row.seq, turn: row.turn, status: row.status });
  return room;
}

// The seat a user holds in a room, or null (a spectator).
function seatOf(room, userId) {
  const s = room.seats.find((x) => x.kind === "human" && x.userId === userId);
  return s ? s.seat : null;
}

// Only the fields an action can carry are stored; nothing else from the
// client's payload reaches the database.
function recordOf(action) {
  const rec = { type: action.type };
  for (const k of ["unitId", "cityId", "q", "r", "key"]) if (action[k] !== undefined) rec[k] = action[k];
  return rec;
}

// One accepted action's writes as a single transaction: the snapshot and the
// row's summary columns, and the action's own row. All or nothing, so a
// failure can be rolled back in memory without a half-recorded action.
const persist = db.transaction((room, action, seat, userId) => {
  const snapshotJson = JSON.stringify(serializeGame(room.game));
  const winner = room.game.winner;
  queries.saveGameState.run(
    snapshotJson, room.seq, room.game.turn, room.game.currentPlayer, room.status, winner,
    room.status, room.gameId
  );
  queries.insertAction.run(room.gameId, room.seq, seat, userId, JSON.stringify(recordOf(action)));
  return snapshotJson;
});

// Apply a player's action to the authoritative game. Validation is the shared
// validator's (src/shared/actions.js); this adds what only the server knows:
// the game's status, the AI seats that play after an endTurn, victory, and
// persistence. Returns the validator's result shape.
function applyPlayerAction(room, seat, userId, action) {
  if (room.status !== "active") return { ok: false, error: "game_over", message: "" };
  const game = room.game;
  const civ = game.civs[seat];
  // The messages from this seat's last end of turn went out with the previous
  // state; the player has seen them and is acting on them.
  civ.pendingMessages = [];
  civ.researchJustCompleted = false;

  const res = applyAction(game, seat, action);
  if (!res.ok) return res;

  // The AI seats that follow play at once, so the next human sees the whole
  // round. Victory is checked after every action, not only after an attack.
  if (action.type === "endTurn") runCpuTurns(game);
  game.checkVictory();

  const before = { seq: room.seq, status: room.status };
  room.seq++;
  if (game.winner !== null) room.status = "finished";
  try {
    room.lastSnapshot = persist(room, action, seat, userId);
  } catch (err) {
    log.error("game.persist_failed", { game: room.gameId, seq: room.seq, err });
    room.game = deserializeGame(JSON.parse(room.lastSnapshot));
    room.seq = before.seq;
    room.status = before.status;
    return { ok: false, error: "server_error", message: "Could not save the game." };
  }
  if (game.winner !== null) {
    log.info("game.over", { game: room.gameId, winner: game.winner, turn: game.turn, seq: room.seq });
  }
  return res;
}

// What one seat gets to see. Today everyone sees everything, so this returns
// the whole snapshot; if fog of war ever comes, it is the one place to filter.
// `seat` is null for a spectator.
function viewFor(room, seat) {
  return {
    gameId: room.gameId,
    seq: room.seq,
    status: room.status,
    winner: room.game.winner,
    settings: room.settings,
    seats: room.seats.map((s) => ({
      seat: s.seat, kind: s.kind, username: s.username, difficulty: s.difficulty, civ: PLAYER_NAMES[s.seat],
    })),
    mySeat: seat,
    snapshot: JSON.parse(room.lastSnapshot),
  };
}

// The games row and seats as the REST API shows them (no snapshot).
function summary(row) {
  return {
    id: row.id,
    status: row.status,
    turn: row.turn,
    currentSeat: row.current_seat,
    winnerSeat: row.winner_seat,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seats: seatsFromRows(queries.getSeats.all(row.id)).map((s) => ({
      seat: s.seat, kind: s.kind, username: s.username, difficulty: s.difficulty, civ: PLAYER_NAMES[s.seat],
    })),
  };
}

function listRooms() {
  return [...rooms.values()];
}

// Forget every live room (tests simulate a restart with it).
function clearAll() {
  rooms.clear();
}

module.exports = { createGame, getRoom, seatOf, applyPlayerAction, viewFor, summary, listRooms, clearAll };
