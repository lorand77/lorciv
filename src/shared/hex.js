"use strict";

// ============================================================
// hex.js — Hex grid math. Pointy-top axial coordinates, matching the
// Python original. Shared by the server and the browser; the canvas
// renderer that used to live here is public/js/renderer.js.
// ============================================================

const HEX_SIZE = 48; // center-to-corner in pixels

// ============================================================
// Axial math
// ============================================================

function axialRound(q, r) {
    const s = -q - r;
    let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
    if (dq > dr && dq > ds)  rq = -rr - rs;
    else if (dr > ds)        rr = -rq - rs;
    return [rq, rr];
}

function hexToPixel(q, r, hexSize = HEX_SIZE) {
    return [
        hexSize * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r),
        hexSize * (3 / 2 * r),
    ];
}

function pixelToHex(px, py, hexSize = HEX_SIZE) {
    return axialRound(
        (Math.sqrt(3) / 3 * px - 1 / 3 * py) / hexSize,
        (2 / 3 * py) / hexSize,
    );
}

const HEX_DIRECTIONS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];

function hexNeighbors(q, r) {
    return HEX_DIRECTIONS.map(([dq, dr]) => [q + dq, r + dr]);
}

function hexDistance(q1, r1, q2, r2) {
    return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

function hexesInRange(q, r, radius) {
    const out = [];
    for (let dq = -radius; dq <= radius; dq++)
        for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++)
            out.push([q + dq, r + dr]);
    return out;
}

function hexLine(q1, r1, q2, r2) {
    const n = hexDistance(q1, r1, q2, r2);
    if (n === 0) return [];
    const out = [];
    for (let i = 1; i < n; i++) {
        const t = i / n;
        out.push(axialRound(q1 + (q2 - q1) * t, r1 + (r2 - r1) * t));
    }
    return out;
}

function hexCorners(cx, cy, hexSize = HEX_SIZE) {
    const corners = [];
    for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        corners.push([cx + hexSize * Math.cos(a), cy + hexSize * Math.sin(a)]);
    }
    return corners;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
    HEX_SIZE, HEX_DIRECTIONS,
    hexNeighbors, hexDistance, hexesInRange, hexLine,
    axialRound, hexToPixel, pixelToHex, hexCorners,
};
