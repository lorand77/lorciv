// ============================================================
// mapgen.js — Map generation, ported from generator.py
// ============================================================

// --- Tile definition (mirrors Python Tile dataclass) ---
function makeTile(q, r, terrain, resource = null) {
    return {
        q, r, terrain,
        resource,
        improvement: null,
        improvement_turns_left: 0,
        city: null,
        unit: null,
        civilian: null,
        owner: null,
    };
}

// --- Seeded PRNG (mulberry32) — replaces numpy.random ---
function makePRNG(seed) {
    let s = seed >>> 0;
    return {
        // Returns float in [0, 1)
        random() {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
        // Returns random integer in [0, n)
        randInt(n) {
            return Math.floor(this.random() * n);
        },
        // Choose `count` unique indices from [0, len) without replacement
        choice(len, count) {
            count = Math.min(count, len);
            const indices = Array.from({ length: len }, (_, i) => i);
            // Fisher-Yates partial shuffle
            for (let i = 0; i < count; i++) {
                const j = i + Math.floor(this.random() * (len - i));
                [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            return indices.slice(0, count);
        },
    };
}

// --- Box blur — mirrors _box_blur(arr, passes) ---
// arr is a flat Float32Array of length rows*cols.
function boxBlur(arr, rows, cols, passes = 2) {
    let src = arr.slice();
    const dst = new Float32Array(rows * cols);

    for (let p = 0; p < passes; p++) {
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                let sum = 0, count = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const nr = Math.max(0, Math.min(rows - 1, row + dr));
                        const nc = Math.max(0, Math.min(cols - 1, col + dc));
                        sum += src[nr * cols + nc];
                        count++;
                    }
                }
                dst[row * cols + col] = sum / count;
            }
        }
        src = dst.slice();
    }
    return dst;
}

// --- offset_to_axial — mirrors Python offset_to_axial ---
function offsetToAxial(col, row) {
    const q = col - Math.floor((row - (row & 1)) / 2);
    const r = row;
    return [q, r];
}

// --- Main generator ---
// Returns { tiles: Map<'q,r', tile>, cols, rows }
function generateMap(cols = 32, rows = 24, seed = 42) {
    const rng = makePRNG(seed);

    // --- Elevation noise ---
    const noise = new Float32Array(rows * cols);
    for (let i = 0; i < noise.length; i++) noise[i] = rng.random();

    const elev = boxBlur(noise, rows, cols, 2);

    // --- Edge penalty (mirrors Python edge_penalty logic) ---
    for (let row = 0; row < rows; row++) {
        const edgeR = 1.0 - Math.min(1.0, Math.min(row, rows - 1 - row) / (rows * 0.18));
        for (let col = 0; col < cols; col++) {
            const edgeC = 1.0 - Math.min(1.0, Math.min(col, cols - 1 - col) / (cols * 0.12));
            const penalty = Math.max(edgeR, edgeC) * 0.75;
            elev[row * cols + col] = Math.max(0, Math.min(1, elev[row * cols + col] - penalty));
        }
    }

    // --- Assign terrain ---
    const tiles = new Map();
    const terrainGrid = new Map(); // 'col,row' → terrain

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const e = elev[row * cols + col];
            let terrain;

            if (row === 0 || row === rows - 1 || col === 0 || col === cols - 1) {
                terrain = 'ocean';
            } else if (e > 0.54) {
                terrain = 'hills';
            } else if (e > 0.46) {
                terrain = 'forest';
            } else if (e > 0.16) {
                terrain = rng.random() < 0.4 ? 'plains' : 'grassland';
            } else {
                terrain = 'ocean';
            }

            const [q, r] = offsetToAxial(col, row);
            tiles.set(`${q},${r}`, makeTile(q, r, terrain));
            terrainGrid.set(`${col},${row}`, terrain);
        }
    }

    // --- Place resources ---
    _placeResources(tiles, terrainGrid, cols, rows, rng);

    return { tiles, cols, rows };
}

// --- Resource placement — mirrors _place_resources ---
// (RESOURCES definition lives in state.js; _placeResources only needs the name strings below)
function _placeResources(tiles, terrainGrid, cols, rows, rng) {
    const hillsPos    = [], plainsPos = [], grassPos = [], forestPos = [];

    terrainGrid.forEach((terrain, key) => {
        const [col, row] = key.split(',').map(Number);
        if (terrain === 'hills')     hillsPos.push([col, row]);
        if (terrain === 'plains')    plainsPos.push([col, row]);
        if (terrain === 'grassland') grassPos.push([col, row]);
        if (terrain === 'forest')    forestPos.push([col, row]);
    });

    const plainsGrass = [...plainsPos, ...grassPos];
    const forestHills = [...forestPos, ...hillsPos];

    function place(positions, resource, count) {
        if (!positions.length) return;
        const chosen = rng.choice(positions.length, count);
        for (const idx of chosen) {
            const [col, row] = positions[idx];
            const [q, r] = offsetToAxial(col, row);
            const key = `${q},${r}`;
            const tile = tiles.get(key);
            if (tile && tile.resource === null) tile.resource = resource;
        }
    }

    place(hillsPos,    'iron',     8);
    place(plainsGrass, 'horses',   6);
    place(plainsGrass, 'gold',     6);
    place(hillsPos,    'silver',   8);
    place(forestHills, 'diamonds', 3);
}

if (typeof module !== 'undefined') module.exports = { generateMap, makePRNG, makeTile, offsetToAxial };
