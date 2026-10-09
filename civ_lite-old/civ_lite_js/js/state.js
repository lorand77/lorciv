// ============================================================
// state.js — Game data definitions + entity classes + BFS/LOS
// All ported directly from the Python civ_lite_py codebase.
// ============================================================

// ============================================================
// Data definitions
// ============================================================

const UNIT_DEFS = {
    warrior: {
        name: 'Warrior', type: 'melee',
        strength: 8, moves: 2, hp_max: 100, prod_cost: 40,
        requires_tech: null, requires_resource: null, label: 'W',
    },
    archer: {
        name: 'Archer', type: 'ranged',
        strength: 5, ranged_strength: 7, range: 2,
        moves: 2, hp_max: 100, prod_cost: 40,
        requires_tech: 'archery', requires_resource: null, label: 'A',
    },
    settler: {
        name: 'Settler', type: 'civilian',
        strength: 0, moves: 2, hp_max: 100, prod_cost: 100,
        requires_tech: null, requires_resource: null, label: 'Se',
    },
    worker: {
        name: 'Worker', type: 'civilian',
        strength: 0, moves: 2, hp_max: 100, prod_cost: 60,
        requires_tech: null, requires_resource: null, label: 'Wo',
    },
    spearman: {
        name: 'Spearman', type: 'melee',
        strength: 11, moves: 2, hp_max: 100, prod_cost: 60,
        requires_tech: 'bronze_working', requires_resource: null, label: 'Sp',
        bonus_vs: { horseman: 1.0 },
    },
    swordsman: {
        name: 'Swordsman', type: 'melee',
        strength: 14, moves: 2, hp_max: 100, prod_cost: 80,
        requires_tech: 'iron_working', requires_resource: 'iron', label: 'Sw',
    },
    horseman: {
        name: 'Horseman', type: 'melee',
        strength: 12, moves: 4, hp_max: 100, prod_cost: 80,
        requires_tech: 'horseback_riding', requires_resource: 'horses', label: 'H',
    },
    catapult: {
        name: 'Catapult', type: 'ranged',
        strength: 5, ranged_strength: 8, range: 2,
        moves: 2, hp_max: 100, prod_cost: 100,
        requires_tech: 'mathematics', requires_resource: null, label: 'Ca',
        bonus_vs_city: 2.0,
    },
    pikeman: {
        name: 'Pikeman', type: 'melee',
        strength: 16, moves: 2, hp_max: 100, prod_cost: 90,
        requires_tech: 'feudalism', requires_resource: null, label: 'Pi',
        bonus_vs: { horseman: 1.5, knight: 1.5 },
    },
    longswordsman: {
        name: 'Longswordsman', type: 'melee',
        strength: 21, moves: 2, hp_max: 100, prod_cost: 100,
        requires_tech: 'steel', requires_resource: 'iron', label: 'Ls',
    },
    knight: {
        name: 'Knight', type: 'melee',
        strength: 20, moves: 4, hp_max: 100, prod_cost: 120,
        requires_tech: 'steel', requires_resource: 'horses', label: 'Kn',
    },
    crossbowman: {
        name: 'Crossbowman', type: 'ranged',
        strength: 12, ranged_strength: 18, range: 2,
        moves: 2, hp_max: 100, prod_cost: 90,
        requires_tech: 'machinery', requires_resource: null, label: 'Xb',
    },
    trebuchet: {
        name: 'Trebuchet', type: 'ranged',
        strength: 13, ranged_strength: 14, range: 2,
        moves: 2, hp_max: 100, prod_cost: 120,
        requires_tech: 'machinery', requires_resource: null, label: 'Tr',
        bonus_vs_city: 2.5,
    },
};

// from_unit → [to_unit, gold_cost]
const UNIT_UPGRADES = {
    warrior:   ['swordsman',     60],
    spearman:  ['pikeman',       60],
    swordsman: ['longswordsman', 50],
    archer:    ['crossbowman',   70],
    horseman:  ['knight',        60],
    catapult:  ['trebuchet',     40],
};

const TECH_DEFS = {
    mining: {
        name: 'Mining', era: 'ancient', science_cost: 35,
        prerequisites: [],
        unlocks_units: [], unlocks_buildings: [], unlocks_improvements: ['mine'],
        reveals_resources: ['iron'],
    },
    animal_husbandry: {
        name: 'Animal Husbandry', era: 'ancient', science_cost: 35,
        prerequisites: [],
        unlocks_units: [], unlocks_buildings: [], unlocks_improvements: ['pasture'],
        reveals_resources: ['horses'],
    },
    archery: {
        name: 'Archery', era: 'ancient', science_cost: 35,
        prerequisites: [],
        unlocks_units: ['archer'], unlocks_buildings: [], unlocks_improvements: [],
        reveals_resources: [],
    },
    pottery: {
        name: 'Pottery', era: 'ancient', science_cost: 35,
        prerequisites: [],
        unlocks_units: [], unlocks_buildings: ['granary'], unlocks_improvements: [],
        reveals_resources: [],
    },
    bronze_working: {
        name: 'Bronze Working', era: 'ancient', science_cost: 55,
        prerequisites: ['mining'],
        unlocks_units: ['spearman'], unlocks_buildings: [], unlocks_improvements: [],
        reveals_resources: [],
    },
    iron_working: {
        name: 'Iron Working', era: 'classical', science_cost: 80,
        prerequisites: ['bronze_working'],
        unlocks_units: ['swordsman'], unlocks_buildings: ['forge'], unlocks_improvements: [],
        reveals_resources: [],
    },
    horseback_riding: {
        name: 'Horseback Riding', era: 'classical', science_cost: 80,
        prerequisites: ['animal_husbandry'],
        unlocks_units: ['horseman'], unlocks_buildings: [], unlocks_improvements: [],
        reveals_resources: [],
    },
    writing: {
        name: 'Writing', era: 'classical', science_cost: 80,
        prerequisites: ['pottery'],
        unlocks_units: [], unlocks_buildings: ['library'], unlocks_improvements: [],
        reveals_resources: [],
    },
    mathematics: {
        name: 'Mathematics', era: 'classical', science_cost: 100,
        prerequisites: ['writing', 'archery'],
        unlocks_units: ['catapult'], unlocks_buildings: ['walls'], unlocks_improvements: [],
        reveals_resources: [],
    },
    currency: {
        name: 'Currency', era: 'classical', science_cost: 100,
        prerequisites: ['writing'],
        unlocks_units: [], unlocks_buildings: ['market'], unlocks_improvements: [],
        reveals_resources: [],
    },
    feudalism: {
        name: 'Feudalism', era: 'medieval', science_cost: 130,
        prerequisites: ['iron_working'],
        unlocks_units: ['pikeman'], unlocks_buildings: ['castle'], unlocks_improvements: [],
        reveals_resources: [],
    },
    steel: {
        name: 'Steel', era: 'medieval', science_cost: 150,
        prerequisites: ['iron_working'],
        unlocks_units: ['longswordsman', 'knight'], unlocks_buildings: [], unlocks_improvements: [],
        reveals_resources: [],
    },
    machinery: {
        name: 'Machinery', era: 'medieval', science_cost: 150,
        prerequisites: ['mathematics'],
        unlocks_units: ['crossbowman', 'trebuchet'], unlocks_buildings: [], unlocks_improvements: [],
        reveals_resources: [],
    },
    theology: {
        name: 'Theology', era: 'medieval', science_cost: 130,
        prerequisites: ['writing'],
        unlocks_units: [], unlocks_buildings: ['cathedral'], unlocks_improvements: [],
        reveals_resources: [],
    },
    education: {
        name: 'Education', era: 'medieval', science_cost: 175,
        prerequisites: ['theology'],
        unlocks_units: [], unlocks_buildings: ['university'], unlocks_improvements: [],
        reveals_resources: [],
    },
    civil_service: {
        name: 'Civil Service', era: 'medieval', science_cost: 160,
        prerequisites: ['currency'],
        unlocks_units: [], unlocks_buildings: ['bank'], unlocks_improvements: [],
        reveals_resources: [],
    },
};

const BUILDING_DEFS = {
    palace:   { name: 'Palace',   prod_cost: 0,   requires_tech: null,          effects: { prod_per_turn: 3, gold_per_turn: 3, culture_per_turn: 2 }, maintenance: 0 },
    monument: { name: 'Monument', prod_cost: 60,  requires_tech: null,          effects: { culture_per_turn: 2 }, maintenance: 0 },
    granary:  { name: 'Granary',  prod_cost: 80,  requires_tech: 'pottery',     effects: { food_per_turn: 2 }, maintenance: 1 },
    library:  { name: 'Library',  prod_cost: 100, requires_tech: 'writing',     effects: { science_per_turn: 2 }, maintenance: 1 },
    market:   { name: 'Market',   prod_cost: 100, requires_tech: 'currency',    effects: { gold_per_turn: 2 }, maintenance: 0 },
    forge:    { name: 'Forge',    prod_cost: 120, requires_tech: 'iron_working', effects: {}, maintenance: 1 },
    walls:    { name: 'Walls',    prod_cost: 80,  requires_tech: 'mathematics', effects: {}, defense: 4, maintenance: 1 },
    castle:   { name: 'Castle',   prod_cost: 130, requires_tech: 'feudalism',   effects: { gold_per_turn: 1, culture_per_turn: 3 }, defense: 6, maintenance: 2 },
    cathedral:{ name: 'Cathedral',prod_cost: 120, requires_tech: 'theology',    effects: { culture_per_turn: 4, food_per_turn: 1 }, maintenance: 2 },
    university:{name: 'University',prod_cost: 160,requires_tech: 'education',   effects: { science_per_turn: 4 }, maintenance: 2 },
    bank:     { name: 'Bank',     prod_cost: 140, requires_tech: 'civil_service',effects: { gold_per_turn: 3 }, maintenance: 0 },
};

const IMPROVEMENT_DEFS = {
    farm:    { name: 'Farm',    build_turns: 3, valid_terrain: ['grassland','plains'],  requires_tech: null,               yield_bonus: { food: 1 }, label: 'f' },
    mine:    { name: 'Mine',    build_turns: 3, valid_terrain: ['hills','forest'],       requires_tech: 'mining',           yield_bonus: { prod: 1 }, label: 'm' },
    pasture: { name: 'Pasture', build_turns: 3, valid_terrain: ['grassland','plains'],  requires_tech: 'animal_husbandry', yield_bonus: { prod: 1 }, label: 'p' },
};

const RESOURCES = {
    iron:     { type: 'strategic', valid_terrain: ['hills'],                 yield_bonus: { prod: 1 }, requires_tech: 'mining',           enables_unit: 'swordsman' },
    horses:   { type: 'strategic', valid_terrain: ['plains','grassland'],    yield_bonus: { food: 1 }, requires_tech: 'animal_husbandry', enables_unit: 'horseman'  },
    gold:     { type: 'luxury',    valid_terrain: ['plains','grassland'],    yield_bonus: { gold: 3 }, requires_tech: null },
    silver:   { type: 'luxury',    valid_terrain: ['hills'],                 yield_bonus: { gold: 2 }, requires_tech: null },
    diamonds: { type: 'luxury',    valid_terrain: ['forest','hills'],        yield_bonus: { gold: 4 }, requires_tech: null },
};

const TERRAIN_YIELDS = {
    grassland: { food: 2, prod: 0, gold: 0 },
    plains:    { food: 1, prod: 1, gold: 0 },
    hills:     { food: 0, prod: 2, gold: 0 },
    forest:    { food: 1, prod: 1, gold: 0 },
    ocean:     { food: 0, prod: 0, gold: 0 },
};

const TERRAIN_DEFENSE_BONUS = {
    grassland: 0,
    plains:    0,
    hills:     0.25,
    forest:    0.25,
    ocean:     0,
};

const TERRAIN_PASSABLE = {
    grassland: true,
    plains:    true,
    hills:     true,
    forest:    true,
    ocean:     false,
};

const TERRAIN_MOVE_COST = {
    grassland: 1,
    plains:    1,
    hills:     2,
    forest:    2,
    ocean:     99,
};

const TERRAIN_BLOCKS_LOS = {
    grassland: false,
    plains:    false,
    hills:     true,
    forest:    true,
    ocean:     false,
};

// ============================================================
// Entity classes
// ============================================================

class Unit {
    constructor({ unitType, owner, q, r, hp = null, movesLeft = null,
                  fortified = false, fortifyBonus = 0.0, healing = false,
                  xp = 0, buildingImprovement = null, buildTurnsLeft = 0 }) {
        this.unitType          = unitType;
        this.owner             = owner;
        this.q                 = q;
        this.r                 = r;
        this.hp                = hp ?? UNIT_DEFS[unitType].hp_max;
        this.movesLeft         = movesLeft ?? UNIT_DEFS[unitType].moves;
        this.fortified         = fortified;
        this.fortifyBonus      = fortifyBonus;
        this.healing           = healing;
        this.xp                = xp;
        this.buildingImprovement = buildingImprovement;
        this.buildTurnsLeft    = buildTurnsLeft;
    }

    get defn()       { return UNIT_DEFS[this.unitType]; }
    get isCivilian() { return this.defn.type === 'civilian'; }
    get label()      { return this.defn.label; }
    get name()       { return this.defn.name; }
    get hpMax()      { return this.defn.hp_max; }
}

class City {
    constructor({ name, q, r, owner, population = 1, foodStored = 0, hp = 50,
                  buildings = null, productionQueue = null, productionProgress = 0,
                  workedTiles = null, isOriginalCapital = false, cultureStored = 0 }) {
        this.name               = name;
        this.q                  = q;
        this.r                  = r;
        this.owner              = owner;
        this.population         = population;
        this.foodStored         = foodStored;
        this.hp                 = hp;
        this.buildings          = buildings ?? [];
        this.productionQueue    = productionQueue ?? [];
        this.productionProgress = productionProgress;
        this.workedTiles        = workedTiles ?? [[q, r]];
        this.isOriginalCapital  = isOriginalCapital;
        this.cultureStored      = cultureStored;
    }

    get foodGrowthThreshold() {
        return 15 + 6 * this.population;
    }
}

class Civilization {
    constructor({ playerIndex, name, color, isCpu = false, difficulty = 'prince' }) {
        this.playerIndex          = playerIndex;
        this.name                 = name;
        this.color                = color;  // CSS color string
        this.isCpu                = isCpu;
        this.difficulty           = difficulty;

        this.cities               = [];
        this.units                = [];

        this.gold                 = 0;
        this.goldPerTurn          = 0;
        this.science              = 0;
        this.sciencePerTurn       = 0;
        this.culture              = 0;

        this.currentResearch      = null;
        this.techsResearched      = new Set();
        this.originalCapital      = null;
        this.isEliminated         = false;
        this.pendingMessages      = [];
        this.researchJustCompleted= false;

        this.prodMult             = 1.0;
        this.foodMult             = 1.0;
        this.startingXp           = 0;
    }
}

// ============================================================
// Movement: BFS reachable tiles
// Port of get_reachable_tiles from unit.py
// Returns Map<'q,r', moveCost>
// ============================================================

function getReachableTiles(unit, tiles, turn = 99) {
    const startKey = `${unit.q},${unit.r}`;
    const maxMoves = unit.movesLeft;
    const visited  = new Map([[startKey, 0]]);
    const queue    = [{ q: unit.q, r: unit.r, used: 0 }];
    const reachable = new Map();

    while (queue.length) {
        const { q, r, used } = queue.shift();
        for (const [nq, nr] of hexNeighbors(q, r)) {
            const key  = `${nq},${nr}`;
            const tile = tiles.get(key);
            if (!tile) continue;
            if (!TERRAIN_PASSABLE[tile.terrain]) continue;

            const cost = used + TERRAIN_MOVE_COST[tile.terrain];
            if (cost > maxMoves) continue;
            if (visited.has(key) && visited.get(key) <= cost) continue;
            visited.set(key, cost);

            if (unit.isCivilian) {
                if (tile.civilian) continue;
                if (tile.unit && tile.unit.owner !== unit.owner) continue;
                reachable.set(key, cost);
                queue.push({ q: nq, r: nr, used: cost });
            } else {
                if (tile.unit && tile.unit.owner === unit.owner) continue;
                if (tile.unit && tile.unit.owner !== unit.owner) continue;
                if (tile.city && tile.city.owner !== unit.owner) continue;
                if (tile.civilian && tile.civilian.owner !== unit.owner) {
                    if (turn <= 1 && tile.civilian.unitType === 'settler') continue;
                    reachable.set(key, cost);
                    continue;
                }
                reachable.set(key, cost);
                queue.push({ q: nq, r: nr, used: cost });
            }
        }
    }

    return reachable;
}

// ============================================================
// Combat: attackable tiles with LOS
// Port of get_attackable_tiles from unit.py
// Returns Set<'q,r'>
// ============================================================

function getAttackableTiles(unit, tiles) {
    if (unit.isCivilian || unit.movesLeft === 0) return new Set();

    const defn        = unit.defn;
    const attackRange = defn.range ?? 1;
    const targets     = new Set();

    if (attackRange === 1) {
        // Melee: adjacent only — requires enough moves to enter the target tile
        for (const [nq, nr] of hexNeighbors(unit.q, unit.r)) {
            const tile = tiles.get(`${nq},${nr}`);
            if (!tile) continue;
            if ((TERRAIN_MOVE_COST[tile.terrain] ?? 1) > unit.movesLeft) continue;
            // City checked first — matches doAttack dispatch priority
            if (tile.city && tile.city.owner !== unit.owner) targets.add(`${nq},${nr}`);
            else if (tile.unit && tile.unit.owner !== unit.owner) targets.add(`${nq},${nr}`);
        }
    } else {
        // Ranged: within range with unobstructed LOS.
        // Intermediate rough terrain (hills/forest) blocks; endpoint terrain does not.
        for (const [key, tile] of tiles) {
            const [tq, tr] = key.split(',').map(Number);
            const dist = hexDistance(unit.q, unit.r, tq, tr);
            if (dist === 0 || dist > attackRange) continue;
            if (!(tile.unit && tile.unit.owner !== unit.owner) &&
                !(tile.city && tile.city.owner !== unit.owner)) continue;

            let losBlocked = false;
            for (const [iq, ir] of hexLine(unit.q, unit.r, tq, tr)) {
                const itile = tiles.get(`${iq},${ir}`);
                if (itile && TERRAIN_BLOCKS_LOS[itile.terrain]) {
                    losBlocked = true;
                    break;
                }
            }
            if (!losBlocked) targets.add(key);
        }
    }

    return targets;
}

// ============================================================
// City: auto-assign worked tiles
// Port of auto_assign_worked_tiles from city.py
// ============================================================

function autoAssignWorkedTiles(city, tiles, civ = null) {
    city.workedTiles = [[city.q, city.r]];
    const candidates = [];

    for (const [nq, nr] of hexesInRange(city.q, city.r, 3)) {
        if (nq === city.q && nr === city.r) continue; // city center already included
        const tile = tiles.get(`${nq},${nr}`);
        if (!tile || tile.terrain === 'ocean') continue;
        if (tile.owner !== city.owner) continue;

        const y = TERRAIN_YIELDS[tile.terrain];
        let score = y.food * 1.1 + y.prod + y.gold;

        if (tile.resource && RESOURCES[tile.resource]) {
            const res = RESOURCES[tile.resource];
            const techOk = !res.requires_tech || !civ || civ.techsResearched.has(res.requires_tech);
            if (techOk) {
                const b = res.yield_bonus;
                score += (b.food ?? 0) * 1.1 + (b.prod ?? 0) + (b.gold ?? 0);
            }
        }
        if (tile.improvement && IMPROVEMENT_DEFS[tile.improvement]) {
            const b = IMPROVEMENT_DEFS[tile.improvement].yield_bonus;
            score += (b.food ?? 0) * 1.1 + (b.prod ?? 0) + (b.gold ?? 0);
        }

        candidates.push({ q: nq, r: nr, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const slots = Math.min(city.population, candidates.length);
    for (let i = 0; i < slots; i++) {
        city.workedTiles.push([candidates[i].q, candidates[i].r]);
    }
}

if (typeof module !== 'undefined') module.exports = {
    UNIT_DEFS, UNIT_UPGRADES, TECH_DEFS, BUILDING_DEFS, IMPROVEMENT_DEFS,
    RESOURCES, TERRAIN_YIELDS, TERRAIN_DEFENSE_BONUS, TERRAIN_PASSABLE,
    TERRAIN_MOVE_COST, TERRAIN_BLOCKS_LOS,
    Unit, City, Civilization,
    getReachableTiles, getAttackableTiles, autoAssignWorkedTiles,
};
