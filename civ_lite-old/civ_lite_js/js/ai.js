// ============================================================
// ai.js — CPU AI, ported from systems/ai_e.py
// Depends on: state.js, game.js, hex.js (loaded first)
// ============================================================

// ---------------------------------------------------------------------------
// Leader flavor weights
// ---------------------------------------------------------------------------
const LEADER_FLAVORS = {
    0: { military: 1.1, expansion: 0.8, science: 0.9, buildings: 1.0, aggression: 1.0 },
    1: { military: 0.7, expansion: 0.9, science: 1.3, buildings: 1.3, aggression: 0.7 },
    2: { military: 1.8, expansion: 1.2, science: 0.5, buildings: 0.6, aggression: 1.8 },
    3: { military: 0.8, expansion: 0.8, science: 1.8, buildings: 1.7, aggression: 0.9 },
};

// ---------------------------------------------------------------------------
// Grand Strategy Layer
// ---------------------------------------------------------------------------
const _civStrategies = {};  // { playerIndex: { strategy, turn } }
const STRATEGY_REEVAL_INTERVAL = 25;

const STRATEGY_BOOSTS = {
    DOMINATION: { military: 1.4, aggression: 1.3, expansion: 0.8, science: 0.7, buildings: 0.7 },
    SCIENCE:    { military: 0.8, aggression: 0.7, expansion: 0.9, science: 1.5, buildings: 1.3 },
    EXPANSION:  { military: 0.9, aggression: 0.8, expansion: 1.6, science: 0.9, buildings: 1.0 },
};

function _pickStrategy(game, civ, baseFlavors) {
    const myUnits    = civ.units.filter(u => !u.isCivilian);
    const myStrength = myUnits.reduce((s, u) => s + UNIT_DEFS[u.unitType].strength, 0);

    let dom = baseFlavors.military * 12 + baseFlavors.aggression * 10;
    dom += myStrength * 0.4;
    dom -= civ.techsResearched.size * 1;
    outer: for (const other of game.civs) {
        if (other.playerIndex === civ.playerIndex || other.isEliminated) continue;
        for (const city of other.cities) {
            if (myUnits.some(u => hexDistance(u.q, u.r, city.q, city.r) < 8)) {
                dom += 15; break outer;
            }
        }
    }

    let sci = baseFlavors.science * 12 + baseFlavors.buildings * 6;
    sci += civ.techsResearched.size * 2;
    sci += civ.cities.length * 3;
    sci -= myStrength * 0.2;

    let exp = baseFlavors.expansion * 12;
    const totalLand = [...game.tiles.values()].filter(t => t.terrain !== 'ocean').length;
    const owned     = [...game.tiles.values()].filter(t => t.owner === civ.playerIndex).length;
    exp += (1.0 - owned / Math.max(1, totalLand)) * 20;
    exp -= civ.cities.length * 4;
    if (game.turn > 120) exp -= 20;

    const candidates = [['DOMINATION', dom], ['SCIENCE', sci], ['EXPANSION', exp]];
    return candidates.reduce((best, c) => c[1] > best[1] ? c : best)[0];
}

function _getEffectiveFlavors(game, civ) {
    const base  = LEADER_FLAVORS[civ.playerIndex] ?? LEADER_FLAVORS[0];
    const state = _civStrategies[civ.playerIndex];

    let strategy;
    if (!state || game.turn - state.turn >= STRATEGY_REEVAL_INTERVAL) {
        strategy = _pickStrategy(game, civ, base);
        _civStrategies[civ.playerIndex] = { strategy, turn: game.turn };
    } else {
        strategy = state.strategy;
    }

    // Emergency override: city under direct threat
    const underAttack = game.civs.some(other => {
        if (other.playerIndex === civ.playerIndex || other.isEliminated) return false;
        return other.units.some(u => !u.isCivilian &&
            civ.cities.some(city => hexDistance(u.q, u.r, city.q, city.r) <= 4));
    });
    if (underAttack) strategy = 'DOMINATION';

    const boosts = STRATEGY_BOOSTS[strategy];
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * boosts[k]]));
}

// ---------------------------------------------------------------------------
// Component 1 — Danger Map
// ---------------------------------------------------------------------------
function _buildDangerMap(game, civ) {
    const danger = new Map();
    for (const other of game.civs) {
        if (other.playerIndex === civ.playerIndex || other.isEliminated) continue;
        for (const unit of other.units) {
            if (unit.isCivilian) continue;
            const defn           = UNIT_DEFS[unit.unitType];
            const strength       = defn.strength;
            const moveRange      = defn.moves;
            const attackRange    = defn.range ?? 0;
            const rangedStrength = defn.ranged_strength ?? 0;

            for (const [key, tile] of game.tiles) {
                const [q, r] = key.split(',').map(Number);
                const d = hexDistance(unit.q, unit.r, q, r);
                if (d <= moveRange) {
                    danger.set(key, (danger.get(key) ?? 0) + strength);
                } else if (attackRange && d <= attackRange) {
                    danger.set(key, (danger.get(key) ?? 0) + rangedStrength);
                }
            }
        }
    }
    return danger;
}

// ---------------------------------------------------------------------------
// Component 2 — City Threat Assessment
// ---------------------------------------------------------------------------
function _cityThreat(city, danger) {
    let total = 0;
    for (const [key, val] of danger) {
        const [q, r] = key.split(',').map(Number);
        if (hexDistance(city.q, city.r, q, r) <= 3) total += val;
    }
    return total;
}

// ---------------------------------------------------------------------------
// Component 3 — Attack Target Selection
// ---------------------------------------------------------------------------
function _selectAttackTarget(game, civ, flavors) {
    const myStrength = civ.units
        .filter(u => !u.isCivilian)
        .reduce((s, u) => s + UNIT_DEFS[u.unitType].strength, 0);

    let bestScore = -9999, bestCity = null;

    for (const other of game.civs) {
        if (other.playerIndex === civ.playerIndex || other.isEliminated) continue;

        const enemyStrength = other.units
            .filter(u => !u.isCivilian)
            .reduce((s, u) => s + UNIT_DEFS[u.unitType].strength, 0);

        const maxEnemyRatio = 1.0 + flavors.aggression * 0.5;
        if (myStrength === 0 || enemyStrength > myStrength * maxEnemyRatio) continue;

        for (const city of other.cities) {
            let score = (myStrength - enemyStrength) * 2 + (50 - city.hp) * 1.5;
            if (city.isOriginalCapital) score += 40;
            if (civ.cities.length) {
                const minDist = Math.min(...civ.cities.map(c => hexDistance(city.q, city.r, c.q, c.r)));
                score -= minDist * 1.5;
            } else {
                score -= 30;
            }
            if (score > bestScore) { bestScore = score; bestCity = city; }
        }
    }
    return bestCity;
}

// ---------------------------------------------------------------------------
// Component 4 — Unit Role Assignment
// ---------------------------------------------------------------------------
function _assignRoles(civ, danger, attackTarget) {
    const roles          = new Map(); // unit → role string
    const defenderCities = new Map(); // unit → city

    const threatenedCities = civ.cities.filter(c => _cityThreat(c, danger) > 15);
    const militaryUnits    = civ.units.filter(u => !u.isCivilian);

    const nearestThreatDist = u => {
        if (!threatenedCities.length) return 999;
        return Math.min(...threatenedCities.map(c => hexDistance(u.q, u.r, c.q, c.r)));
    };

    militaryUnits.sort((a, b) => nearestThreatDist(a) - nearestThreatDist(b));

    const assignedDefenderCities = new Set();
    for (const unit of militaryUnits) {
        if (!threatenedCities.length) break;
        const nearest = threatenedCities.reduce((best, c) =>
            hexDistance(unit.q, unit.r, c.q, c.r) < hexDistance(unit.q, unit.r, best.q, best.r) ? c : best
        );
        const dist = hexDistance(unit.q, unit.r, nearest.q, nearest.r);
        if (dist <= 6 && !assignedDefenderCities.has(nearest)) {
            roles.set(unit, 'DEFENDER');
            defenderCities.set(unit, nearest);
            assignedDefenderCities.add(nearest);
        }
    }

    for (const unit of militaryUnits) {
        if (!roles.has(unit))
            roles.set(unit, attackTarget ? 'ATTACKER' : 'PATROL');
    }

    return { roles, defenderCities };
}

// ---------------------------------------------------------------------------
// Component 4b — BFS Distance Map (from target outward)
// ---------------------------------------------------------------------------
function _bfsDistMap(q, r, tiles) {
    const dist = new Map([[`${q},${r}`, 0]]);
    const queue = [{ q, r, d: 0 }];
    while (queue.length) {
        const { q: cq, r: cr, d } = queue.shift();
        for (const [nq, nr] of hexNeighbors(cq, cr)) {
            const key  = `${nq},${nr}`;
            if (dist.has(key)) continue;
            const tile = tiles.get(key);
            if (!tile || !TERRAIN_PASSABLE[tile.terrain]) continue;
            dist.set(key, d + 1);
            queue.push({ q: nq, r: nr, d: d + 1 });
        }
    }
    return dist;
}

// ---------------------------------------------------------------------------
// Component 5 — Military Unit Action
// ---------------------------------------------------------------------------
function _actMilitaryUnit(game, civ, unit, roles, defenderCities, attackTarget, danger, flavors, assaultReady) {
    if (unit.movesLeft === 0) return;

    const role  = roles.get(unit) ?? 'PATROL';
    const defn  = UNIT_DEFS[unit.unitType];
    const xpFactor  = 1.0 + unit.xp * 0.01;
    const myEffStr  = defn.strength * xpFactor;

    let bestScore  = -9999;
    let bestAction = null;

    const attackableSet = getAttackableTiles(unit, game.tiles);
    const reachableMap  = getReachableTiles(unit, game.tiles, game.turn);

    // 1. Score attack options
    for (const key of attackableSet) {
        const tile = game.tiles.get(key);
        if (!tile) continue;

        const targetCity = tile.city;
        const targetUnit = tile.unit ?? tile.civilian;

        let score = 0;

        if (targetCity && targetCity.owner !== civ.playerIndex) {
            if (role === 'ATTACKER' && targetCity === attackTarget && !assaultReady) continue;
            const hpRatio = unit.hp / defn.hp_max;
            if (unit.hp < 30) continue;
            score += 30 + (50 - targetCity.hp) * 0.5;
            if (targetCity === attackTarget) score += 25;
            score -= (1.0 - hpRatio) * 60;
        } else if (targetUnit && targetUnit.owner !== civ.playerIndex) {
            const tDefn  = UNIT_DEFS[targetUnit.unitType];
            const tStr   = tDefn.strength;
            const hpRatio = unit.hp / defn.hp_max;
            score += (myEffStr - tStr) * 4 + (100 - targetUnit.hp) * 0.3;
            score -= (1.0 - hpRatio) * 30;
        } else {
            continue;
        }

        if (role === 'DEFENDER')                                score *= 0.4;
        else if (role === 'ATTACKER' && targetCity === attackTarget) score *= 1.5;
        score *= flavors.military;

        if (score > bestScore) { bestScore = score; bestAction = ['attack', key]; }
    }

    // 2. Score movement options
    let attackPathDist = null;
    if (role === 'ATTACKER' && attackTarget)
        attackPathDist = _bfsDistMap(attackTarget.q, attackTarget.r, game.tiles);

    const unitKey       = `${unit.q},${unit.r}`;
    const currentDanger = danger.get(unitKey) ?? 0;
    const shouldRetreat = currentDanger > 0 && attackableSet.size === 0;
    const unitAttackRange = defn.range ?? 1;

    for (const [key, cost] of reachableMap) {
        const [tq, tr] = key.split(',').map(Number);
        let score = 0;

        if (role === 'DEFENDER') {
            const assignedCity = defenderCities.get(unit);
            if (assignedCity) {
                const curDist = hexDistance(unit.q, unit.r, assignedCity.q, assignedCity.r);
                const newDist = hexDistance(tq, tr, assignedCity.q, assignedCity.r);
                score = (curDist - newDist) * 15;
                const tile = game.tiles.get(key);
                if (tile && tile.city === assignedCity) score += 20;
            }
        } else if (role === 'ATTACKER' && attackTarget) {
            const curDist = attackPathDist.get(unitKey) ?? 999;
            const newDist = attackPathDist.get(key) ?? 999;
            if (!assaultReady && newDist < 5) continue;
            score = (curDist - newDist) * 12;
            const tileDanger = danger.get(key) ?? 0;
            if (tileDanger > myEffStr * 1.5) score -= 40;
        } else {
            // PATROL
            let nearestEnemyDist = 999;
            for (const other of game.civs) {
                if (other.playerIndex === civ.playerIndex || other.isEliminated) continue;
                for (const eu of other.units) {
                    nearestEnemyDist = Math.min(nearestEnemyDist, hexDistance(tq, tr, eu.q, eu.r));
                }
            }
            score = Math.max(0, 10 - nearestEnemyDist);
            const tileDanger = danger.get(key) ?? 0;
            if (tileDanger > myEffStr) score -= 25;
        }

        if (shouldRetreat) {
            const tileDanger = danger.get(key) ?? 0;
            if (tileDanger < currentDanger) score += 25;
        }

        // Bonus for tiles in attack range of enemy unit
        for (const other of game.civs) {
            if (other.playerIndex === civ.playerIndex || other.isEliminated) continue;
            for (const eu of other.units) {
                if (eu.isCivilian) continue;
                const d = hexDistance(tq, tr, eu.q, eu.r);
                if (d >= 1 && d <= unitAttackRange) score += 15;
            }
        }

        if (score > bestScore) { bestScore = score; bestAction = ['move', key, cost]; }
    }

    // 3. Score fortify
    const tile    = game.tiles.get(unitKey);
    const inCity  = tile && tile.city && tile.city.owner === civ.playerIndex;
    let fortifyScore = 5 + (inCity ? 10 : 0) + (role === 'DEFENDER' ? 15 : 0);
    if (fortifyScore > bestScore) { bestScore = fortifyScore; bestAction = ['fortify']; }

    // 4. Score heal
    const hpMax = defn.hp_max;
    if (unit.hp < hpMax) {
        const missing        = hpMax - unit.hp;
        const healXpDiscount = Math.min(0.3, unit.xp * 0.003);
        let healScore        = missing * (0.5 - healXpDiscount);
        if (inCity) healScore += 5;
        if (healScore > bestScore) { bestScore = healScore; bestAction = ['heal']; }
    }

    if (!bestAction) return;

    if (bestAction[0] === 'attack') {
        const [aq, ar] = bestAction[1].split(',').map(Number);
        game.doAttack(unit, aq, ar);
    } else if (bestAction[0] === 'move') {
        const [mq, mr] = bestAction[1].split(',').map(Number);
        if (!game.tiles.get(bestAction[1])) return;
        game.moveUnit(unit, mq, mr, bestAction[2]);
    } else if (bestAction[0] === 'fortify') {
        unit.fortified  = true;
        unit.healing    = false;
        unit.movesLeft  = 0;
    } else if (bestAction[0] === 'heal') {
        unit.healing    = true;
        unit.fortified  = false;
        unit.fortifyBonus = 0;
        unit.movesLeft  = 0;
    }
}

// ---------------------------------------------------------------------------
// Component 6 — Settler Behavior
// ---------------------------------------------------------------------------
function _scoreSettleTile(q, r, game, civ) {
    const tile = game.tiles.get(`${q},${r}`);
    if (tile && tile.owner !== null && tile.owner !== civ.playerIndex) return -9999;
    for (const oc of game.civs)
        for (const city of oc.cities)
            if (hexDistance(q, r, city.q, city.r) <= 2) return -9999;

    let score = 0;
    for (const [hq, hr] of hexesInRange(q, r, 2)) {
        const t = game.tiles.get(`${hq},${hr}`);
        if (!t || t.terrain === 'ocean') continue;
        const y = TERRAIN_YIELDS[t.terrain];
        score += (y.food ?? 0) * 3 + (y.prod ?? 0) * 2 + (y.gold ?? 0);
        if (t.resource) score += 10;
    }

    for (const oc of game.civs)
        for (const city of oc.cities) {
            const dist = hexDistance(q, r, city.q, city.r);
            if (dist < 4) score -= (4 - dist) * 20;
        }

    return score;
}

function _actSettler(game, civ, settler, flavors) {
    if (settler.movesLeft === 0) return;

    const [ok] = game.canFoundCity(settler);
    if (ok && _scoreSettleTile(settler.q, settler.r, game, civ) > 15) {
        game.foundCity(settler);
        return;
    }

    const reachable = getReachableTiles(settler, game.tiles, game.turn);
    let bestScore = -9999, bestMove = null;

    for (const [key, cost] of reachable) {
        const [tq, tr] = key.split(',').map(Number);
        const tile = game.tiles.get(key);
        if (!tile || tile.terrain === 'ocean' || tile.city) continue;
        if (tile.owner !== null && tile.owner !== civ.playerIndex) continue;
        const s = _scoreSettleTile(tq, tr, game, civ) * flavors.expansion;
        if (s > bestScore) { bestScore = s; bestMove = [tq, tr, cost]; }
    }

    if (bestMove) {
        const [tq, tr, cost] = bestMove;
        game.moveUnit(settler, tq, tr, cost);
    }
}

// ---------------------------------------------------------------------------
// Component 7 — Worker Behavior
// ---------------------------------------------------------------------------
function _actWorker(game, civ, worker) {
    if (worker.movesLeft === 0 || worker.buildingImprovement) return;

    const tile = game.tiles.get(`${worker.q},${worker.r}`);
    if (!tile) return;

    let bestImp = null, bestGain = 0;

    for (const [key, defn] of Object.entries(IMPROVEMENT_DEFS)) {
        const terrainOk = defn.valid_terrain.includes(tile.terrain);
        const goldMineOk = key === 'mine' && tile.resource === 'gold' &&
            (tile.terrain === 'grassland' || tile.terrain === 'plains');
        if (!terrainOk && !goldMineOk) continue;
        if (key === 'pasture' && tile.resource !== 'horses') continue;
        if (tile.improvement === key) continue;
        if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;
        const gain = Object.values(defn.yield_bonus).reduce((a, b) => a + b, 0);
        if (gain > bestGain) { bestGain = gain; bestImp = key; }
    }

    if (bestImp) {
        game.startImprovement(worker, bestImp);
        return;
    }

    const reachable = getReachableTiles(worker, game.tiles, game.turn);
    for (const [key, cost] of reachable) {
        const t = game.tiles.get(key);
        if (!t) continue;
        if (t.owner === civ.playerIndex && !t.improvement) {
            const [tq, tr] = key.split(',').map(Number);
            game.moveUnit(worker, tq, tr, cost);
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Component 8 — City Production Scoring
// ---------------------------------------------------------------------------
function _actCity(game, civ, city, flavors, attackTarget) {
    if (city.productionQueue.length) return;

    const yields  = computeCityYields(city, game.tiles, civ);
    const prodPt  = Math.max(1, yields.prod);

    const militaryCount = civ.units.filter(u => !u.isCivilian).length;
    const cityCount     = civ.cities.length;
    const militaryNeed  = Math.max(0, cityCount * 2 - militaryCount);
    const rangedCount   = civ.units.filter(u => !u.isCivilian && UNIT_DEFS[u.unitType].ranged_strength).length;
    const rangedRatio   = militaryCount > 0 ? rangedCount / militaryCount : 0;

    // Priority 1: Enemy nearby → best military unit
    const underAttack = game.civs.some(other => {
        if (other.playerIndex === civ.playerIndex || other.isEliminated) return false;
        return other.units.some(u => !u.isCivilian && hexDistance(u.q, u.r, city.q, city.r) <= 4);
    });
    if (underAttack) {
        let bestKey = null, bestStr = -1;
        for (const [key, defn] of Object.entries(UNIT_DEFS)) {
            if (defn.type === 'civilian') continue;
            if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;
            if (defn.requires_resource && ![...game.tiles.values()].some(
                t => t.resource === defn.requires_resource && t.owner === civ.playerIndex)) continue;
            const s = defn.ranged_strength ?? defn.strength;
            if (s > bestStr) { bestStr = s; bestKey = key; }
        }
        if (bestKey) { city.productionQueue.push(bestKey); return; }
    }

    // Priority 2: No worker → build one
    const hasWorker    = civ.units.some(u => u.unitType === 'worker');
    const workerQueued = civ.cities.some(c => c !== city && c.productionQueue.includes('worker'));
    if (!hasWorker && !workerQueued) { city.productionQueue.push('worker'); return; }

    // Priority 3: Fewer than 3 cities → settler
    if (cityCount < 3 && city.population >= 2 &&
        !civ.units.some(u => u.unitType === 'settler') &&
        !civ.cities.some(c => c !== city && c.productionQueue.includes('settler'))) {
        city.productionQueue.push('settler'); return;
    }

    // Normal scoring
    let bestScore = -9999, bestKey = null;

    for (const [key, defn] of Object.entries(UNIT_DEFS)) {
        let score;
        if (defn.type === 'civilian') {
            if (key === 'settler') {
                if (cityCount >= 4) continue;
                if (city.population < 2) continue;
                if (civ.units.some(u => u.unitType === 'settler')) continue;
                if (civ.cities.some(c => c !== city && c.productionQueue.includes('settler'))) continue;
                score = 55 * flavors.expansion;
            } else if (key === 'worker') {
                score = civ.units.some(u => u.unitType === 'worker') ? 5 : 40;
            } else { continue; }
        } else {
            if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;
            if (defn.requires_resource && ![...game.tiles.values()].some(
                t => t.resource === defn.requires_resource && t.owner === civ.playerIndex)) continue;
            const effStr     = defn.ranged_strength ?? defn.strength;
            const siegeUrgency = attackTarget ? 2.0 : 1.0;
            let base         = 30 + effStr * 1.5 + (defn.bonus_vs_city ?? 0) * 5 * siegeUrgency;
            score = (base + militaryNeed * 8) * flavors.military;
            if (defn.ranged_strength && rangedRatio > 0.5) score *= 0.35;
            else if (!defn.ranged_strength && rangedRatio < 0.25) score *= 0.65;
        }

        const turns = Math.max(1, Math.ceil((getItemCost(key) - city.productionProgress) / prodPt));
        score -= turns * 0.5;
        if (score > bestScore) { bestScore = score; bestKey = key; }
    }

    for (const [key, defn] of Object.entries(BUILDING_DEFS)) {
        if (key === 'palace' || city.buildings.includes(key)) continue;
        if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;

        const eff = defn.effects ?? {};
        let score = 0;
        score += (eff.food_per_turn    ?? 0) * 8  * flavors.buildings;
        score += (eff.prod_per_turn    ?? 0) * 7  * flavors.buildings;
        score += (eff.gold_per_turn    ?? 0) * 6  * flavors.buildings;
        score += (eff.science_per_turn ?? 0) * 9  * flavors.science;
        score += (eff.culture_per_turn ?? 0) * 4  * flavors.buildings;
        if (defn.defense) score += 15 * flavors.buildings;
        if (militaryNeed > 2) score *= 0.6;

        const turns = Math.max(1, Math.ceil((getItemCost(key) - city.productionProgress) / prodPt));
        score -= turns * 0.3;
        if (score > bestScore) { bestScore = score; bestKey = key; }
    }

    if (bestKey) city.productionQueue.push(bestKey);
}

// ---------------------------------------------------------------------------
// Component 9 — Research Scoring
// ---------------------------------------------------------------------------
function _pickResearch(game, civ, flavors) {
    if (civ.currentResearch) return;

    let bestScore = -9999, bestTech = null;

    for (const [key, defn] of Object.entries(TECH_DEFS)) {
        if (civ.techsResearched.has(key)) continue;
        if (!defn.prerequisites.every(p => civ.techsResearched.has(p))) continue;

        let score = 0;
        for (const uKey of defn.unlocks_units ?? []) {
            score += (UNIT_DEFS[uKey]?.strength ?? 5) * 2 * flavors.military;
        }
        for (const bKey of defn.unlocks_buildings ?? []) {
            const eff = BUILDING_DEFS[bKey]?.effects ?? {};
            score += (eff.science_per_turn ?? 0) * 8 * flavors.science;
            score += (eff.gold_per_turn    ?? 0) * 5 * flavors.buildings;
            score += (eff.prod_per_turn    ?? 0) * 4 * flavors.buildings;
            score += (eff.food_per_turn    ?? 0) * 4 * flavors.buildings;
        }
        for (const _ of defn.unlocks_improvements ?? []) {
            score += 15 * flavors.buildings;
        }
        for (const res of defn.reveals_resources ?? []) {
            if ([...game.tiles.values()].some(t => t.resource === res && t.owner === civ.playerIndex))
                score += 25;
        }
        score -= defn.science_cost * 0.05;

        if (score > bestScore) { bestScore = score; bestTech = key; }
    }

    if (bestTech) civ.currentResearch = bestTech;
}

// ---------------------------------------------------------------------------
// Component 10 — Gold / Buy Decisions
// ---------------------------------------------------------------------------
function _actGold(game, civ, flavors) {
    const militaryCount = civ.units.filter(u => !u.isCivilian).length;
    if (militaryCount >= civ.cities.length) return;

    const goldThreshold = Math.trunc(80 / flavors.aggression);
    if (civ.gold < goldThreshold) return;

    let bestCity = null, bestThreat = -1;
    for (const city of civ.cities) {
        const cityTile = game.tiles.get(`${city.q},${city.r}`);
        if (cityTile && !cityTile.unit) {
            const threat = game.civs.reduce((sum, oc) => {
                if (oc.playerIndex === civ.playerIndex) return sum;
                return sum + oc.units.filter(u => !u.isCivilian &&
                    hexDistance(u.q, u.r, city.q, city.r) <= 5).length;
            }, 0);
            if (threat > bestThreat) { bestThreat = threat; bestCity = city; }
        }
    }
    if (!bestCity) return;

    let bestKey = null, bestStr = 0;
    for (const [key, defn] of Object.entries(UNIT_DEFS)) {
        if (defn.type === 'civilian') continue;
        if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;
        const goldCost = getItemCost(key) * 2;
        if (civ.gold >= goldCost && defn.strength > bestStr) {
            bestStr = defn.strength; bestKey = key;
        }
    }
    if (bestKey) game.buyItem(bestCity, bestKey);
}

// ---------------------------------------------------------------------------
// Component 11 — Unit Upgrades
// ---------------------------------------------------------------------------
function _actUpgrades(game, civ, flavors) {
    const goldReserve = Math.trunc(40 / flavors.aggression);

    for (const unit of [...civ.units]) {
        if (unit.isCivilian || unit.movesLeft === 0) continue;
        const path = UNIT_UPGRADES[unit.unitType];
        if (!path) continue;
        const [, goldCost] = path;
        if (civ.gold - goldCost < goldReserve) continue;
        const [ok] = game.upgradeUnit(unit);
        if (ok) continue;  // spent moves; next unit
    }
}

// ---------------------------------------------------------------------------
// Main AI Entry Point
// ---------------------------------------------------------------------------
function aiTakeTurn(game, civ) {
    const flavors      = _getEffectiveFlavors(game, civ);
    const danger       = _buildDangerMap(game, civ);
    const attackTarget = _selectAttackTarget(game, civ, flavors);
    const { roles, defenderCities } = _assignRoles(civ, danger, attackTarget);

    // Muster check
    let assaultReady = true;
    if (attackTarget) {
        const MUSTER_RADIUS     = 5;
        const REFERENCE_STR     = 10;
        const minAttackers      = Math.round(attackTarget.hp / (50 / 3) + 1);
        let effectiveCount      = 0;
        let meleePresent        = false;

        for (const u of civ.units) {
            if (u.isCivilian || roles.get(u) !== 'ATTACKER') continue;
            if (hexDistance(u.q, u.r, attackTarget.q, attackTarget.r) > MUSTER_RADIUS) continue;
            const uDefn     = UNIT_DEFS[u.unitType];
            const uXp       = 1.0 + u.xp * 0.01;
            const cityMult  = uDefn.bonus_vs_city ?? 1.0;
            if (uDefn.ranged_strength) {
                effectiveCount += uDefn.ranged_strength * uXp * cityMult / REFERENCE_STR;
            } else {
                effectiveCount += Math.min(1.5, Math.max(1.0, uDefn.strength * uXp / REFERENCE_STR));
                meleePresent = true;
            }
        }
        assaultReady = effectiveCount >= minAttackers && meleePresent;
    }

    _pickResearch(game, civ, flavors);

    for (const city of civ.cities)
        _actCity(game, civ, city, flavors, attackTarget);

    _actUpgrades(game, civ, flavors);

    for (const unit of [...civ.units]) {
        if (!unit.isCivilian) continue;
        if (unit.unitType === 'settler') _actSettler(game, civ, unit, flavors);
        else if (unit.unitType === 'worker') _actWorker(game, civ, unit);
    }

    for (const unit of [...civ.units]) {
        if (unit.isCivilian) continue;
        _actMilitaryUnit(game, civ, unit, roles, defenderCities, attackTarget, danger, flavors, assaultReady);
    }

    _actGold(game, civ, flavors);
}

if (typeof module !== 'undefined') module.exports = { aiTakeTurn };
