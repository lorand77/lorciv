// ============================================================
// persistence.js — Save / load of the full Game state.
// Saves to localStorage (quicksave) or to a downloadable JSON file.
// Both transports share the same (de)serializer.
// ============================================================

const QUICKSAVE_KEY    = 'civlite.quicksave';
const SAVE_VERSION     = 1;

// ----- Serialization -----

function serializeUnit(u) {
    return {
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

function serializeGame(game, scoreHistory, setup) {
    const tileMutations = [];
    for (const t of game.tiles.values()) {
        if (t.owner !== null || t.improvement !== null) {
            tileMutations.push({
                q: t.q, r: t.r,
                owner: t.owner,
                improvement: t.improvement,
            });
        }
    }
    return {
        version:  SAVE_VERSION,
        savedAt:  new Date().toISOString(),
        setup:    {
            seed: setup.seed,
            cpuFlags: [...setup.cpuFlags],
            difficultyFlags: [...setup.difficultyFlags],
        },
        game: {
            turn: game.turn,
            currentPlayer: game.currentPlayer,
            winner: game.winner,
            civs: game.civs.map(serializeCiv),
        },
        tileMutations,
        scoreHistory: scoreHistory.map(snap => [...snap]),
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

function deserializeInto(saveObj) {
    if (!saveObj || saveObj.version !== SAVE_VERSION) {
        throw new Error(`Save version mismatch (got ${saveObj?.version}, expected ${SAVE_VERSION})`);
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

    const scoreHistory = (saveObj.scoreHistory ?? []).map(snap => [...snap]);
    return { game, scoreHistory, setup: saveObj.setup };
}

// ----- localStorage transport -----

function saveQuick(game, scoreHistory, setup) {
    const obj = serializeGame(game, scoreHistory, setup);
    localStorage.setItem(QUICKSAVE_KEY, JSON.stringify(obj));
    return { turn: obj.game.turn,
             civName: PLAYER_NAMES[obj.game.currentPlayer],
             savedAt: obj.savedAt };
}

function loadQuick() {
    const raw = localStorage.getItem(QUICKSAVE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
}

function quicksaveMetadata() {
    const raw = loadQuick();
    if (!raw) return null;
    return {
        turn:    raw.game.turn,
        civName: PLAYER_NAMES[raw.game.currentPlayer],
        savedAt: raw.savedAt,
    };
}

function clearQuick() { localStorage.removeItem(QUICKSAVE_KEY); }

// ----- File transport -----

function exportToFile(game, scoreHistory, setup) {
    const obj = serializeGame(game, scoreHistory, setup);
    const json = JSON.stringify(obj);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const date = obj.savedAt.slice(0, 10);
    const civ  = PLAYER_NAMES[obj.game.currentPlayer].replace(/\s+/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `civlite-turn${obj.game.turn}-${civ}-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importFromFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type   = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) { reject(new Error('No file chosen')); return; }
            try {
                const text = await file.text();
                resolve(JSON.parse(text));
            } catch (err) { reject(err); }
        });
        input.click();
    });
}
