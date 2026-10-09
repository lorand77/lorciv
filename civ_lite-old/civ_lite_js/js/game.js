// ============================================================
// game.js — Game class, turn loop, combat, yields, production, tech
// Ported from the Python civ_lite_py codebase.
// Depends on: hex.js, mapgen.js, state.js (loaded first)
// ============================================================

// ============================================================
// Constants
// ============================================================

const MAP_COLS = 32;
const MAP_ROWS = 24;

const PLAYER_NAMES = ['Rome', 'Greece', 'The Huns', 'Babylon'];

const PLAYER_COLORS = ['#dc3232', '#3264dc', '#32b432', '#dcb432'];

const DIFFICULTY_DEFS = {
    prince:  { prod_mult: 1.0, food_mult: 1.0, starting_xp: 0 },
    king:    { prod_mult: 1.2, food_mult: 1.2, starting_xp: 10 },
    emperor: { prod_mult: 1.5, food_mult: 1.5, starting_xp: 20 },
};

const CITY_NAMES = [
    ['Rome','Florence','Venice','Genoa','Naples','Milan','Bologna','Pisa','Ravenna','Verona','Capua','Palermo'],
    ['Athens','Sparta','Corinth','Delphi','Argos','Thessaloniki','Rhodes','Mycenae','Olympia','Thebes','Ephesus','Pergamon'],
    ["Attila's Court",'Pannonia','Germania','Gothia','Scythia','Etzelburg','Hunuguri','Savaria','Aquincum','Carpathia','Moesia','Dacia'],
    ['Babylon','Ur','Nineveh','Kish','Akkad','Eridu','Nippur','Lagash','Uruk','Susa','Assur','Ctesiphon'],
];

// ============================================================
// Combat — port of systems/combat.py
// ============================================================

function calcDamage(attackerStr, defenderStr) {
    const diff   = attackerStr - defenderStr;
    const damage = 30 * Math.exp(0.04 * diff);
    return Math.max(1, Math.min(50, Math.trunc(damage)));
}

function effectiveStrength(unit, tile, vsUnitType = null) {
    const defn         = UNIT_DEFS[unit.unitType];
    const base         = defn.strength;
    const terrainBonus = TERRAIN_DEFENSE_BONUS[tile.terrain] ?? 0;
    const fortifyBonus = unit.fortifyBonus;
    const hpModifier   = 0.5 + 0.5 * (unit.hp / unit.hpMax);
    const unitBonus    = vsUnitType ? (defn.bonus_vs?.[vsUnitType] ?? 0) : 0;
    const xpBonus      = unit.xp / 100;
    return base * (1 + terrainBonus + fortifyBonus + unitBonus + xpBonus) * hpModifier;
}

function cityCombatStrength(city) {
    const base         = 5;
    const popBonus     = city.population * 2;
    const buildBonus   = city.buildings.reduce((s, b) => s + (BUILDING_DEFS[b]?.defense ?? 0), 0);
    return base + popBonus + buildBonus;
}

function meleeAttack(attacker, defender, attackerTile, defenderTile) {
    const aStr       = effectiveStrength(attacker, attackerTile, defender.unitType);
    const dStr       = effectiveStrength(defender, defenderTile, attacker.unitType);
    const attackerDmg = calcDamage(dStr, aStr);
    const defenderDmg = calcDamage(aStr, dStr);
    attacker.hp = Math.max(0, attacker.hp - attackerDmg);
    defender.hp = Math.max(0, defender.hp - defenderDmg);
    return [attackerDmg, defenderDmg];
}

function rangedAttack(attacker, defender, defenderTile, attackerTile = null) {
    const defn = UNIT_DEFS[attacker.unitType];
    let aStr;
    if (attackerTile) {
        const baseMultiplier = effectiveStrength(attacker, attackerTile) / defn.strength;
        aStr = (defn.ranged_strength ?? defn.strength) * baseMultiplier;
    } else {
        aStr = defn.ranged_strength ?? defn.strength;
    }
    const dStr      = effectiveStrength(defender, defenderTile);
    const defenderDmg = calcDamage(aStr, dStr);
    defender.hp = Math.max(0, defender.hp - defenderDmg);
    return defenderDmg;
}

function bombardCity(attacker, city, attackerTile = null) {
    const defn      = UNIT_DEFS[attacker.unitType];
    const cityBonus = defn.bonus_vs_city ?? 0;
    let aStr;
    if (attackerTile) {
        const baseMultiplier = effectiveStrength(attacker, attackerTile) / defn.strength;
        aStr = (defn.ranged_strength ?? defn.strength) * baseMultiplier;
    } else {
        aStr = defn.ranged_strength ?? defn.strength;
    }
    aStr *= (1 + cityBonus);
    const cityDmg = Math.max(1, Math.min(20, Math.trunc(aStr * 0.4)));
    city.hp = Math.max(0, city.hp - cityDmg);

    let attackerDmg = 0;
    if (defn.type === 'melee') {
        const cStr    = cityCombatStrength(city);
        const aEffStr = attackerTile
            ? effectiveStrength(attacker, attackerTile)
            : defn.strength * (0.5 + 0.5 * (attacker.hp / defn.hp_max));
        attackerDmg = calcDamage(cStr, aEffStr);
        attacker.hp = Math.max(0, attacker.hp - attackerDmg);
    }
    return [cityDmg, attackerDmg];
}

// ============================================================
// Yields — port of systems/yields.py
// ============================================================

function computeCityYields(city, tiles, civ) {
    const totals = { food: 0, prod: 0, gold: 0, science: 0, culture: 0 };

    for (const [q, r] of city.workedTiles) {
        const tile = tiles.get(`${q},${r}`);
        if (!tile) continue;

        const ty = TERRAIN_YIELDS[tile.terrain];
        totals.food += ty.food;
        totals.prod += ty.prod;
        totals.gold += ty.gold;

        if (tile.resource && RESOURCES[tile.resource]) {
            const res = RESOURCES[tile.resource];
            const req = res.requires_tech;
            if (!req || civ.techsResearched.has(req)) {
                const b = res.yield_bonus;
                totals.food += b.food ?? 0;
                totals.prod += b.prod ?? 0;
                totals.gold += b.gold ?? 0;
            }
        }

        if (tile.improvement && IMPROVEMENT_DEFS[tile.improvement]) {
            const b = IMPROVEMENT_DEFS[tile.improvement].yield_bonus;
            totals.food += b.food ?? 0;
            totals.prod += b.prod ?? 0;
            totals.gold += b.gold ?? 0;
        }

        if (tile.terrain === 'hills' && city.buildings.includes('forge')) {
            totals.prod += 1;
        }
    }

    for (const bKey of city.buildings) {
        const b   = BUILDING_DEFS[bKey];
        const eff = b.effects;
        totals.food    += eff.food_per_turn    ?? 0;
        totals.prod    += eff.prod_per_turn    ?? 0;
        totals.gold    += eff.gold_per_turn    ?? 0;
        totals.science += eff.science_per_turn ?? 0;
        totals.culture += eff.culture_per_turn ?? 0;
        totals.gold    -= b.maintenance ?? 0;
    }

    totals.science += 1 + city.population;
    totals.prod     = Math.trunc(totals.prod * civ.prodMult);
    totals.food     = Math.trunc(totals.food * civ.foodMult);

    return totals;
}

// ============================================================
// Production — port of systems/production.py
// ============================================================

function getItemCost(itemKey) {
    if (UNIT_DEFS[itemKey])     return UNIT_DEFS[itemKey].prod_cost;
    if (BUILDING_DEFS[itemKey]) return BUILDING_DEFS[itemKey].prod_cost;
    return 9999;
}

function _completeItem(city, civ, game, itemKey) {
    if (BUILDING_DEFS[itemKey]) {
        if (!city.buildings.includes(itemKey)) city.buildings.push(itemKey);
        return `${city.name}: ${BUILDING_DEFS[itemKey].name} built!`;
    }

    if (UNIT_DEFS[itemKey]) {
        const defn = UNIT_DEFS[itemKey];
        const unit = new Unit({ unitType: itemKey, owner: civ.playerIndex, q: city.q, r: city.r });
        if (!unit.isCivilian) unit.xp = civ.startingXp;

        const cityTile = game.tiles.get(`${city.q},${city.r}`);
        let placed = false;

        if (cityTile) {
            if (defn.type === 'civilian' && !cityTile.civilian) {
                cityTile.civilian = unit; placed = true;
            } else if (defn.type !== 'civilian' && !cityTile.unit) {
                cityTile.unit = unit; placed = true;
            }
        }

        if (!placed) {
            for (const [nq, nr] of hexNeighbors(city.q, city.r)) {
                const t = game.tiles.get(`${nq},${nr}`);
                if (!t || !TERRAIN_PASSABLE[t.terrain]) continue;
                if (defn.type === 'civilian' && !t.civilian) {
                    unit.q = nq; unit.r = nr; t.civilian = unit; placed = true; break;
                } else if (defn.type !== 'civilian' && !t.unit) {
                    unit.q = nq; unit.r = nr; t.unit = unit; placed = true; break;
                }
            }
        }

        if (!placed && cityTile) {
            if (defn.type === 'civilian') cityTile.civilian = unit;
            else cityTile.unit = unit;
        }

        civ.units.push(unit);
        return `${city.name}: ${defn.name} trained!`;
    }
}

function processProduction(city, civ, game) {
    if (!city.productionQueue.length) return null;

    const yields  = computeCityYields(city, game.tiles, civ);
    city.productionProgress += yields.prod;

    const itemKey = city.productionQueue[0];
    const cost    = getItemCost(itemKey);

    if (city.productionProgress >= cost) {
        city.productionProgress -= cost;
        const msg = _completeItem(city, civ, game, itemKey);
        city.productionQueue.shift();
        return msg ?? null;
    }
    return null;
}

// ============================================================
// Tech — port of systems/tech_tree.py
// ============================================================

function canResearch(techKey, techsResearched) {
    if (techsResearched.has(techKey)) return false;
    return TECH_DEFS[techKey].prerequisites.every(p => techsResearched.has(p));
}

function availableTechs(techsResearched) {
    return Object.keys(TECH_DEFS).filter(k => canResearch(k, techsResearched));
}

// ============================================================
// Score — port of systems/score.py
// ============================================================

function computeScore(civ, game) {
    if (civ.isEliminated) return 0;

    let score = 0;
    score += civ.cities.length * 50;
    score += civ.cities.reduce((s, c) => s + c.population, 0) * 20;
    score += civ.units
        .filter(u => !u.isCivilian)
        .reduce((s, u) => s + UNIT_DEFS[u.unitType].strength, 0) * 3;
    score += civ.techsResearched.size * 20;
    for (const t of game.tiles.values()) if (t.owner === civ.playerIndex) score += 1;
    score += Math.floor(civ.gold / 10);

    for (const city of civ.cities) {
        for (const bKey of city.buildings) {
            const defn = BUILDING_DEFS[bKey];
            const eff  = defn.effects ?? {};
            score += (eff.food_per_turn    ?? 0) * 4;
            score += (eff.prod_per_turn    ?? 0) * 5;
            score += (eff.gold_per_turn    ?? 0) * 3;
            score += (eff.science_per_turn ?? 0) * 6;
            score += (eff.culture_per_turn ?? 0) * 2;
            score += (defn.defense         ?? 0) * 8;
        }
    }
    return score;
}

// ============================================================
// Game class
// ============================================================

class Game {
    constructor({ numPlayers = 4, cols = MAP_COLS, rows = MAP_ROWS, seed = 42,
                  cpuFlags = null, difficultyFlags = null } = {}) {
        this.numPlayers    = numPlayers;
        this.cols          = cols;
        this.rows          = rows;
        this.currentPlayer = 0;
        this.turn          = 1;
        this.winner        = null;
        this.pendingMessages = [];

        this._rng = makePRNG((seed ^ 0xABCD1234) >>> 0);

        const gen    = generateMap(cols, rows, seed);
        this.tiles   = gen.tiles;
        this.civs    = this._createCivs(cpuFlags, difficultyFlags);

        this._placeStartingUnits();
    }

    // ---- Setup ----

    _createCivs(cpuFlags, difficultyFlags) {
        const civs = [];
        for (let i = 0; i < this.numPlayers; i++) {
            const civ = new Civilization({
                playerIndex: i,
                name:  PLAYER_NAMES[i],
                color: PLAYER_COLORS[i],
                isCpu: cpuFlags ? !!cpuFlags[i] : (i > 0),
            });
            if (difficultyFlags?.[i]) {
                const d = DIFFICULTY_DEFS[difficultyFlags[i]] ?? DIFFICULTY_DEFS.prince;
                civ.difficulty  = difficultyFlags[i];
                civ.prodMult    = d.prod_mult;
                civ.foodMult    = d.food_mult;
                civ.startingXp  = d.starting_xp;
            }
            civs.push(civ);
        }
        return civs;
    }

    _findStartTile(quadrant, taken, minDist = 5) {
        const halfR = Math.floor(this.rows / 2);
        const halfC = Math.floor(this.cols / 2);

        const farEnough = (q, r) =>
            taken.every(([tq, tr]) => hexDistance(q, r, tq, tr) >= minDist);

        const inQuadrant = (q, r) => {
            const col  = q + Math.floor((r - (r & 1)) / 2);
            const row  = r;
            const top  = row < halfR;
            const left = col < halfC;
            return [top && left, top && !left, !top && left, !top && !left][quadrant];
        };

        const candidates = [];
        for (const tile of this.tiles.values()) {
            if (!inQuadrant(tile.q, tile.r)) continue;
            if ((tile.terrain === 'grassland' || tile.terrain === 'plains') && farEnough(tile.q, tile.r))
                candidates.push([tile.q, tile.r]);
        }

        // Fallback: any passable tile in quadrant
        if (!candidates.length) {
            for (const tile of this.tiles.values()) {
                if (!inQuadrant(tile.q, tile.r)) continue;
                if (TERRAIN_PASSABLE[tile.terrain] && farEnough(tile.q, tile.r))
                    candidates.push([tile.q, tile.r]);
            }
        }

        if (!candidates.length) return null;
        return candidates[this._rng.randInt(candidates.length)];
    }

    _placeUnit(unit) {
        const tile = this.tiles.get(`${unit.q},${unit.r}`);
        if (!tile) return;
        if (unit.isCivilian) tile.civilian = unit;
        else tile.unit = unit;
    }

    _placeStartingUnits() {
        const quadrants = Array.from({ length: this.numPlayers }, (_, i) => i);
        // Fisher-Yates shuffle with PRNG
        for (let i = quadrants.length - 1; i > 0; i--) {
            const j = this._rng.randInt(i + 1);
            [quadrants[i], quadrants[j]] = [quadrants[j], quadrants[i]];
        }

        const taken = [];
        for (let i = 0; i < this.numPlayers; i++) {
            const civ = this.civs[i];
            const pos = this._findStartTile(quadrants[i], taken);
            if (!pos) continue;
            const [q, r] = pos;
            taken.push([q, r]);

            const settler = new Unit({ unitType: 'settler', owner: i, q, r });
            const worker  = new Unit({ unitType: 'worker',  owner: i, q, r });
            const warrior = new Unit({ unitType: 'warrior', owner: i, q, r, xp: civ.startingXp });

            // Spread civilians to adjacent passable tiles
            const placedCivilian = [[q, r]];
            for (const [nq, nr] of hexNeighbors(q, r)) {
                const t = this.tiles.get(`${nq},${nr}`);
                if (t && TERRAIN_PASSABLE[t.terrain] && !placedCivilian.some(([a,b]) => a===nq && b===nr)) {
                    worker.q = nq; worker.r = nr;
                    placedCivilian.push([nq, nr]);
                    break;
                }
            }
            // Warrior on a different adjacent tile
            for (const [nq, nr] of hexNeighbors(q, r)) {
                const t = this.tiles.get(`${nq},${nr}`);
                if (t && TERRAIN_PASSABLE[t.terrain] && !t.unit &&
                    !placedCivilian.some(([a,b]) => a===nq && b===nr)) {
                    warrior.q = nq; warrior.r = nr;
                    break;
                }
            }

            civ.units = [settler, worker, warrior];
            this._placeUnit(settler);
            this._placeUnit(worker);
            this._placeUnit(warrior);
        }
    }

    // ---- Accessors ----

    currentCiv() { return this.civs[this.currentPlayer]; }

    // ---- Unit actions ----

    moveUnit(unit, q, r, cost = 1) {
        const oldTile = this.tiles.get(`${unit.q},${unit.r}`);
        if (oldTile) {
            if (unit.isCivilian) oldTile.civilian = null;
            else oldTile.unit = null;
        }

        unit.q = q; unit.r = r;
        unit.movesLeft         = Math.max(0, unit.movesLeft - cost);
        unit.fortified         = false;
        unit.fortifyBonus      = 0;
        unit.healing           = false;
        unit.buildingImprovement = null;
        unit.buildTurnsLeft    = 0;

        const newTile = this.tiles.get(`${q},${r}`);
        if (newTile) {
            if (unit.isCivilian) {
                newTile.civilian = unit;
            } else {
                if (newTile.civilian && newTile.civilian.owner !== unit.owner) {
                    if (!(this.turn <= 1 && newTile.civilian.unitType === 'settler'))
                        this.removeUnit(newTile.civilian);
                }
                newTile.unit = unit;
            }
        }
    }

    canFoundCity(unit) {
        const tile = this.tiles.get(`${unit.q},${unit.r}`);
        if (!tile || tile.terrain === 'ocean' || tile.city)
            return [false, 'Cannot settle here.'];
        if (tile.owner !== null && tile.owner !== unit.owner)
            return [false, 'Cannot settle in enemy territory.'];
        for (const civ of this.civs)
            for (const city of civ.cities)
                if (hexDistance(unit.q, unit.r, city.q, city.r) <= 2)
                    return [false, 'Too close to an existing city.'];
        return [true, ''];
    }

    foundCity(unit) {
        const civ      = this.civs[unit.owner];
        const cityIdx  = civ.cities.length;
        const names    = CITY_NAMES[unit.owner] ?? [];
        const name     = names[cityIdx] ?? `${PLAYER_NAMES[unit.owner]} ${cityIdx + 1}`;

        const city = new City({
            name, q: unit.q, r: unit.r, owner: unit.owner,
            isOriginalCapital: cityIdx === 0,
        });

        // Claim tiles within radius 1
        for (const [hq, hr] of hexesInRange(unit.q, unit.r, 1)) {
            const t = this.tiles.get(`${hq},${hr}`);
            if (t && t.terrain !== 'ocean' && t.owner === null) t.owner = unit.owner;
        }

        const tile = this.tiles.get(`${unit.q},${unit.r}`);
        if (tile) { tile.city = city; tile.owner = unit.owner; tile.civilian = null; }

        civ.units = civ.units.filter(u => u !== unit);
        civ.cities.push(city);

        if (city.isOriginalCapital) {
            civ.originalCapital = city;
            city.buildings.push('palace');
        }

        autoAssignWorkedTiles(city, this.tiles, civ);
        return city;
    }

    upgradeUnit(unit) {
        if (unit.isCivilian) return [false, ''];
        if (unit.movesLeft === 0) return [false, 'No moves left to upgrade.'];
        const civ  = this.civs[unit.owner];
        const path = UNIT_UPGRADES[unit.unitType];
        if (!path) return [false, `${unit.name} has no upgrade.`];
        const [targetType, goldCost] = path;
        const tdef = UNIT_DEFS[targetType];
        if (tdef.requires_tech && !civ.techsResearched.has(tdef.requires_tech))
            return [false, `Requires ${tdef.requires_tech} technology.`];
        if (tdef.requires_resource &&
            ![...this.tiles.values()].some(t => t.resource === tdef.requires_resource && t.owner === unit.owner))
            return [false, `Requires ${tdef.requires_resource} resource.`];
        if (civ.gold < goldCost) return [false, `Need ${goldCost}g to upgrade (have ${civ.gold}g).`];

        civ.gold -= goldCost;
        const hpRatio   = unit.hp / unit.hpMax;
        unit.unitType   = targetType;
        unit.hp         = Math.max(1, Math.round(hpRatio * tdef.hp_max));
        unit.movesLeft  = 0;
        unit.fortified  = false;
        unit.fortifyBonus = 0;
        unit.healing    = false;
        return [true, `Upgraded to ${tdef.name} for ${goldCost}g!`];
    }

    buyItem(city, itemKey) {
        const civ  = this.civs[city.owner];
        if (BUILDING_DEFS[itemKey] && city.buildings.includes(itemKey))
            return [false, `${BUILDING_DEFS[itemKey].name} already built.`];
        const defn    = BUILDING_DEFS[itemKey] ?? UNIT_DEFS[itemKey];
        const reqTech = defn?.requires_tech;
        if (reqTech && !civ.techsResearched.has(reqTech))
            return [false, `Requires ${reqTech} technology.`];
        if (UNIT_DEFS[itemKey]) {
            const reqRes = UNIT_DEFS[itemKey].requires_resource;
            if (reqRes && ![...this.tiles.values()].some(t => t.resource === reqRes && t.owner === city.owner))
                return [false, `Requires ${reqRes} resource.`];
        }
        const goldCost = getItemCost(itemKey) * 2;
        if (civ.gold < goldCost) return [false, `Need ${goldCost}g (have ${civ.gold}g).`];
        civ.gold -= goldCost;
        const msg = _completeItem(city, civ, this, itemKey);
        return [true, msg ?? ''];
    }

    startImprovement(unit, improvementKey) {
        const defn  = IMPROVEMENT_DEFS[improvementKey];
        const tile  = this.tiles.get(`${unit.q},${unit.r}`);
        if (!tile) return false;
        const terrainOk   = defn.valid_terrain.includes(tile.terrain);
        const goldMineOk  = improvementKey === 'mine' && tile.resource === 'gold'
                            && (tile.terrain === 'grassland' || tile.terrain === 'plains');
        if (!terrainOk && !goldMineOk) return false;
        if (improvementKey === 'pasture' && tile.resource !== 'horses') return false;
        const civ = this.civs[unit.owner];
        if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) return false;
        unit.buildingImprovement = improvementKey;
        unit.buildTurnsLeft      = defn.build_turns;
        unit.movesLeft           = 0;
        return true;
    }

    removeUnit(unit) {
        const tile = this.tiles.get(`${unit.q},${unit.r}`);
        if (tile) {
            if (unit.isCivilian && tile.civilian === unit) tile.civilian = null;
            else if (!unit.isCivilian && tile.unit === unit) tile.unit = null;
        }
        const civ = this.civs[unit.owner];
        const idx = civ.units.indexOf(unit);
        if (idx !== -1) civ.units.splice(idx, 1);
    }

    _advanceUnit(unit, tq, tr) {
        const oldTile = this.tiles.get(`${unit.q},${unit.r}`);
        if (oldTile && oldTile.unit === unit) oldTile.unit = null;
        unit.q = tq; unit.r = tr;
        const newTile = this.tiles.get(`${tq},${tr}`);
        if (newTile) {
            if (newTile.civilian && newTile.civilian.owner !== unit.owner)
                this.removeUnit(newTile.civilian);
            newTile.unit = unit;
        }
    }

    _captureCity(attacker, city) {
        const oldOwnerIdx = city.owner;
        const newOwnerIdx = attacker.owner;

        const oldTile = this.tiles.get(`${attacker.q},${attacker.r}`);
        if (oldTile && oldTile.unit === attacker) oldTile.unit = null;

        attacker.q = city.q; attacker.r = city.r; attacker.movesLeft = 0;

        const cityTile = this.tiles.get(`${city.q},${city.r}`);
        if (cityTile) {
            if (cityTile.civilian && cityTile.civilian.owner === oldOwnerIdx) {
                this.removeUnit(cityTile.civilian);
            }
            cityTile.unit = attacker;
            cityTile.owner = newOwnerIdx;
        }

        const oldCiv = this.civs[oldOwnerIdx];
        const newCiv = this.civs[newOwnerIdx];
        oldCiv.cities = oldCiv.cities.filter(c => c !== city);
        newCiv.cities.push(city);

        city.owner = newOwnerIdx;
        city.hp    = 50;
        city.productionQueue.length = 0;
        city.productionProgress = 0;

        // Voronoi territory transfer
        const survivingOldCities = oldCiv.cities.map(c => [c.q, c.r]);
        for (const [key, t] of this.tiles) {
            if (t.owner !== oldOwnerIdx) continue;
            if (!survivingOldCities.length) { t.owner = newOwnerIdx; continue; }
            const [hq, hr] = key.split(',').map(Number);
            const distCaptured = hexDistance(hq, hr, city.q, city.r);
            const minDistOld   = Math.min(...survivingOldCities.map(([cq,cr]) => hexDistance(hq, hr, cq, cr)));
            if (distCaptured < minDistOld) t.owner = newOwnerIdx;
        }

        if (!oldCiv.cities.length) {
            oldCiv.isEliminated = true;
            for (const u of [...oldCiv.units]) this.removeUnit(u);
            oldCiv.units = [];
        }
    }

    doAttack(attacker, targetQ, targetR) {
        const targetTile   = this.tiles.get(`${targetQ},${targetR}`);
        if (!targetTile) return '';

        // Settlers protected on turn 1
        if (this.turn <= 1) {
            const tgt = targetTile.unit ?? targetTile.civilian;
            if (tgt?.unitType === 'settler') return '';
        }

        const attackerTile = this.tiles.get(`${attacker.q},${attacker.r}`);
        const defn         = UNIT_DEFS[attacker.unitType];
        const unitType     = defn.type;

        attacker.movesLeft  = 0;
        attacker.fortified  = false;
        attacker.fortifyBonus = 0;
        attacker.healing    = false;

        const targetUnit = targetTile.unit ?? targetTile.civilian;
        const targetCity = targetTile.city;
        let msg = '';

        if (targetCity && targetCity.owner !== attacker.owner) {
            // Attack city
            if (unitType === 'ranged') {
                const [cityDmg] = bombardCity(attacker, targetCity, attackerTile);
                attacker.xp += 2;
                msg = `Bombarded ${targetCity.name}: -${cityDmg} HP (HP: ${targetCity.hp}/50)`;
            } else {
                const oldOwnerIdx = targetCity.owner;
                const [cityDmg, aDmg] = bombardCity(attacker, targetCity, attackerTile);
                if (attacker.hp > 0) attacker.xp += 2;
                msg = `Attacked ${targetCity.name}: -${cityDmg} HP (HP: ${targetCity.hp}/50), attacker -${aDmg} HP`;
                if (targetCity.hp <= 0) {
                    if (targetUnit && targetUnit.owner === oldOwnerIdx) this.removeUnit(targetUnit);
                    this._captureCity(attacker, targetCity);
                    msg = `Captured ${targetCity.name}!`;
                    if (this.civs[oldOwnerIdx].isEliminated) msg += ` ${this.civs[oldOwnerIdx].name} eliminated!`;
                    if (attacker.hp <= 0) { this.removeUnit(attacker); msg += ' (pyrrhic victory)'; }
                } else if (attacker.hp <= 0) {
                    this.removeUnit(attacker);
                    msg += ' (attacker died)';
                }
            }
        } else if (targetUnit && targetUnit.owner !== attacker.owner) {
            // Attack unit
            if (unitType === 'melee') {
                const [aDmg, dDmg] = meleeAttack(attacker, targetUnit, attackerTile, targetTile);
                msg = `${defn.name} vs ${UNIT_DEFS[targetUnit.unitType].name}: -${aDmg} / -${dDmg} HP`;
            } else {
                const dDmg = rangedAttack(attacker, targetUnit, targetTile, attackerTile);
                msg = `Ranged hit: ${UNIT_DEFS[targetUnit.unitType].name} -${dDmg} HP`;
            }

            if (targetUnit.hp <= 0) {
                this.removeUnit(targetUnit);
                if (unitType === 'melee' && attacker.hp > 0)
                    this._advanceUnit(attacker, targetQ, targetR);
            } else {
                targetUnit.xp += 2;
            }

            if (attacker.hp <= 0) {
                this.removeUnit(attacker);
                msg += ' (attacker died)';
            } else {
                attacker.xp += 2;
            }
        }

        this.checkVictory();
        return msg;
    }

    checkVictory() {
        if (this.winner !== null || this.turn <= 1) return;
        const originalCaps = this.civs.map(c => c.originalCapital).filter(Boolean);
        if (!originalCaps.length) return;
        for (const civ of this.civs) {
            if (originalCaps.every(cap => cap.owner === civ.playerIndex)) {
                this.winner = civ.playerIndex;
                return;
            }
        }
    }

    // ---- Border expansion ----

    _expandBorder(civ, sourceCity) {
        const candidates = new Set();
        for (const [key, tile] of this.tiles) {
            if (tile.owner !== civ.playerIndex) continue;
            const [q, r] = key.split(',').map(Number);
            for (const [nq, nr] of hexNeighbors(q, r)) {
                const nb = this.tiles.get(`${nq},${nr}`);
                if (nb && nb.owner === null && nb.terrain !== 'ocean')
                    candidates.add(`${nq},${nr}`);
            }
        }
        if (!candidates.size) return;

        let best = null, bestScore = -Infinity;
        for (const key of candidates) {
            const t = this.tiles.get(key);
            const [tq, tr] = key.split(',').map(Number);
            const y = TERRAIN_YIELDS[t.terrain];
            let yieldScore = y.food + y.prod + y.gold;
            if (t.resource) {
                const res = RESOURCES[t.resource];
                const req = res.requires_tech;
                if (!req || civ.techsResearched.has(req)) {
                    const b = res.yield_bonus;
                    yieldScore += (b.food ?? 0) + (b.prod ?? 0) + (b.gold ?? 0);
                }
            }
            const distFromSource = hexDistance(tq, tr, sourceCity.q, sourceCity.r);
            const minDist = Math.min(...civ.cities.map(c => hexDistance(tq, tr, c.q, c.r)));
            const score = yieldScore / (Math.max(1, minDist) * Math.max(1, distFromSource));
            if (score > bestScore) { bestScore = score; best = key; }
        }
        if (best) this.tiles.get(best).owner = civ.playerIndex;
    }

    // ---- Bankruptcy ----

    _applyBankruptcy(civ) {
        const losable = [];
        for (const unit of civ.units)
            if (!unit.isCivilian) losable.push(['unit', unit, null]);
        for (const city of civ.cities)
            for (const b of city.buildings)
                if (b !== 'palace') losable.push(['building', b, city]);

        civ.gold = 0;
        if (!losable.length) { civ.pendingMessages.push('Bankruptcy! No gold left.'); return; }

        const [kind, obj, city] = losable[this._rng.randInt(losable.length)];
        if (kind === 'unit') {
            const name = UNIT_DEFS[obj.unitType].name;
            this.removeUnit(obj);
            civ.pendingMessages.push(`Bankruptcy! ${name} disbanded — treasury emptied.`);
        } else {
            const name = BUILDING_DEFS[obj].name;
            city.buildings.splice(city.buildings.indexOf(obj), 1);
            civ.pendingMessages.push(`Bankruptcy! ${name} in ${city.name} lost — treasury emptied.`);
        }
    }

    // ---- End Turn ----

    endTurn() {
        const civ = this.currentCiv();

        for (const city of civ.cities) {
            const yields = computeCityYields(city, this.tiles, civ);

            // Food growth
            const netFood = yields.food - city.population * 2;
            city.foodStored = Math.max(0, city.foodStored + netFood);
            if (city.foodStored >= city.foodGrowthThreshold) {
                city.population++;
                city.foodStored = 0;
                autoAssignWorkedTiles(city, this.tiles, civ);
            }

            civ.gold    += yields.gold;
            civ.science += yields.science;

            // Culture → border expansion (1 tile per 20 culture)
            civ.culture            += yields.culture;
            city.cultureStored     += yields.culture;
            while (city.cultureStored >= 20) {
                city.cultureStored -= 20;
                this._expandBorder(civ, city);
            }

            // City HP regen
            if (city.hp < 50) city.hp = Math.min(50, city.hp + 3);
        }

        // Unit maintenance: 1g per military unit per turn
        for (const unit of civ.units)
            if (!unit.isCivilian) civ.gold--;

        // Research
        if (civ.currentResearch) {
            const techCost = TECH_DEFS[civ.currentResearch].science_cost;
            if (civ.science >= techCost) {
                civ.science -= techCost;
                const techName = TECH_DEFS[civ.currentResearch].name;
                civ.techsResearched.add(civ.currentResearch);
                civ.currentResearch = null;
                civ.pendingMessages.push(`${techName} researched!`);
                civ.researchJustCompleted = true;
                // Refresh worked tiles now that new resource bonuses may be revealed
                for (const city of civ.cities)
                    autoAssignWorkedTiles(city, this.tiles, civ);
            }
        }

        // Worker build progress
        for (const unit of [...civ.units]) {
            if (unit.buildingImprovement && unit.buildTurnsLeft > 0) {
                unit.buildTurnsLeft--;
                if (unit.buildTurnsLeft === 0) {
                    const tile = this.tiles.get(`${unit.q},${unit.r}`);
                    if (tile) tile.improvement = unit.buildingImprovement;
                    unit.buildingImprovement = null;
                    // Re-evaluate worked tiles for any city that can reach this tile
                    if (tile) {
                        for (const city of civ.cities) {
                            if (hexDistance(unit.q, unit.r, city.q, city.r) <= 3)
                                autoAssignWorkedTiles(city, this.tiles, civ);
                        }
                    }
                }
            }
        }

        // Production
        for (const city of civ.cities) {
            const msg = processProduction(city, civ, this);
            if (msg) civ.pendingMessages.push(msg);
        }

        // Reset movement; handle fortify / healing
        for (const unit of civ.units) {
            if (unit.healing) {
                const tile       = this.tiles.get(`${unit.q},${unit.r}`);
                const inTerritory = tile && tile.owner === civ.playerIndex;
                unit.hp = Math.min(unit.hpMax, unit.hp + (inTerritory ? 20 : 10));
                if (unit.hp >= unit.hpMax) unit.healing = false;
            }
            unit.movesLeft = UNIT_DEFS[unit.unitType].moves;
            if (unit.fortified) unit.fortifyBonus = Math.min(0.5, unit.fortifyBonus + 0.25);
        }

        // Bankruptcy
        if (civ.gold < 0) this._applyBankruptcy(civ);

        // Advance to next non-eliminated player; increment turn on wrap-around
        for (let i = 0; i < this.numPlayers; i++) {
            const next = (this.currentPlayer + 1) % this.numPlayers;
            if (next === 0) this.turn++;
            this.currentPlayer = next;
            if (!this.civs[this.currentPlayer].isEliminated) break;
        }
    }
}

if (typeof module !== 'undefined') module.exports = { Game, computeCityYields, processProduction,
     availableTechs, canResearch, computeScore, calcDamage,
     effectiveStrength, cityCombatStrength, meleeAttack, rangedAttack, bombardCity, getItemCost,
      CITY_NAMES, PLAYER_NAMES, PLAYER_COLORS, DIFFICULTY_DEFS, MAP_COLS, MAP_ROWS };
