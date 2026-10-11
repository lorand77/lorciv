"use strict";

// ============================================================
// actions.js — the one validator for player actions. applyAction is the
// only way a player's intent reaches the engine: the server runs it on the
// authoritative game, the browser may run it on its copy to preview. It
// checks the turn, the seat's ownership of the unit or city, and legality
// by the engine's own rules, then applies through the Game's methods.
// Shared by server and browser.
// ============================================================

// Node: the files this one reads as bare names, hoisted onto globalThis. In the
// browser they are globals already, from the earlier <script> tags.
if (typeof module !== "undefined" && module.exports) {
    Object.assign(globalThis, require("./state"), require("./game"), require("./settings"));
}

// Result shapes. `error` is a short code for the client to switch on;
// `message` is the engine's own wording where it has one.
function fail(error, message = "") { return { ok: false, error, message }; }
function done(message = "") { return { ok: true, message }; }

function isCoord(v) { return Number.isInteger(v); }

// A key a client sent names an entry of the catalogue only if it is a string
// the catalogue itself holds: `defs[key]` alone would accept "constructor" and
// friends from Object.prototype, and arrays that stringify to a real key.
function isKeyOf(defs, key) { return typeof key === "string" && Object.hasOwn(defs, key); }
function isItem(key) { return isKeyOf(UNIT_DEFS, key) || isKeyOf(BUILDING_DEFS, key); }

// The unit `id` if it exists and belongs to `seat`, else a failure result.
function ownUnit(game, seat, id) {
    const unit = Number.isInteger(id) ? game.unitById(id) : null;
    if (!unit) return [null, fail("no_such_unit")];
    if (unit.owner !== seat) return [null, fail("not_yours")];
    return [unit, null];
}

function ownCity(game, seat, id) {
    const city = Number.isInteger(id) ? game.cityById(id) : null;
    if (!city) return [null, fail("no_such_city")];
    if (city.owner !== seat) return [null, fail("not_yours")];
    return [city, null];
}

// A Game method's [ok, message] as a result.
function fromPair([ok, message]) { return ok ? done(message) : fail("illegal", message); }

function applyAction(game, seat, action) {
    if (game.winner !== null) return fail("game_over");
    if (!action || typeof action !== "object") return fail("unknown_action");
    if (!ACTION_TYPES.includes(action.type)) return fail("unknown_action");
    const civ = game.civs[seat];
    if (!civ || civ.isEliminated || game.currentPlayer !== seat) return fail("not_your_turn");

    switch (action.type) {
        case "move": {
            const [unit, err] = ownUnit(game, seat, action.unitId);
            if (err) return err;
            if (!isCoord(action.q) || !isCoord(action.r)) return fail("illegal", "Bad destination.");
            const cost = getReachableTiles(unit, game.tiles, game.turn).get(`${action.q},${action.r}`);
            if (cost === undefined) return fail("illegal", "Cannot move there.");
            game.moveUnit(unit, action.q, action.r, cost);
            return done();
        }
        case "attack": {
            const [unit, err] = ownUnit(game, seat, action.unitId);
            if (err) return err;
            if (!isCoord(action.q) || !isCoord(action.r)) return fail("illegal", "Bad target.");
            if (!getAttackableTiles(unit, game.tiles).has(`${action.q},${action.r}`)) {
                return fail("illegal", "Cannot attack there.");
            }
            return done(game.doAttack(unit, action.q, action.r));
        }
        case "foundCity": {
            const [unit, err] = ownUnit(game, seat, action.unitId);
            if (err) return err;
            if (unit.unitType !== "settler") return fail("illegal", "Only a settler can found a city.");
            if (unit.movesLeft === 0) return fail("illegal", "No moves left.");
            const [can, why] = game.canFoundCity(unit);
            if (!can) return fail("illegal", why);
            const city = game.foundCity(unit);
            return done(`Founded ${city.name}.`);
        }
        case "buildImprovement": {
            const [unit, err] = ownUnit(game, seat, action.unitId);
            if (err) return err;
            if (unit.unitType !== "worker") return fail("illegal", "Only a worker can build.");
            if (unit.movesLeft === 0) return fail("illegal", "No moves left.");
            if (!isKeyOf(IMPROVEMENT_DEFS, action.key)) return fail("illegal", "Unknown improvement.");
            if (!game.startImprovement(unit, action.key)) return fail("illegal", "Cannot build that here.");
            return done();
        }
        case "fortify":
        case "heal":
        case "skip":
        case "upgrade": {
            const [unit, err] = ownUnit(game, seat, action.unitId);
            if (err) return err;
            const method = action.type === "upgrade" ? "upgradeUnit" : action.type;
            return fromPair(game[method](unit));
        }
        case "setProduction": {
            const [city, err] = ownCity(game, seat, action.cityId);
            if (err) return err;
            if (!isItem(action.key)) return fail("illegal", "Unknown item.");
            return fromPair(game.setProduction(city, action.key));
        }
        case "buy": {
            const [city, err] = ownCity(game, seat, action.cityId);
            if (err) return err;
            if (!isItem(action.key)) return fail("illegal", "Unknown item.");
            // buyItem checks tech, resource and gold; canProduce adds "not the
            // palace" and "not already built", which the old list enforced by
            // never offering them.
            const [can, why] = game.canProduce(city, action.key);
            if (!can) return fail("illegal", why);
            return fromPair(game.buyItem(city, action.key));
        }
        case "setResearch":
            if (!isKeyOf(TECH_DEFS, action.key)) return fail("illegal", "Unknown technology.");
            return fromPair(game.setResearch(civ, action.key));
        case "endTurn":
            // Running the AI seats that follow is the server's job (rooms.js).
            game.endTurn();
            return done();
        default:
            return fail("unknown_action");
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { applyAction };
}
