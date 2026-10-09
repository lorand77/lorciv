// Headless batch simulation — equivalent to Python simulate.py
// Usage: node simulate.js [numGames]

// Hoist state.js exports as globals so game.js and ai.js can reference them
// as bare names (matching the browser <script> global scope).
Object.assign(global, require('./js/hex.js'));
Object.assign(global, require('./js/state.js'));
Object.assign(global, require('./js/mapgen.js'));
const gameExports = require('./js/game.js');
Object.assign(global, gameExports);

const { Game }       = gameExports;
const { aiTakeTurn } = require('./js/ai.js');

const NUM_GAMES  = parseInt(process.argv[2] ?? '100', 10);
const MAX_TURNS  = 2000;
const CPU_FLAGS  = [true, true, true, true];
const DIFFICULTY = ['prince', 'prince', 'prince', 'prince'];
const NAMES      = ['Rome', 'Greece', 'Huns', 'Babylon'];

const wins = [0, 0, 0, 0];
let totalTurns = 0;
let timeouts   = 0;

console.log(`Running ${NUM_GAMES} games...\n`);

for (let i = 0; i < NUM_GAMES; i++) {
    const seed = Math.floor(Math.random() * 0xFFFFFFFF);
    const game = new Game({ seed, cpuFlags: CPU_FLAGS, difficultyFlags: DIFFICULTY });

    while (game.winner === null && game.turn <= MAX_TURNS) {
        aiTakeTurn(game, game.currentCiv());
        game.endTurn();
    }

    if (game.winner !== null) {
        wins[game.winner]++;
    } else {
        timeouts++;
    }
    totalTurns += game.turn;

    process.stdout.write(`\r${i + 1}/${NUM_GAMES}`);
}

console.log('\n');
for (let i = 0; i < 4; i++) {
    const pct = ((wins[i] / NUM_GAMES) * 100).toFixed(1);
    console.log(`${NAMES[i].padEnd(10)} ${String(wins[i]).padStart(3)} wins  (${pct}%)`);
}
if (timeouts) console.log(`\nTimeouts (>${MAX_TURNS} turns): ${timeouts}`);
console.log(`\nAvg turns: ${(totalTurns / NUM_GAMES).toFixed(1)}`);
