"use strict";

// Achievements through the server: a game that ends is replayed in the worker
// and its people awarded, by the leaderboard's rule of which games count; the
// record ones (three wins in a row, a win as every civ, the tiers) follow the
// person's counted games; new ones reach the person's sockets; the boot picks
// up every ended game not yet awarded; a game that does not replay still
// counts for the record; /api/achievements shows anyone's.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, client, connectSocket, waitFor, db } = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const queries = require("../../src/db/queries");
const rooms = require("../../src/game/rooms");
const achievements = require("../../src/achievements/service");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

// A solo game at `seat` in which the person founds their capital and ends a
// turn, as a real player would, so the replay ends where the game did.
async function played(user, { seat = 0, levels = ["prince", "prince", "prince"] } = {}) {
  const ai = [...levels];
  const seats = Array.from({ length: 4 }, (_, i) => (i === seat ? { kind: "human" } : { kind: "ai", difficulty: ai.shift() }));
  const id = (await user.c.post("/api/games", { seats })).body.id;
  const room = rooms.getRoom(id);
  const settler = room.game.civs[seat].units.find((u) => u.unitType === "settler");
  assert.equal(rooms.applyPlayerAction(room, seat, user.user.id, { type: "foundCity", unitId: settler.id }).ok, true);
  assert.equal(rooms.applyPlayerAction(room, seat, user.user.id, { type: "endTurn" }).ok, true);
  return id;
}

// The game over, won by `winner`, as far as the database knows (the engine
// cannot be played to a win in a test), then awarded.
async function finish(id, winner) {
  db().prepare("UPDATE games SET status = 'finished', winner_seat = ?, finished_at = datetime('now') WHERE id = ?").run(winner, id);
  achievements.gameEnded(id);
  await achievements.idle();
}

const keysOf = (user) => queries.listAchievements.all(user.user.id).map((a) => a.key).sort();
const capturesOf = (id, seat) =>
  db().prepare("SELECT captures FROM game_seats WHERE game_id = ? AND seat = ?").get(id, seat).captures;

test("a win alone against the AI: the win feats, the difficulty, the toast and the API", async () => {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const socket = await connectSocket(srv.baseUrl, alice.c.cookie());
  const toast = waitFor(socket, "achievements:earned", 10000);
  const id = await played(alice, { levels: ["king", "emperor", "king"] });
  await finish(id, 0);

  assert.deepEqual(keysOf(alice), ["blitz", "first_blood", "flawless", "princely_victory", "royal_victory"]);
  const earned = await toast;
  assert.deepEqual(earned.find((a) => a.key === "blitz"),
    { key: "blitz", name: "Blitz", icon: "⚡", tier: 1, tierName: null, desc: "Win a game by turn 150.", upgraded: false });
  assert.equal(capturesOf(id, 0), 0, "the replay's count is kept");

  const mine = (await alice.c.get("/api/achievements")).body;
  assert.deepEqual(mine.progress, { games_played: 1, wins: 1, cities_captured: 0 });
  assert.equal(mine.earned.find((a) => a.key === "first_blood").gameId, id);
  assert.ok(mine.earned[0].earnedAt);
  assert.deepEqual((await bob.c.get(`/api/achievements/${alice.user.id}`)).body, mine);
  assert.equal((await bob.c.get("/api/achievements/999999")).status, 404);
  assert.equal((await bob.c.get("/api/achievements/x")).status, 400);
  assert.equal((await client(srv.baseUrl).get("/api/achievements")).status, 401);

  // Every AI at Emperor: the third crown. Doing a game twice changes nothing.
  const hard = await played(alice, { levels: ["emperor", "emperor", "emperor"] });
  await finish(hard, 0);
  assert.ok(keysOf(alice).includes("imperial_victory"));
  const before = queries.listAchievements.all(alice.user.id);
  db().prepare("UPDATE games SET achievements_at = NULL WHERE id = ?").run(hard);
  achievements.gameEnded(hard);
  await achievements.idle();
  assert.deepEqual(queries.listAchievements.all(alice.user.id), before);
});

test("the record: three wins in a row, a win as every civ, the first tier of games played", async () => {
  const carol = await registerUser(srv.baseUrl, "carol");
  const wins = [];
  for (const seat of [0, 1, 2]) {
    wins.push(await played(carol, { seat }));
    await finish(wins.at(-1), seat);
  }
  assert.ok(keysOf(carol).includes("hat_trick"));
  assert.equal(queries.listAchievements.all(carol.user.id).find((a) => a.key === "hat_trick").game_id, wins[2]);
  assert.equal(keysOf(carol).includes("four_banners"), false);

  const lost = await played(carol, { seat: 3 });
  await finish(lost, 0);
  const asHuns = await played(carol, { seat: 3 });
  await finish(asHuns, 3);
  assert.ok(keysOf(carol).includes("four_banners"));
  assert.equal(keysOf(carol).includes("games_played"), false);

  for (let i = 0; i < 5; i++) await finish(await played(carol), 1);
  const veteran = queries.listAchievements.all(carol.user.id).find((a) => a.key === "games_played");
  assert.equal(veteran.tier, 1);
  const { progress } = (await carol.c.get("/api/achievements")).body;
  assert.deepEqual(progress, { games_played: 10, wins: 4, cities_captured: 0 });
});

test("a win with three other people at the table conquers the world", async () => {
  const [host, ...guests] = await Promise.all(["dan", "eve", "fay", "gus"].map((n) => registerUser(srv.baseUrl, n)));
  const open = { kind: "open" };
  const id = (await host.c.post("/api/games", { seats: [{ kind: "human" }, open, open, open] })).body.id;
  for (let i = 0; i < 3; i++) assert.equal((await guests[i].c.post(`/api/games/${id}/seats/${i + 1}/join`)).status, 200);
  assert.equal((await host.c.post(`/api/games/${id}/start`)).status, 200);
  assert.equal(rooms.applyPlayerAction(rooms.getRoom(id), 0, host.user.id, { type: "endTurn" }).ok, true);
  await finish(id, 0);
  assert.ok(keysOf(host).includes("world_conqueror"));
  assert.equal(keysOf(host).includes("princely_victory"), false, "not alone against the AI");
  // The guests never moved: the game is not theirs, and earns them nothing.
  for (const g of guests) assert.deepEqual(keysOf(g), []);
});

test("games that do not count earn nothing, and a real end queues itself", async () => {
  const hal = await registerUser(srv.baseUrl, "hal");
  // Walked out of alone: abandoned, not counted.
  const id = await played(hal);
  assert.equal(rooms.leaveGame(rooms.getRoom(id), hal.user.id).ok, true);
  await achievements.idle();
  assert.ok(queries.getGameById.get(id).achievements_at, "looked at all the same");
  assert.deepEqual(keysOf(hal), []);

  // Won, but the account was deactivated before it was awarded.
  const won = await played(hal);
  queries.deactivateUser.run(hal.user.id);
  await finish(won, 0);
  assert.deepEqual(keysOf(hal), []);
  assert.ok(queries.getGameById.get(won).achievements_at);
});

test("a game that does not replay still counts for the record, and the replay's feats are skipped", async () => {
  const ivy = await registerUser(srv.baseUrl, "ivy");
  const id = await played(ivy);
  // An action the stored snapshot never saw: the replay ends elsewhere.
  queries.insertAction.run(id, 99, 0, ivy.user.id, JSON.stringify({ type: "endTurn" }));
  const logs = captureLogs();
  try {
    await finish(id, 0);
  } finally {
    logs.restore();
  }
  assert.ok(logs.find("achievements.replay_failed", { game: id, error: "mismatch" }));
  assert.ok(logs.find("achievements.earned", { user: ivy.user.id, name: ivy.user.username, game: id }));
  assert.deepEqual(keysOf(ivy), ["blitz", "first_blood", "princely_victory"], "no Flawless without a replay");
  assert.equal(capturesOf(id, 0), null);
});

test("the boot awards every ended game not yet awarded", async () => {
  const jo = await registerUser(srv.baseUrl, "jo");
  const id = await played(jo);
  db().prepare("UPDATE games SET status = 'finished', winner_seat = 0, finished_at = datetime('now') WHERE id = ?").run(id);
  assert.equal(queries.getGameById.get(id).achievements_at, null);
  await srv.close();
  srv = await startServer();
  await achievements.idle();
  assert.ok(queries.getGameById.get(id).achievements_at);
  assert.ok(keysOf(jo).includes("first_blood"));
});
