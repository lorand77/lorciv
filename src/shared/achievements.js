"use strict";

// ============================================================
// achievements.js — the achievement catalogue: what exists, what it is
// called and what it takes. Shared by the server, which decides what was
// earned (src/achievements/), and the profile's Achievements tab, which
// shows it. Nothing here is trusted from a client: the browser only reads
// it for names and descriptions.
//
// Fields:
//   key    stable id, stored in user_achievements.key
//   name   display name
//   icon   an emoji
//   group  a key of ACHIEVEMENT_GROUPS
//   desc   description; {n} is the threshold (`n`, or the tier's)
//   n      the threshold of a one-shot achievement that has one; the server
//          checks against this same number
//   tiers  thresholds of a tiered achievement (Bronze, Silver, Gold)
//   seat   for a civ's own achievement, the seat that civ plays (seat i is
//          always PLAYER_NAMES[i]: Rome, Greece, the Huns, Babylon)
// ============================================================

const TIER_NAMES = ["Bronze", "Silver", "Gold"];

const ACHIEVEMENT_GROUPS = [
    { key: "victory",    title: "Victory" },
    { key: "conquest",   title: "Conquest" },
    { key: "empire",     title: "Empire" },
    { key: "civs",       title: "Civilizations" },
    { key: "milestones", title: "Milestones" },
];

const ACHIEVEMENTS = [
    // ---- victory ----
    { key: "first_blood", name: "First Blood", icon: "🗡️", group: "victory",
      desc: "Win a game." },
    // Alone against the AI: every other seat an AI, the easiest of them at
    // least this level (settings.DIFFICULTIES).
    { key: "princely_victory", name: "Princely Victory", icon: "🤴", group: "victory", difficulty: "prince",
      desc: "Win a game alone against the AI." },
    { key: "royal_victory", name: "Royal Victory", icon: "👑", group: "victory", difficulty: "king",
      desc: "Win a game alone against the AI, every AI at King or harder." },
    { key: "imperial_victory", name: "Imperial Victory", icon: "🏛️", group: "victory", difficulty: "emperor",
      desc: "Win a game alone against the AI, every AI at Emperor." },
    { key: "world_conqueror", name: "World Conqueror", icon: "🌍", group: "victory",
      desc: "Win a game with three other people at the table." },
    { key: "blitz", name: "Blitz", icon: "⚡", group: "victory", n: 150,
      desc: "Win a game by turn {n}." },
    { key: "flawless", name: "Flawless", icon: "💎", group: "victory",
      desc: "Win a game without ever losing a city." },
    { key: "comeback", name: "Comeback", icon: "🔄", group: "victory",
      desc: "Win a game after losing your capital." },
    { key: "four_banners", name: "Four Banners", icon: "🚩", group: "victory",
      desc: "Win a game as each of the four civilizations." },
    { key: "hat_trick", name: "Hat Trick", icon: "🎩", group: "victory", n: 3,
      desc: "Win {n} games in a row." },

    // ---- conquest ----
    { key: "capital_punishment", name: "Capital Punishment", icon: "⚔️", group: "conquest",
      desc: "Take another civilization's original capital." },
    { key: "kingslayer", name: "Kingslayer", icon: "💀", group: "conquest",
      desc: "Take a civilization's last city." },
    { key: "fortress", name: "Fortress", icon: "🏰", group: "conquest", n: 5,
      desc: "Hold a city with Walls and a Castle through {n} attacks." },
    { key: "upgrade_path", name: "Upgrade Path", icon: "⚙️", group: "conquest",
      units: ["longswordsman", "knight", "crossbowman", "trebuchet"],
      desc: "Field a Longswordsman, a Knight, a Crossbowman and a Trebuchet at the same time." },
    { key: "underdog", name: "Underdog", icon: "🐕", group: "conquest",
      units: ["warrior", "archer"],
      desc: "Destroy a medieval unit with a Warrior or an Archer." },

    // ---- empire ----
    { key: "founder", name: "Founder", icon: "🏘️", group: "empire", n: 5,
      desc: "Found {n} cities in one game." },
    { key: "scholar", name: "Scholar", icon: "📚", group: "empire",
      desc: "Research every technology in one game." },
    { key: "golden_age", name: "Golden Age", icon: "🌟", group: "empire",
      desc: "Have every kind of building standing in your empire at once." },
    { key: "treasure_hunter", name: "Treasure Hunter", icon: "💰", group: "empire",
      resources: ["gold", "silver", "diamonds"],
      desc: "Hold Gold, Silver and Diamonds within your borders at once." },
    { key: "iron_and_horses", name: "Iron and Horses", icon: "🐎", group: "empire", n: 75,
      resources: ["iron", "horses"],
      desc: "Hold Iron and Horses within your borders by turn {n}." },
    { key: "metropolis", name: "Metropolis", icon: "🏙️", group: "empire", n: 20,
      desc: "Grow a city to size {n}." },

    // ---- civilizations: one civ's own, with a nod to its history ----
    { key: "veni_vidi_vici", name: "Veni, Vidi, Vici", icon: "🦅", group: "civs", seat: 0, n: 3,
      desc: "As Rome, capture {n} cities in a single turn." },
    { key: "greeks_bearing_gifts", name: "Beware of Greeks Bearing Gifts", icon: "🐴", group: "civs", seat: 1,
      units: ["horseman"], building: "walls",
      desc: "As Greece, take a city with Walls using a Horseman." },
    { key: "brute_force", name: "Brute Force", icon: "🧠", group: "civs", seat: 2,
      desc: "As the Huns, research every technology before anyone else does." },
    { key: "eye_for_an_eye", name: "An Eye for an Eye", icon: "👁️", group: "civs", seat: 3,
      desc: "As Babylon, take a city from the civ that just took one of yours, on your very next turn." },

    // ---- milestones (tiered) ----
    { key: "games_played", name: "Veteran", icon: "📜", group: "milestones",
      tiers: [10, 50, 100], desc: "Play {n} games." },
    { key: "wins", name: "Victorious", icon: "🏆", group: "milestones",
      tiers: [5, 25, 100], desc: "Win {n} games." },
    { key: "cities_captured", name: "Conqueror", icon: "🏴", group: "milestones",
      tiers: [10, 50, 200], desc: "Capture {n} cities." },
];

const ACHIEVEMENTS_BY_KEY = {};
for (const a of ACHIEVEMENTS) ACHIEVEMENTS_BY_KEY[a.key] = a;

function maxTier(a) {
    return a.tiers ? a.tiers.length : 1;
}

// The description of one tier of an achievement (a one-shot has only tier 1).
function describeAchievement(a, tier = 1) {
    const t = Math.max(1, Math.min(tier, maxTier(a)));
    const n = a.tiers ? a.tiers[t - 1] : a.n;
    return a.desc.replace("{n}", String(n));
}

// "Gold" and so on for a tiered achievement; null for a one-shot.
function tierName(a, tier) {
    if (!a.tiers) return null;
    return TIER_NAMES[Math.max(1, Math.min(tier, a.tiers.length)) - 1];
}

// The highest tier `value` reaches, 0 for none.
function tierFor(a, value) {
    if (!a.tiers) return value ? 1 : 0;
    let t = 0;
    for (let i = 0; i < a.tiers.length; i++) if (value >= a.tiers[i]) t = i + 1;
    return t;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        ACHIEVEMENTS, ACHIEVEMENT_GROUPS, ACHIEVEMENTS_BY_KEY, TIER_NAMES,
        maxTier, describeAchievement, tierName, tierFor,
    };
}
