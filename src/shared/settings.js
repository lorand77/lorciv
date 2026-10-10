"use strict";

// ============================================================
// settings.js — the allowlists the server resolves every client-sent key
// against: difficulties, turn-time presets, the action names. Shared by
// server and browser so the lobby offers exactly what the server accepts.
// Nothing else keeps a copy of these lists.
// ============================================================

// Keys of DIFFICULTY_DEFS in game.js; a test keeps the two in step.
const DIFFICULTIES = ["prince", "king", "emperor"];

// How long a human seat has for a turn before the server ends it for them.
// `ms: null` is no limit, for people who trust each other.
const TURN_TIMES = [
    { key: "none", ms: null,           label: "No limit"   },
    { key: "1m",   ms: 60 * 1000,      label: "1 minute"   },
    { key: "3m",   ms: 3 * 60 * 1000,  label: "3 minutes"  },
    { key: "10m",  ms: 10 * 60 * 1000, label: "10 minutes" },
    { key: "1h",   ms: 60 * 60 * 1000, label: "1 hour"     },
    { key: "1d",   ms: 24 * 3600 * 1000,     label: "1 day"  },
    { key: "3d",   ms: 3 * 24 * 3600 * 1000, label: "3 days" },
];
const DEFAULT_TURN_TIME = "3m";

// Consecutive expired turns after which a seat is handed to the AI.
const MISSED_TURN_LIMIT = 3;

// The engine always runs four civs; empty seats are AI seats.
const SEATS = 4;

// Everything a player can ask the engine to do (actions.js). `leave`, handing
// one's seat to the AI, is a seat matter for the server and not in this list.
const ACTION_TYPES = [
    "move", "attack", "foundCity", "buildImprovement",
    "fortify", "heal", "skip", "upgrade",
    "setProduction", "buy", "setResearch", "endTurn",
];

function turnTimeOf(key) {
    return TURN_TIMES.find(t => t.key === key) ?? null;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        DIFFICULTIES, TURN_TIMES, DEFAULT_TURN_TIME, MISSED_TURN_LIMIT, SEATS, ACTION_TYPES, turnTimeOf,
    };
}
