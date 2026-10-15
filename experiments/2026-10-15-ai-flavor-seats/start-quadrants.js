"use strict";

// Which quadrant each seat starts in over a range of seeds, with a chi-square
// test of independence (df 9): is start placement biased by seat? Run from
// the repo root: node experiments/2026-10-15-ai-flavor-seats/start-quadrants.js FROM TO
const { Game } = require("../../src/shared/game");
const [from, to] = process.argv.slice(2).map(Number);
const quadOf = (g, q, r) => {
    const col = q + Math.floor((r - (r & 1)) / 2);
    return (r < Math.floor(g.rows / 2) ? 0 : 2) + (col < Math.floor(g.cols / 2) ? 0 : 1);
};
const counts = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
for (let seed = from; seed <= to; seed++) {
    const g = new Game({ seed, cpuFlags: [true, true, true, true] });
    g.civs.forEach((c, seat) => {
        const s = c.units.find((u) => u.unitType === "settler");
        counts[seat][quadOf(g, s.q, s.r)]++;
    });
}
const n = to - from + 1, e = n / 4;
let chi = 0;
for (const row of counts) for (const x of row) chi += (x - e) ** 2 / e;
console.log(`seeds ${from}-${to}: chi2 ${chi.toFixed(1)} (df 9; 5% critical 16.9, 0.1% critical 27.9)`);
counts.forEach((row, seat) => console.log(`  seat ${seat + 1}: ${row.map((x) => (100 * x / n).toFixed(1).padStart(5)).join(" ")}  % TL TR BL BR`));
