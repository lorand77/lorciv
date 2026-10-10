"use strict";

// Headless batch simulation: N AI-only games, win counts and average length.
// Run by hand, never by the app:   node tools/simulate.js [numGames] [firstSeed]
// A fixed first seed makes a run repeatable; games take seeds firstSeed, +1, ...

const { Game, PLAYER_NAMES } = require("../src/shared/game");
const { runCpuTurns } = require("../src/shared/ai");

const NUM_GAMES  = parseInt(process.argv[2] ?? "100", 10);
const FIRST_SEED = parseInt(process.argv[3] ?? String(Math.floor(Math.random() * 0xFFFFFFFF)), 10);
const MAX_TURNS  = 2000;

const wins = [0, 0, 0, 0];
let totalTurns = 0;
let timeouts   = 0;

console.log(`Running ${NUM_GAMES} games from seed ${FIRST_SEED}...\n`);
const started = Date.now();

for (let i = 0; i < NUM_GAMES; i++) {
    const game = new Game({ seed: (FIRST_SEED + i) >>> 0, cpuFlags: [true, true, true, true] });
    runCpuTurns(game, MAX_TURNS);
    if (game.winner !== null) wins[game.winner]++;
    else timeouts++;
    totalTurns += game.turn;
    process.stdout.write(`\r${i + 1}/${NUM_GAMES}`);
}

console.log("\n");
for (let i = 0; i < 4; i++) {
    const pct = ((wins[i] / NUM_GAMES) * 100).toFixed(1);
    console.log(`${PLAYER_NAMES[i].padEnd(10)} ${String(wins[i]).padStart(3)} wins  (${pct}%)`);
}
if (timeouts) console.log(`\nTimeouts (>${MAX_TURNS} turns): ${timeouts}`);
console.log(`\nAvg turns: ${(totalTurns / NUM_GAMES).toFixed(1)}   (${((Date.now() - started) / 1000).toFixed(1)} s)`);
