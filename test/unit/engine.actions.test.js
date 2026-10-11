"use strict";

// src/shared/actions.js: the one validator for player actions. It refuses
// what is not the seat's to do and what the engine's rules forbid, and
// applies the rest through the Game's methods.

const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("../../src/shared/game");
const { Unit, getReachableTiles } = require("../../src/shared/state");
const { runCpuTurns } = require("../../src/shared/ai");
const { applyAction } = require("../../src/shared/actions");

const HUMAN_FIRST = [false, true, true, true];
const unitOf = (g, seat, type) => g.civs[seat].units.find((u) => u.unitType === type);

let g;
beforeEach(() => { g = new Game({ seed: 11, cpuFlags: HUMAN_FIRST }); });

describe("applyAction", () => {
  test("refuses out of turn, unknown actions and a finished game", () => {
    assert.equal(applyAction(g, 1, { type: "endTurn" }).error, "not_your_turn");
    assert.equal(applyAction(g, 0, { type: "dance" }).error, "unknown_action");
    assert.equal(applyAction(g, 0, null).error, "unknown_action");
    assert.equal(applyAction(g, 0, {}).error, "unknown_action");
    g.winner = 2;
    assert.equal(applyAction(g, 0, { type: "endTurn" }).error, "game_over");
  });

  test("names units and cities by id and checks ownership", () => {
    assert.equal(applyAction(g, 0, { type: "skip", unitId: 9999 }).error, "no_such_unit");
    assert.equal(applyAction(g, 0, { type: "skip" }).error, "no_such_unit");
    assert.equal(applyAction(g, 0, { type: "skip", unitId: unitOf(g, 1, "warrior").id }).error, "not_yours");
    assert.equal(applyAction(g, 0, { type: "setProduction", cityId: 1, key: "warrior" }).error, "no_such_city");
  });

  test("move: only to a reachable tile, at the engine's cost", () => {
    const settler = unitOf(g, 0, "settler");
    const reachable = getReachableTiles(settler, g.tiles, g.turn);
    const [key, cost] = [...reachable.entries()][0];
    const [q, r] = key.split(",").map(Number);
    const moves = settler.movesLeft;
    assert.deepEqual(applyAction(g, 0, { type: "move", unitId: settler.id, q, r }), { ok: true, message: "" });
    assert.deepEqual([settler.q, settler.r], [q, r]);
    assert.equal(settler.movesLeft, moves - cost);
    const far = applyAction(g, 0, { type: "move", unitId: settler.id, q: q + 20, r });
    assert.equal(far.error, "illegal");
    assert.equal(far.message, "Cannot move there.");
    assert.equal(applyAction(g, 0, { type: "move", unitId: settler.id, q: "1", r: 2 }).error, "illegal");
  });

  test("foundCity, then production and buying", () => {
    const settler = unitOf(g, 0, "settler");
    const res = applyAction(g, 0, { type: "foundCity", unitId: settler.id });
    assert.equal(res.ok, true);
    assert.equal(res.message, "Founded Rome.");
    const city = g.civs[0].cities[0];
    assert.ok(Number.isInteger(city.id));
    assert.equal(g.cityById(city.id), city);
    assert.equal(g.unitById(settler.id), null, "the settler is gone");
    assert.equal(applyAction(g, 0, { type: "foundCity", unitId: unitOf(g, 0, "worker").id }).message,
      "Only a settler can found a city.");

    assert.equal(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "warrior" }).ok, true);
    assert.deepEqual(city.productionQueue, ["warrior"]);
    assert.equal(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "palace" }).error, "illegal");
    assert.match(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "swordsman" }).message, /Requires Iron Working/);
    assert.match(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "nothing" }).message, /Unknown item/);

    assert.match(applyAction(g, 0, { type: "buy", cityId: city.id, key: "monument" }).message, /Need \d+g/);
    g.civs[0].gold = 1000;
    assert.equal(applyAction(g, 0, { type: "buy", cityId: city.id, key: "monument" }).ok, true);
    assert.ok(city.buildings.includes("monument"));
    assert.match(applyAction(g, 0, { type: "setProduction", cityId: city.id, key: "monument" }).message, /already built/);
    assert.equal(applyAction(g, 0, { type: "buy", cityId: city.id, key: "palace" }).error, "illegal");
    assert.equal(applyAction(g, 0, { type: "buy", cityId: city.id, key: "warrior" }).ok, true, "units can be bought");
  });

  test("setResearch follows the tech tree and may replace research in progress", () => {
    const civ = g.civs[0];
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "mining" }).ok, true);
    assert.equal(civ.currentResearch, "mining");
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "bronze_working" }).error, "illegal");
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "nope" }).error, "illegal");
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "archery" }).ok, true, "a change of mind is allowed");
    civ.techsResearched.add("mining");
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "mining" }).error, "illegal");
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "bronze_working" }).ok, true);
  });

  test("fortify, heal and skip", () => {
    const warrior = unitOf(g, 0, "warrior");
    const worker = unitOf(g, 0, "worker");
    assert.equal(applyAction(g, 0, { type: "heal", unitId: warrior.id }).ok, true, "a rested unit may heal");
    assert.equal(warrior.healing, true);
    assert.equal(warrior.movesLeft, 0);
    assert.equal(applyAction(g, 0, { type: "fortify", unitId: warrior.id }).message, "No moves left.");

    const other = new Game({ seed: 11, cpuFlags: HUMAN_FIRST });
    const w2 = unitOf(other, 0, "warrior");
    assert.equal(applyAction(other, 0, { type: "fortify", unitId: w2.id }).ok, true);
    assert.equal(w2.fortified, true);
    assert.equal(w2.fortifyBonus, 0.25);
    assert.equal(applyAction(other, 0, { type: "fortify", unitId: w2.id }).error, "illegal");

    assert.equal(applyAction(g, 0, { type: "fortify", unitId: worker.id }).message, "Civilians cannot fortify.");
    assert.equal(applyAction(g, 0, { type: "skip", unitId: worker.id }).ok, true);
    assert.equal(worker.movesLeft, 0);
    assert.equal(applyAction(g, 0, { type: "skip", unitId: worker.id }).error, "illegal");
  });

  test("buildImprovement: a worker, a known improvement, the right terrain", () => {
    const worker = unitOf(g, 0, "worker");
    g.civs[0].techsResearched.add("mining");
    const terrain = g.tiles.get(`${worker.q},${worker.r}`).terrain;
    const key = ["grassland", "plains"].includes(terrain) ? "farm" : "mine";
    const wrong = key === "farm" ? "mine" : "farm";
    assert.equal(applyAction(g, 0, { type: "buildImprovement", unitId: worker.id, key: "castle" }).message, "Unknown improvement.");
    assert.equal(applyAction(g, 0, { type: "buildImprovement", unitId: unitOf(g, 0, "warrior").id, key }).message, "Only a worker can build.");
    assert.equal(applyAction(g, 0, { type: "buildImprovement", unitId: worker.id, key: wrong }).message, "Cannot build that here.");
    assert.equal(applyAction(g, 0, { type: "buildImprovement", unitId: worker.id, key }).ok, true);
    assert.equal(worker.buildingImprovement, key);
    assert.equal(worker.movesLeft, 0);
  });

  test("attack: only an attackable target", () => {
    const warrior = unitOf(g, 0, "warrior");
    // Put an enemy warrior on an empty passable tile next to ours.
    const { hexNeighbors } = require("../../src/shared/hex");
    const { TERRAIN_PASSABLE } = require("../../src/shared/state");
    const [q, r] = hexNeighbors(warrior.q, warrior.r).find(([nq, nr]) => {
      const t = g.tiles.get(`${nq},${nr}`);
      return t && TERRAIN_PASSABLE[t.terrain] && !t.unit && !t.civilian && !t.city;
    });
    const enemy = new Unit({ id: g.nextId++, unitType: "warrior", owner: 1, q, r });
    g.civs[1].units.push(enemy);
    g.tiles.get(`${q},${r}`).unit = enemy;

    const empty = hexNeighbors(warrior.q, warrior.r).find(([nq, nr]) => !(nq === q && nr === r));
    assert.equal(applyAction(g, 0, { type: "attack", unitId: warrior.id, q: empty[0], r: empty[1] }).message, "Cannot attack there.");
    const res = applyAction(g, 0, { type: "attack", unitId: warrior.id, q, r });
    assert.equal(res.ok, true);
    assert.match(res.message, /Warrior vs Warrior/);
    assert.ok(enemy.hp < 100);
    assert.equal(warrior.movesLeft, 0);
  });

  test("endTurn hands the turn on, and the AI seats bring it back", () => {
    assert.deepEqual(applyAction(g, 0, { type: "endTurn" }), { ok: true, message: "" });
    assert.equal(g.currentPlayer, 1);
    assert.equal(applyAction(g, 0, { type: "skip", unitId: unitOf(g, 0, "worker").id }).error, "not_your_turn");
    runCpuTurns(g);
    assert.equal(g.currentPlayer, 0);
    assert.equal(g.turn, 2);
    assert.equal(g.scoreHistory.length, 1);
  });

  test("a key must be the catalogue's own string: no inherited names, no arrays", () => {
    const settler = unitOf(g, 0, "settler");
    assert.equal(applyAction(g, 0, { type: "foundCity", unitId: settler.id }).ok, true);
    const city = g.civs[0].cities[0];
    const worker = unitOf(g, 0, "worker");
    g.civs[0].gold = 500;
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", ["settler"], ["warrior"], 7, null]) {
      for (const type of ["buy", "setProduction"]) {
        assert.equal(applyAction(g, 0, { type, cityId: city.id, key }).message, "Unknown item.", `${type} ${String(key)}`);
      }
      assert.equal(applyAction(g, 0, { type: "setResearch", key }).message, "Unknown technology.", String(key));
      assert.equal(applyAction(g, 0, { type: "buildImprovement", unitId: worker.id, key }).message, "Unknown improvement.", String(key));
    }
    assert.equal(g.civs[0].gold, 500);
    assert.deepEqual(city.buildings, ["palace"]);
    assert.equal(g.civs[0].units.length, 2, "the settler founded the city; nothing was bought");
    assert.equal(applyAction(g, 0, { type: "buy", cityId: city.id, key: "warrior" }).ok, true, "a real key still works");
    assert.equal(applyAction(g, 0, { type: "setResearch", key: "pottery" }).ok, true);
  });

  test("a captured capital loses its palace; taking one's own back restores it", () => {
    applyAction(g, 0, { type: "endTurn" });
    runCpuTurns(g); // the AI seats found their capitals
    const capital = g.civs[1].originalCapital;
    assert.ok(capital.buildings.includes("palace"));
    const conqueror = new Unit({ id: g.nextId++, unitType: "warrior", owner: 0, q: capital.q, r: capital.r });
    g.civs[0].units.push(conqueror);
    g._captureCity(conqueror, capital);
    assert.equal(capital.owner, 0);
    assert.equal(capital.buildings.includes("palace"), false);
    assert.equal(g.civs[0].cities.filter((c) => c.buildings.includes("palace")).length, 0,
      "seat 0 has not founded yet: no palace of its own, none taken");

    // Seat 1 retakes its capital.
    g.civs[1].isEliminated = false;
    const liberator = new Unit({ id: g.nextId++, unitType: "warrior", owner: 1, q: capital.q, r: capital.r });
    g.civs[1].units.push(liberator);
    g._captureCity(liberator, capital);
    assert.equal(capital.owner, 1);
    assert.equal(capital.buildings.filter((b) => b === "palace").length, 1);
  });

  test("an AI civ's messages last one round, not the whole game", () => {
    const sim = new Game({ seed: 11, cpuFlags: [true, true, true, true] });
    runCpuTurns(sim, 60);
    for (const civ of sim.civs) {
      // One end of turn's worth at most: a tech, a few cities' production, bankruptcy.
      assert.ok(civ.pendingMessages.length <= civ.cities.length + 3, `${civ.name}: ${civ.pendingMessages.length}`);
    }
  });

  test("a full city's new unit waits for room; buying one is refused; no landing on an enemy", () => {
    const { hexNeighbors } = require("../../src/shared/hex");
    const { TERRAIN_PASSABLE } = require("../../src/shared/state");
    const { processProduction } = require("../../src/shared/game");
    assert.equal(applyAction(g, 0, { type: "foundCity", unitId: unitOf(g, 0, "settler").id }).ok, true);
    const civ = g.civs[0];
    const city = civ.cities[0];
    const place = (owner, q, r, unitType = "warrior") => {
      const u = new Unit({ id: g.nextId++, unitType, owner, q, r });
      g.civs[owner].units.push(u);
      const t = g.tiles.get(`${q},${r}`);
      if (u.isCivilian) t.civilian = u; else t.unit = u;
      return u;
    };
    // Fill the city tile and every passable neighbour's military slot.
    const cityTile = g.tiles.get(`${city.q},${city.r}`);
    if (!cityTile.unit) place(0, city.q, city.r);
    const around = hexNeighbors(city.q, city.r).map(([q, r]) => g.tiles.get(`${q},${r}`))
      .filter((t) => t && TERRAIN_PASSABLE[t.terrain]);
    for (const t of around) if (!t.unit) place(0, t.q, t.r);
    const count = civ.units.length;
    civ.gold = 500;

    const res = applyAction(g, 0, { type: "buy", cityId: city.id, key: "warrior" });
    assert.equal(res.ok, false);
    assert.match(res.message, /No room/);
    assert.equal(civ.gold, 500, "nothing spent");

    city.productionQueue = ["warrior"];
    city.productionProgress = 1000;
    assert.match(processProduction(city, civ, g), /no room/);
    assert.deepEqual(city.productionQueue, ["warrior"], "it waits in the queue");
    assert.ok(city.productionProgress >= 1000, "progress kept");
    assert.equal(civ.units.length, count);

    // An enemy on the one free tile does not make room either.
    const spot = around[0];
    g.removeUnit(spot.unit);
    place(1, spot.q, spot.r, "worker");
    assert.equal(applyAction(g, 0, { type: "buy", cityId: city.id, key: "warrior" }).ok, false);

    // Room again: the unit is trained there, alone on its tile.
    g.removeUnit(spot.civilian);
    assert.match(processProduction(city, civ, g), /trained/);
    assert.equal(spot.unit.owner, 0);
    assert.equal(spot.unit.unitType, "warrior");
    assert.deepEqual(city.productionQueue, []);
  });

  test("after a capture every city works only tiles its civ owns", () => {
    const sim = new Game({ seed: 11, cpuFlags: [true, true, true, true] });
    runCpuTurns(sim, 60);
    const loser = sim.civs.find((c) => c.cities.length >= 2);
    const winner = sim.civs.find((c) => c !== loser && !c.isEliminated);
    const target = loser.cities.find((c) => c !== loser.originalCapital) ?? loser.cities[0];
    const conqueror = new Unit({ id: sim.nextId++, unitType: "warrior", owner: winner.playerIndex, q: target.q, r: target.r });
    winner.units.push(conqueror);
    sim._captureCity(conqueror, target);
    for (const civ of [winner, loser]) {
      for (const city of civ.cities) {
        for (const [q, r] of city.workedTiles) {
          assert.equal(sim.tiles.get(`${q},${r}`).owner, city.owner, `${city.name} works (${q},${r})`);
        }
      }
    }
  });

  test("no victory while a civ still has a settler to found its capital with", () => {
    const humans = new Game({ seed: 11, cpuFlags: [false, false, false, false] });
    assert.equal(applyAction(humans, 0, { type: "foundCity", unitId: unitOf(humans, 0, "settler").id }).ok, true);
    for (let seat = 0; seat < 4; seat++) assert.equal(applyAction(humans, seat, { type: "endTurn" }).ok, true);
    assert.equal(humans.turn, 2);
    humans.checkVictory();
    assert.equal(humans.winner, null, "the others are still walking their settlers");

    // Once nobody else can found any more, the one capital is all there is.
    for (const seat of [1, 2, 3]) humans.removeUnit(unitOf(humans, seat, "settler"));
    humans.checkVictory();
    assert.equal(humans.winner, 0);
  });

  test("the AI stops the moment the last human civ is eliminated", () => {
    applyAction(g, 0, { type: "endTurn" });
    // Seat 1's turn wipes seat 0 out, as a conquest would.
    const endTurn = g.endTurn.bind(g);
    g.endTurn = () => { g.civs[0].isEliminated = true; endTurn(); };
    runCpuTurns(g);
    assert.equal(g.currentPlayer, 2, "seat 1 played; nobody after it");
    assert.equal(g.turn, 1);
    assert.equal(g.winner, null);

    // An AI-only game has no human to lose, and plays on.
    const sim = new Game({ seed: 11, cpuFlags: [true, true, true, true] });
    runCpuTurns(sim, 3);
    assert.equal(sim.turn, 4);
  });
});
