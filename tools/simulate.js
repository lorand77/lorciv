"use strict";

// Headless batch simulation: AI-only games, win rates by seat and by AI
// flavor. Each seat is a place in the turn order (seat 1 moves first) and, on a
// given map, a start; it plays a civ's AI flavor. The civs differ only in that
// flavor, so the seatings below tell the flavor's strength from the seat's.
// Run by hand, never by the app:
//
//   node tools/simulate.js [--games N] [--seed S] [--seats MODE] [--jobs J]
//
//   --games  how many games (100)
//   --seed   the first seed; maps take S, S+1, ... so a run is repeatable
//            and runs with one seed play the same maps (random if left out)
//   --seats  fixed        each seat plays its own civ's flavor, as in a real game
//            rotate       each map is played 4 times, the flavors moved one seat
//                         along each time: every flavor plays every seat and
//                         start equally often, so the seat's edge cancels out
//                         of the flavors' win rates (--games a multiple of 4)
//            mirror:CIV   one civ's flavor in every seat (rome, greece, huns,
//                         babylon): what is left is the seat's edge
//   --jobs   worker threads, one game each at a time (one per core). A game's
//            result depends only on its seed and seating, never on this.

const os = require("node:os");
const { parseArgs } = require("node:util");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const { Game, PLAYER_NAMES } = require("../src/shared/game");
const { runCpuTurns } = require("../src/shared/ai");

const MAX_TURNS = 2000;
const SEATS     = PLAYER_NAMES.length;
const OWN       = PLAYER_NAMES.map((_, i) => i);

if (isMainThread) {
    main().catch((err) => { console.error(err); process.exit(1); });
} else {
    parentPort.on("message", ({ id, seed, flavorBySeat }) => {
        const started = performance.now();
        const game = new Game({ seed, cpuFlags: Array(SEATS).fill(true) });
        runCpuTurns(game, MAX_TURNS, flavorBySeat);
        parentPort.postMessage({ id, winner: game.winner, turns: game.turn, ms: performance.now() - started });
    });
}

async function main() {
    const opts = parseOptions();
    const games = Array.from({ length: opts.games }, (_, i) =>
        ({ id: i, seed: (opts.seed + opts.seating.mapOf(i)) >>> 0, flavorBySeat: opts.seating.flavorBySeat(i) }));

    console.log(`${opts.games} games, seats ${opts.seating.label}, first seed ${opts.seed}, ${opts.jobs} jobs\n`);
    const started = Date.now();
    const results = await play(games, opts.jobs);
    report(games, results, (Date.now() - started) / 1000);
}

function parseOptions() {
    const { values } = parseArgs({ options: {
        games: { type: "string", default: "100" },
        seed:  { type: "string" },
        seats: { type: "string", default: "fixed" },
        jobs:  { type: "string", default: String(os.availableParallelism()) },
    } });
    const games = toInt(values.games, "--games", 1);
    return {
        games,
        seed:    values.seed === undefined ? Math.floor(Math.random() * 0x100000000) : toInt(values.seed, "--seed", 0),
        seating: parseSeats(values.seats, games),
        jobs:    Math.min(toInt(values.jobs, "--jobs", 1), games),
    };
}

function toInt(text, flag, min) {
    const n = Number(text);
    if (!Number.isInteger(n) || n < min) usage(`${flag} wants a whole number from ${min}, not "${text}"`);
    return n;
}

// A seating says which map game i is on (0 for the first seed) and which civ's
// flavor plays each seat.
function parseSeats(text, games) {
    if (text === "fixed") return { label: "fixed", mapOf: (i) => i, flavorBySeat: () => OWN };
    if (text === "rotate") {
        if (games % SEATS) usage(`--seats rotate plays each map ${SEATS} times: --games must be a multiple of ${SEATS}`);
        return {
            label:        `rotate (${games / SEATS} maps, each played ${SEATS} times)`,
            mapOf:        (i) => Math.floor(i / SEATS),
            flavorBySeat: (i) => OWN.map((seat) => (seat - i % SEATS + SEATS) % SEATS),
        };
    }
    const mirror = /^mirror:(.+)$/.exec(text);
    if (mirror) {
        const civ = PLAYER_NAMES.findIndex((name) => shortName(name) === mirror[1].toLowerCase());
        if (civ === -1) usage(`no civ "${mirror[1]}"; one of ${PLAYER_NAMES.map(shortName).join(", ")}`);
        const all = Array(SEATS).fill(civ);
        return { label: `mirror:${shortName(PLAYER_NAMES[civ])}`, mapOf: (i) => i, flavorBySeat: () => all };
    }
    usage(`--seats is fixed, rotate or mirror:CIV, not "${text}"`);
}

function shortName(name) {
    return name.toLowerCase().replace(/^the /, "");
}

function usage(problem) {
    console.error(`${problem}\nusage: node tools/simulate.js [--games N] [--seed S] [--seats fixed|rotate|mirror:CIV] [--jobs J]`);
    process.exit(1);
}

// Games go out one at a time to whichever worker is free, since their lengths
// differ by hundreds of turns.
function play(games, jobs) {
    const results = new Array(games.length);
    let next = 0;
    let done = 0;
    return new Promise((resolve, reject) => {
        for (let w = 0; w < jobs; w++) {
            const worker = new Worker(__filename);
            const feed = () => {
                if (next < games.length) worker.postMessage(games[next++]);
                else worker.terminate();
            };
            worker.on("error", reject);
            worker.on("message", (result) => {
                results[result.id] = result;
                if (process.stderr.isTTY) process.stderr.write(`\r${++done}/${games.length}`);
                else done++;
                if (done === games.length) {
                    if (process.stderr.isTTY) process.stderr.write("\n\n");
                    resolve(results);
                }
                feed();
            });
            feed();
        }
    });
}

function report(games, results, seconds) {
    const n = games.length;
    const grid = () => Array.from({ length: SEATS }, () => Array(SEATS).fill(0));
    const seatWins   = Array(SEATS).fill(0);
    const flavorWins = Array(SEATS).fill(0);
    const cellWins   = grid();  // [flavor][seat]
    const cellGames  = grid();
    let timeouts = 0;
    let turns = 0;
    let ms = 0;
    for (const r of results) {
        const flavorBySeat = games[r.id].flavorBySeat;
        flavorBySeat.forEach((flavor, seat) => cellGames[flavor][seat]++);
        if (r.winner === null) timeouts++;
        else {
            seatWins[r.winner]++;
            flavorWins[flavorBySeat[r.winner]]++;
            cellWins[flavorBySeat[r.winner]][r.winner]++;
        }
        turns += r.turns;
        ms += r.ms;
    }

    // A seat's flavor is named only when it is the same in every game.
    const sameFlavor = (seat) => games.every((g) => g.flavorBySeat[seat] === games[0].flavorBySeat[seat]);
    console.log("Wins by seat (seat 1 moves first)");
    for (let s = 0; s < SEATS; s++) {
        const flavor = sameFlavor(s) ? PLAYER_NAMES[games[0].flavorBySeat[s]] : "";
        console.log(`  Seat ${s + 1}  ${flavor.padEnd(10)} ${String(seatWins[s]).padStart(5)}  ${share(seatWins[s], n)}`);
    }

    // Only where the flavors move between seats; otherwise the table above is it.
    if (!OWN.every(sameFlavor)) {
        console.log("\nWins by flavor");
        for (let f = 0; f < SEATS; f++)
            console.log(`  ${PLAYER_NAMES[f].padEnd(10)} ${String(flavorWins[f]).padStart(5)}  ${share(flavorWins[f], n)}`);
        console.log("\nWin % by flavor and seat");
        console.log(`  ${"".padEnd(10)} ${OWN.map((s) => `Seat ${s + 1}`.padEnd(13)).join(" ")}`);
        for (let f = 0; f < SEATS; f++)
            console.log(`  ${PLAYER_NAMES[f].padEnd(10)} ${OWN.map((s) => share(cellWins[f][s], cellGames[f][s]).padEnd(13)).join(" ")}`);
    }

    if (timeouts) console.log(`\nNo winner by turn ${MAX_TURNS}: ${timeouts}`);
    console.log(`\n± is the 95% margin: a gap smaller than the two margins together may be chance.`);
    console.log(`Avg turns ${(turns / n).toFixed(1)}; ${(ms / n / 1000).toFixed(1)} s a game on one core; ` +
                `${seconds.toFixed(1)} s in all`);
}

// Win share in percent with its 95% margin (normal approximation).
function share(wins, games) {
    const p = wins / games;
    const margin = 1.96 * Math.sqrt(p * (1 - p) / games);
    return `${(p * 100).toFixed(1).padStart(5)}% ± ${(margin * 100).toFixed(1)}`;
}
