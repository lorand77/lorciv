"use strict";

// ============================================================
// snapshot.js — the whole game as plain JSON, and back. This is what the
// server stores after every action and what every client renders from.
// Shared by server and browser. Format version 2: the old save-file format
// plus unit and city ids, the AI's strategy memory, the score history and
// the state of the game's random generator (bankruptcy draws from it, so a
// snapshot without it would resume on a different random sequence).
// ============================================================

// Node: the files this one reads as bare names, hoisted onto globalThis. In the
// browser they are globals already, from the earlier <script> tags.
if (typeof module !== "undefined" && module.exports) {
    Object.assign(globalThis, require("./state"), require("./game"));
}

const SNAPSHOT_VERSION = 2;

// ----- Serialization -----

function serializeUnit(u) {
    return {
        id: u.id,
        unitType: u.unitType,
        owner:    u.owner,
        q: u.q, r: u.r,
        hp: u.hp,
        movesLeft: u.movesLeft,
        fortified: u.fortified,
        fortifyBonus: u.fortifyBonus,
        healing: u.healing,
        xp: u.xp,
        buildingImprovement: u.buildingImprovement,
        buildTurnsLeft: u.buildTurnsLeft,
    };
}

function serializeCity(c) {
    return {
        id: c.id,
        name: c.name,
        q: c.q, r: c.r,
        owner: c.owner,
        population: c.population,
        foodStored: c.foodStored,
        hp: c.hp,
        buildings: [...c.buildings],
        productionQueue: [...c.productionQueue],
        productionProgress: c.productionProgress,
        workedTiles: c.workedTiles.map(([q, r]) => [q, r]),
        isOriginalCapital: c.isOriginalCapital,
        cultureStored: c.cultureStored,
    };
}

function serializeCiv(civ) {
    return {
        playerIndex: civ.playerIndex,
        // isCpu can change during a game (a seat handed to the AI), so it is
        // saved per civ and not only in setup.
        isCpu: civ.isCpu,
        gold: civ.gold,
        science: civ.science,
        culture: civ.culture,
        currentResearch: civ.currentResearch,
        techsResearched: [...civ.techsResearched],
        isEliminated: civ.isEliminated,
        pendingMessages: [...civ.pendingMessages],
        researchJustCompleted: civ.researchJustCompleted,
        originalCapital: civ.originalCapital
            ? { q: civ.originalCapital.q, r: civ.originalCapital.r }
            : null,
        cities: civ.cities.map(serializeCity),
        units:  civ.units.map(serializeUnit),
    };
}

function serializeGame(game) {
    // Only tiles that differ from the generated map; the rest comes from the seed.
    const tileMutations = [];
    for (const t of game.tiles.values()) {
        if (t.owner !== null || t.improvement !== null) {
            tileMutations.push({ q: t.q, r: t.r, owner: t.owner, improvement: t.improvement });
        }
    }
    return {
        version: SNAPSHOT_VERSION,
        setup: {
            seed: game.setup.seed,
            cpuFlags: [...game.setup.cpuFlags],
            difficultyFlags: [...game.setup.difficultyFlags],
        },
        game: {
            turn: game.turn,
            currentPlayer: game.currentPlayer,
            winner: game.winner,
            nextId: game.nextId,
            rngState: game._rng.getState(),
            scoreHistory: game.scoreHistory.map(snap => [...snap]),
            aiState: JSON.parse(JSON.stringify(game.aiState)),
            civs: game.civs.map(serializeCiv),
        },
        tileMutations,
    };
}

// ----- Deserialization -----

function _resetForLoad(game) {
    for (const civ of game.civs) {
        civ.cities = [];
        civ.units  = [];
    }
    for (const tile of game.tiles.values()) {
        tile.unit        = null;
        tile.civilian    = null;
        tile.city        = null;
        tile.owner       = null;
        tile.improvement = null;
    }
}

// A Game equal to the one serialized. Throws on a format it does not know.
function deserializeGame(saveObj) {
    if (!saveObj || saveObj.version !== SNAPSHOT_VERSION) {
        throw new Error(`Snapshot version mismatch (got ${saveObj?.version}, expected ${SNAPSHOT_VERSION})`);
    }
    const setup = saveObj.setup;

    // Build a fresh Game with the same setup, then wipe the auto-placed
    // starting state and overlay the saved data.
    const game = new Game({
        seed:            setup.seed,
        cpuFlags:        setup.cpuFlags,
        difficultyFlags: setup.difficultyFlags,
    });
    _resetForLoad(game);

    // Game-level fields
    game.turn          = saveObj.game.turn;
    game.currentPlayer = saveObj.game.currentPlayer;
    game.winner        = saveObj.game.winner;
    game.nextId        = saveObj.game.nextId;
    game._rng.setState(saveObj.game.rngState);
    game.scoreHistory  = (saveObj.game.scoreHistory ?? []).map(snap => [...snap]);
    game.aiState       = JSON.parse(JSON.stringify(saveObj.game.aiState ?? {}));

    // Tile mutations
    for (const tm of saveObj.tileMutations) {
        const tile = game.tiles.get(`${tm.q},${tm.r}`);
        if (!tile) continue;
        tile.owner       = tm.owner;
        tile.improvement = tm.improvement;
    }

    // Civs: patch state in place; rebuild cities[] / units[] and assign tile refs
    for (const civSaved of saveObj.game.civs) {
        const civ = game.civs[civSaved.playerIndex];
        civ.isCpu                 = civSaved.isCpu;
        civ.gold                  = civSaved.gold;
        civ.science               = civSaved.science;
        civ.culture               = civSaved.culture;
        civ.currentResearch       = civSaved.currentResearch;
        civ.techsResearched       = new Set(civSaved.techsResearched);
        civ.isEliminated          = civSaved.isEliminated;
        civ.pendingMessages       = [...civSaved.pendingMessages];
        civ.researchJustCompleted = civSaved.researchJustCompleted;

        for (const cs of civSaved.cities) {
            const city = new City({
                id: cs.id,
                name: cs.name,
                q: cs.q, r: cs.r,
                owner: cs.owner,
                population: cs.population,
                foodStored: cs.foodStored,
                hp: cs.hp,
                buildings: [...cs.buildings],
                productionQueue: [...cs.productionQueue],
                productionProgress: cs.productionProgress,
                workedTiles: cs.workedTiles.map(([q, r]) => [q, r]),
                isOriginalCapital: cs.isOriginalCapital,
                cultureStored: cs.cultureStored,
            });
            civ.cities.push(city);
            const tile = game.tiles.get(`${city.q},${city.r}`);
            if (tile) tile.city = city;
        }

        for (const us of civSaved.units) {
            const unit = new Unit({
                id: us.id,
                unitType: us.unitType,
                owner: us.owner,
                q: us.q, r: us.r,
                hp: us.hp,
                movesLeft: us.movesLeft,
                fortified: us.fortified,
                fortifyBonus: us.fortifyBonus,
                healing: us.healing,
                xp: us.xp,
                buildingImprovement: us.buildingImprovement,
                buildTurnsLeft: us.buildTurnsLeft,
            });
            civ.units.push(unit);
            const tile = game.tiles.get(`${unit.q},${unit.r}`);
            if (tile) {
                if (unit.isCivilian) tile.civilian = unit;
                else tile.unit = unit;
            }
        }
    }

    // originalCapital ref: resolve by position across all civs' cities
    for (const civSaved of saveObj.game.civs) {
        const civ = game.civs[civSaved.playerIndex];
        if (!civSaved.originalCapital) { civ.originalCapital = null; continue; }
        const { q, r } = civSaved.originalCapital;
        let found = null;
        for (const otherCiv of game.civs) {
            for (const c of otherCiv.cities) {
                if (c.q === q && c.r === r) { found = c; break; }
            }
            if (found) break;
        }
        civ.originalCapital = found;
    }

    return game;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SNAPSHOT_VERSION, serializeGame, deserializeGame };
}
