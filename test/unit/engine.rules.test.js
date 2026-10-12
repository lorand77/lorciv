"use strict";

// Rules that differ from the original game, each fixed for a reason given in
// docs/design.md ("Rules changed from the original"): civilians and enemy
// cities, stranded starts, resources at completion, border tiles, starvation,
// attackers' bonuses, and production that is never thrown away. Also two
// rules kept from it that nothing else checks: the forge on hills, and a start
// found off grassland and plains when a quadrant has none.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Game, processProduction, meleeAttack, getItemCost, computeCityYields } = require("../../src/shared/game");
const { Unit, getReachableTiles, TERRAIN_PASSABLE, TERRAIN_DEFENSE_BONUS } = require("../../src/shared/state");
const { hexNeighbors } = require("../../src/shared/hex");
const { applyAction } = require("../../src/shared/actions");

const HUMANS = [false, false, false, false];
const unitOf = (g, seat, type) => g.civs[seat].units.find((u) => u.unitType === type);
function place(g, owner, unitType, q, r) {
  const u = new Unit({ id: g.nextId++, unitType, owner, q, r });
  g.civs[owner].units.push(u);
  const t = g.tiles.get(`${q},${r}`);
  if (u.isCivilian) t.civilian = u; else t.unit = u;
  return u;
}
function founded(seed = 11) {
  const g = new Game({ seed, cpuFlags: HUMANS });
  assert.equal(applyAction(g, 0, { type: "foundCity", unitId: unitOf(g, 0, "settler").id }).ok, true);
  return { g, civ: g.civs[0], city: g.civs[0].cities[0] };
}

test("a civilian cannot walk into an enemy city, empty or not", () => {
  const { g, city } = founded();
  const [q, r] = hexNeighbors(city.q, city.r).find(([nq, nr]) => {
    const t = g.tiles.get(`${nq},${nr}`);
    return t && TERRAIN_PASSABLE[t.terrain];
  });
  const next = g.tiles.get(`${q},${r}`);
  if (next.civilian) g.removeUnit(next.civilian);
  const cityTile = g.tiles.get(`${city.q},${city.r}`);
  if (cityTile.unit) g.removeUnit(cityTile.unit); // undefended
  const enemyWorker = place(g, 1, "worker", q, r);
  enemyWorker.movesLeft = 2;
  assert.equal(getReachableTiles(enemyWorker, g.tiles, 5).has(`${city.q},${city.r}`), false);
});

test("no civ starts stranded: on the maps that used to strand one, every start has its three units", () => {
  for (const seed of [577, 7516, 8110, 10215, 17471]) {
    const g = new Game({ seed, cpuFlags: [true, true, true, true] });
    for (const civ of g.civs) {
      assert.equal(civ.units.length, 3, `seed ${seed} civ ${civ.playerIndex}`);
      for (const u of civ.units) {
        const t = g.tiles.get(`${u.q},${u.r}`);
        assert.equal(u.isCivilian ? t.civilian : t.unit, u, `seed ${seed}: ${u.unitType} is on its tile`);
      }
    }
  }
});

test("a unit whose resource was lost is dropped at completion; its production stays", () => {
  const { g, civ, city } = founded();
  civ.techsResearched.add("animal_husbandry");
  civ.techsResearched.add("horseback_riding");
  const horses = [...g.tiles.values()].find((t) => t.resource === "horses");
  horses.owner = 0;
  assert.equal(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "horseman" }).ok, true);
  horses.owner = 1; // lost before it was done
  city.productionProgress = getItemCost("horseman");
  const before = civ.units.length;
  assert.match(processProduction(city, civ, g), /no horses left/);
  assert.equal(civ.units.length, before, "not trained");
  assert.deepEqual(city.productionQueue, []);
  assert.ok(city.productionProgress >= getItemCost("horseman"), "the production is kept");
});

test("changing what a city builds keeps its progress; an idle city banks its production", () => {
  const { g, civ, city } = founded();
  assert.equal(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "warrior" }).ok, true);
  city.productionProgress = 7;
  assert.equal(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "monument" }).ok, true);
  assert.equal(city.productionProgress, 7);
  city.productionQueue = [];
  processProduction(city, civ, g);
  assert.ok(city.productionProgress > 7, "production with nothing queued is not lost");
});

test("a city that grows its border works the new tile when it beats one it works", () => {
  const { g, civ, city } = founded();
  city.population = 3;
  city.cultureStored = 19;
  // Our land is poor and every unowned tile is rich: whichever the border
  // takes beats a tile worked now.
  for (const t of g.tiles.values()) {
    if (t.terrain === "ocean" || t.city) continue;
    if (t.owner === 0) { t.terrain = "hills"; t.resource = null; t.improvement = null; }
    else if (t.owner === null) { t.terrain = "grassland"; t.resource = "gold"; }
  }
  const { autoAssignWorkedTiles } = require("../../src/shared/state");
  autoAssignWorkedTiles(city, g.tiles, civ);
  const workedBefore = JSON.stringify(city.workedTiles);
  g.endTurn();
  const owned = new Set([...g.tiles.values()].filter((t) => t.owner === 0).map((t) => `${t.q},${t.r}`));
  for (const [q, r] of city.workedTiles) assert.ok(owned.has(`${q},${r}`));
  assert.notEqual(JSON.stringify(city.workedTiles), workedBefore, "the new tile is worked at once");
});

test("a city short of food starves: it loses a citizen, never its last", () => {
  const { g, civ, city } = founded();
  city.population = 3;
  city.foodStored = 0;
  city.workedTiles = [[city.q, city.r]]; // one tile cannot feed three
  g.endTurn();
  assert.equal(city.population, 2);
  assert.match(civ.pendingMessages.join(" "), /starving/);

  city.population = 1;
  city.foodStored = 0;
  city.workedTiles = [];
  for (let i = 0; i < 4; i++) for (let p = 0; p < 4; p++) g.endTurn();
  assert.equal(city.population, 1);
});

test("an attacker gets no defensive bonus from its own tile or fortification", () => {
  const g = new Game({ seed: 11, cpuFlags: HUMANS });
  const tiles = (terrain) => ({ terrain });
  const strike = (attackerTerrain, fortify) => {
    const a = new Unit({ id: 1, unitType: "warrior", owner: 0, q: 0, r: 0 });
    const d = new Unit({ id: 2, unitType: "warrior", owner: 1, q: 1, r: 0 });
    a.fortifyBonus = fortify;
    meleeAttack(a, d, tiles(attackerTerrain), tiles("grassland"));
    return 100 - d.hp;
  };
  assert.ok(TERRAIN_DEFENSE_BONUS.hills > 0);
  assert.equal(strike("hills", 0.5), strike("grassland", 0), "same blow from hills, fortified, as from the open");
  void g;
});

test("a forge adds one production to each worked hills tile, and only to hills", () => {
  const { g, civ, city } = founded();
  const ring = hexNeighbors(city.q, city.r).filter(([q, r]) => g.tiles.has(`${q},${r}`));
  const [hq, hr] = ring[0], [pq, pr] = ring[1];
  for (const [q, r, terrain] of [[hq, hr, "hills"], [pq, pr, "plains"]]) {
    const t = g.tiles.get(`${q},${r}`);
    t.terrain = terrain; t.resource = null; t.improvement = null;
  }
  const prod = (worked, buildings) => {
    city.workedTiles = worked; city.buildings = buildings;
    return computeCityYields(city, g.tiles, civ).prod;
  };
  assert.equal(prod([[hq, hr]], ["forge"]) - prod([[hq, hr]], []), 1, "worked hills");
  assert.equal(prod([[pq, pr]], ["forge"]) - prod([[pq, pr]], []), 0, "worked plains");
  assert.equal(prod([[hq, hr], [pq, pr]], ["forge"]) - prod([[hq, hr], [pq, pr]], []), 1, "both");
});

test("a quadrant with no grassland or plains still gets a start, on other open land", () => {
  const g = new Game({ seed: 11, cpuFlags: HUMANS });
  const flat = [...g.tiles.values()].filter((t) => t.terrain === "grassland" || t.terrain === "plains");
  for (const t of flat) t.terrain = "hills";
  const start = g._findStartTile(0, []);
  assert.ok(start, "a start was found");
  const t = g.tiles.get(`${start[0]},${start[1]}`);
  assert.ok(TERRAIN_PASSABLE[t.terrain], `${t.terrain} is passable`);
  assert.notEqual(t.terrain, "grassland");
  assert.notEqual(t.terrain, "plains");
  // With every tile too close to a start already taken, there is none.
  assert.equal(g._findStartTile(0, [...g.tiles.values()].map((x) => [x.q, x.r])), null);
});
