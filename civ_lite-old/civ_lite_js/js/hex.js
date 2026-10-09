// ============================================================
// hex.js — Hex grid math + canvas renderer
// Pointy-top axial coordinate system, matching civ_lite_py.
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

// ============================================================
// Color constants
// ============================================================

const TERRAIN_COLORS = {
    grassland: '#6aa84f', plains: '#b6d7a8', hills: '#996633',
    forest: '#274f13', ocean: '#1e5ab4',
};
const TERRAIN_STROKE = {
    grassland: '#4a8a33', plains: '#90ba88', hills: '#7a4f22',
    forest: '#1a380d', ocean: '#163f8a',
};
const RESOURCE_COLORS = {
    iron: '#a0a0a0', horses: '#c8a064', gold: '#ffd700',
    silver: '#c0c0c0', diamonds: '#b4e6ff',
};
const IMPROVEMENT_LABELS = { farm: 'F', mine: 'M', pasture: 'P' };

// Parse "#rrggbb" → "r,g,b" for use in rgba()
function _rgb(hex) {
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
    ].join(',');
}

// ============================================================
// HexRenderer
// ============================================================

class HexRenderer {
    constructor(canvas, civColors = []) {
        this.canvas    = canvas;
        this.ctx       = canvas.getContext('2d');
        this.civColors = civColors; // array of CSS hex strings by player index

        this.offsetX = 0;
        this.offsetY = 0;
        this.scale   = 1.0;

        this.tiles = new Map();

        // Overlay state (set via setOverlays)
        this._reachable  = new Set(); // Set<'q,r'>
        this._attackable = new Set(); // Set<'q,r'>
        this._selected   = null;      // 'q,r' | null

        // Callbacks set by caller
        this.onClick    = null; // (tile | null, MouseEvent) => void
        this.onHover    = null; // (tile | null, MouseEvent) => void

        // Terrain / resource images
        this._terrainImgs  = {};
        this._resourceImgs = {};
        this._imgsReady    = false;
        this._loadImages();

        // Set of tech keys the current player has researched (null = show all)
        this.knownTechs = null;

        this._bindEvents();
        this._centerView();
    }

    // ---- Image loading ----

    _loadImages() {
        const terrains = ['grassland', 'plains', 'hills', 'forest', 'ocean'];
        const resMap   = { iron: 'Iron', horses: 'Horses', gold: 'Gold', silver: 'Silver', diamonds: 'Diamonds' };
        let pending = terrains.length + Object.keys(resMap).length;
        const done = () => { if (--pending === 0) { this._imgsReady = true; this.draw(); } };
        for (const t of terrains) {
            const img = new Image();
            img.onload = img.onerror = done;
            img.src = `assets/terrain-${t}.png`;
            this._terrainImgs[t] = img;
        }
        for (const [r, fname] of Object.entries(resMap)) {
            const img = new Image();
            img.onload = img.onerror = done;
            img.src = `assets/resource-${fname}.png`;
            this._resourceImgs[r] = img;
        }
    }

    // ---- Public API ----

    loadTiles(tiles) {
        this.tiles = tiles;
        this._centerView();
        this.draw();
    }

    setOverlays({ reachable = null, attackable = null, selected = null } = {}) {
        this._reachable  = reachable instanceof Map
            ? new Set(reachable.keys())
            : (reachable ?? new Set());
        this._attackable = attackable ?? new Set();
        this._selected   = selected ?? null;
    }

    clearOverlays() { this.setOverlays({}); }

    // Returns tile under screen coordinate, or null
    hexAtScreen(sx, sy) {
        const [wx, wy] = this._screenToWorld(sx, sy);
        const [q, r]   = pixelToHex(wx, wy, HEX_SIZE);
        return this.tiles.get(`${q},${r}`) ?? null;
    }

    // ---- Coordinate transforms ----

    _worldToScreen(wx, wy) {
        return [wx * this.scale + this.offsetX, wy * this.scale + this.offsetY];
    }
    _screenToWorld(sx, sy) {
        return [(sx - this.offsetX) / this.scale, (sy - this.offsetY) / this.scale];
    }
    _centerView() {
        this.offsetX = this.canvas.clientWidth  / 2;
        this.offsetY = this.canvas.clientHeight / 2;
    }

    // ---- Draw ----

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, W, H);

        const hs = HEX_SIZE * this.scale; // screen hex size
        const cull = (sx, sy) =>
            sx < -hs * 2 || sx > W + hs * 2 || sy < -hs * 2 || sy > H + hs * 2;

        // ---- Pass 1: terrain + territory + highlights + resources + improvements ----
        for (const tile of this.tiles.values()) {
            const [wx, wy] = hexToPixel(tile.q, tile.r, HEX_SIZE);
            const [sx, sy] = this._worldToScreen(wx, wy);
            if (cull(sx, sy)) continue;

            // Terrain — image if loaded, fallback to solid color
            const tImg = this._terrainImgs[tile.terrain];
            if (tImg && tImg.complete && tImg.naturalWidth > 0) {
                this._fillHexImage(sx, sy, hs, tImg);
            } else {
                this._fillHex(sx, sy, hs, TERRAIN_COLORS[tile.terrain] ?? '#888');
            }
            // Thin separator stroke between tiles
            this._strokeHex(sx, sy, hs, 'rgba(0,0,0,0.22)', Math.max(0.5, hs * 0.02));

            // Movement / attack highlight
            const key = `${tile.q},${tile.r}`;
            if (key === this._selected) {
                this._strokeHex(sx, sy, hs, 'rgba(255,230,0,0.9)', Math.max(2, hs * 0.06));
                this._fillHex(sx, sy, hs, 'rgba(255,230,0,0.12)');
            } else if (this._reachable.has(key)) {
                this._fillHex(sx, sy, hs, 'rgba(80,200,80,0.30)');
                this._strokeHex(sx, sy, hs, 'rgba(80,200,80,0.7)', Math.max(1, hs * 0.04));
            } else if (this._attackable.has(key)) {
                this._fillHex(sx, sy, hs, 'rgba(220,60,60,0.30)');
                this._strokeHex(sx, sy, hs, 'rgba(220,60,60,0.7)', Math.max(1, hs * 0.04));
            }

            // Resource icon (skip if a city covers it, or tech not yet researched)
            const _resReq = tile.resource && RESOURCES[tile.resource]?.requires_tech;
            const _resVisible = tile.resource && !tile.city &&
                (!_resReq || !this.knownTechs || this.knownTechs.has(_resReq));
            if (_resVisible) {
                const rImg = this._resourceImgs[tile.resource];
                if (rImg && rImg.complete && rImg.naturalWidth > 0) {
                    const size = Math.max(8, hs * 0.35);
                    this.ctx.drawImage(rImg, sx + hs * 0.38 - size / 2, sy - hs * 0.42 - size / 2, size, size);
                } else if (RESOURCE_COLORS[tile.resource]) {
                    this._drawDot(sx, sy - hs * 0.15, Math.max(3, hs * 0.13),
                                  RESOURCE_COLORS[tile.resource]);
                }
            }

            // Improvement label (bottom of hex)
            if (tile.improvement && IMPROVEMENT_LABELS[tile.improvement] && hs > 16) {
                ctx.font      = `bold ${Math.max(8, hs * 0.22)}px sans-serif`;
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(IMPROVEMENT_LABELS[tile.improvement], sx, sy + hs * 0.55);
            }
        }

        // ---- Pass 1.5: territory border lines in civ color ----
        this._drawTerritoryBorders(hs);

        // ---- Pass 2: cities and units (always on top) ----
        for (const tile of this.tiles.values()) {
            const [wx, wy] = hexToPixel(tile.q, tile.r, HEX_SIZE);
            const [sx, sy] = this._worldToScreen(wx, wy);
            if (cull(sx, sy)) continue;

            if (tile.city)     this._drawCity(sx, sy, hs, tile.city);
            if (tile.unit)     this._drawUnit(sx, sy, hs, tile.unit, false);
            if (tile.civilian) this._drawUnit(sx, sy, hs, tile.civilian, true);
        }
    }

    // ---- Draw helpers ----

    _hexPath(cx, cy, hs) {
        const c = hexCorners(cx, cy, hs);
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < 6; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.closePath();
    }

    _fillHex(cx, cy, hs, color) {
        this._hexPath(cx, cy, hs);
        this.ctx.fillStyle = color;
        this.ctx.fill();
    }

    _strokeHex(cx, cy, hs, color, lw) {
        this._hexPath(cx, cy, hs);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth   = lw;
        this.ctx.stroke();
    }

    _fillHexImage(cx, cy, hs, img) {
        const ctx = this.ctx;
        ctx.save();
        this._hexPath(cx, cy, hs);
        ctx.clip();
        const size = hs * 2.05;
        ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
        ctx.restore();
    }

    _drawTerritoryBorders(hs) {
        // Edge i (corner i → corner i+1) is shared with the neighbor in this direction index:
        const EDGE_DIR = [0, 5, 4, 3, 2, 1];

        const ctx = this.ctx;
        const lw  = Math.max(2, hs * 0.07);
        ctx.lineCap = 'round';

        for (const tile of this.tiles.values()) {
            if (tile.owner === null) continue;
            const color = this.civColors[tile.owner];
            if (!color) continue;

            const [wx, wy] = hexToPixel(tile.q, tile.r, HEX_SIZE);
            const [sx, sy] = this._worldToScreen(wx, wy);
            if (sx < -hs * 3 || sx > this.canvas.width  + hs * 3 ||
                sy < -hs * 3 || sy > this.canvas.height + hs * 3) continue;

            const corners = hexCorners(sx, sy, hs);
            ctx.strokeStyle = color;
            ctx.lineWidth   = lw;

            for (let i = 0; i < 6; i++) {
                const [dq, dr] = HEX_DIRECTIONS[EDGE_DIR[i]];
                const nb = this.tiles.get(`${tile.q + dq},${tile.r + dr}`);
                if (nb && nb.owner === tile.owner) continue; // same civ — no border
                const c0 = corners[i];
                const c1 = corners[(i + 1) % 6];
                ctx.beginPath();
                ctx.moveTo(c0[0], c0[1]);
                ctx.lineTo(c1[0], c1[1]);
                ctx.stroke();
            }
        }
    }

    _drawDot(cx, cy, r, fill) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle   = fill;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth   = Math.max(0.5, r * 0.25);
        ctx.stroke();
    }

    _drawHpBar(ctx, cx, cy, hs, hp, hpMax, r = null) {
        const w   = hs * 0.9, h = Math.max(2, hs * 0.07);
        const x   = cx - w / 2;
        const y   = r !== null ? cy + r + 3 : cy + hs * 0.52;
        const pct = hp / hpMax;
        const color = pct > 0.6 ? '#4c4' : pct > 0.3 ? '#cc4' : '#c44';
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w * pct, h);
    }

    _drawCity(cx, cy, hs, city) {
        const ctx   = this.ctx;
        const color = this.civColors[city.owner] ?? '#888';
        const r     = Math.max(8, Math.floor(hs / 3));

        // Circle
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle   = color;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 2;
        ctx.stroke();

        // Gold ring for original capital
        if (city.isOriginalCapital) {
            ctx.beginPath();
            ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth   = 2;
            ctx.stroke();
        }

        // Population number centered on circle
        const fs = Math.max(8, Math.floor(hs * 0.25));
        ctx.font         = `bold ${fs}px sans-serif`;
        ctx.fillStyle    = '#fff';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(city.population), cx, cy);

        // HP bar just below circle
        if (city.hp < 50) this._drawHpBar(ctx, cx, cy, hs, city.hp, 50, r);

        // City name above circle
        if (hs > 18) {
            const namefs = Math.max(7, Math.floor(hs * 0.2));
            ctx.font         = `bold ${namefs}px sans-serif`;
            ctx.fillStyle    = '#fff';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'bottom';
            const maxW = hs * 2.2;
            let label = city.name;
            while (label.length > 1 && ctx.measureText(label).width > maxW)
                label = label.slice(0, -1);
            if (label !== city.name) label = label.trimEnd() + '…';
            ctx.fillText(label, cx, cy - r - 3);
        }
    }

    _drawUnit(cx, cy, hs, unit, isCivilian) {
        const ctx   = this.ctx;
        const color = this.civColors[unit.owner] ?? '#888';
        const r     = hs * 0.33;
        const noMoves = unit.movesLeft === 0;

        // Circle
        ctx.beginPath();
        ctx.arc(cx, cy - hs * 0.04, r, 0, Math.PI * 2);
        ctx.fillStyle   = noMoves ? `rgba(${_rgb(color)},0.5)` : color;
        ctx.fill();
        ctx.strokeStyle = noMoves ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.6)';
        ctx.lineWidth   = Math.max(1, hs * 0.04);
        ctx.stroke();

        // Fortify indicator: inner ring
        if (unit.fortified) {
            ctx.beginPath();
            ctx.arc(cx, cy - hs * 0.04, r * 0.7, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth   = Math.max(1, hs * 0.03);
            ctx.stroke();
        }

        // Unit label
        if (hs > 14) {
            const fs = Math.max(6, hs * 0.22);
            ctx.font         = `bold ${fs}px sans-serif`;
            ctx.fillStyle    = noMoves ? 'rgba(255,255,255,0.45)' : '#fff';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(unit.label, cx, cy - hs * 0.04);
        }

        // HP bar
        this._drawHpBar(ctx, cx, cy - hs * 0.04 + r, hs * 0.7, unit.hp, unit.hpMax);

        // Build progress indicator (worker building something)
        if (unit.buildingImprovement && hs > 18) {
            ctx.font         = `${Math.max(6, hs * 0.18)}px sans-serif`;
            ctx.fillStyle    = '#ffdd44';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('⚒', cx + r * 0.7, cy - hs * 0.04 - r * 0.7);
        }
    }

    // ---- Events ----

    _bindEvents() {
        const canvas = this.canvas;
        const pointers = new Map();
        let pinch = null;
        let drag  = null;

        const localXY = (clientX, clientY) => {
            const rect = canvas.getBoundingClientRect();
            return [clientX - rect.left, clientY - rect.top];
        };

        canvas.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (pointers.size >= 2) {
                const [p1, p2] = [...pointers.values()];
                const [mx, my] = localXY((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
                pinch = {
                    dist:    Math.hypot(p2.x - p1.x, p2.y - p1.y),
                    midX:    mx, midY: my,
                    scale:   this.scale,
                    offsetX: this.offsetX, offsetY: this.offsetY,
                };
                drag = null;
                canvas.style.cursor = 'grab';
            } else {
                drag = {
                    startX: e.clientX, startY: e.clientY,
                    originX: this.offsetX, originY: this.offsetY,
                    pointerId: e.pointerId,
                };
                canvas.style.cursor = 'grabbing';
            }
        });

        canvas.addEventListener('pointermove', e => {
            if (pointers.has(e.pointerId)) {
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }

            if (pinch && pointers.size >= 2) {
                const [p1, p2] = [...pointers.values()];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                if (pinch.dist > 0) {
                    const factor   = dist / pinch.dist;
                    const newScale = Math.min(3.0, Math.max(0.2, pinch.scale * factor));
                    const ratio    = newScale / pinch.scale;
                    this.offsetX = pinch.midX - (pinch.midX - pinch.offsetX) * ratio;
                    this.offsetY = pinch.midY - (pinch.midY - pinch.offsetY) * ratio;
                    this.scale   = newScale;
                    this.draw();
                }
            } else if (drag && pointers.size === 1 && pointers.has(drag.pointerId)) {
                this.offsetX = drag.originX + (e.clientX - drag.startX);
                this.offsetY = drag.originY + (e.clientY - drag.startY);
                this.draw();
            }

            if (this.onHover && pointers.size <= 1) {
                const [lx, ly] = localXY(e.clientX, e.clientY);
                this.onHover(this.hexAtScreen(lx, ly), e);
            }
        });

        const endPointer = e => {
            const wasDrag  = drag && drag.pointerId === e.pointerId;
            const wasPinch = !!pinch;
            pointers.delete(e.pointerId);

            if (wasPinch) {
                if (pointers.size < 2) pinch = null;
                if (pointers.size === 0) drag = null;
                canvas.style.cursor = 'grab';
            } else if (wasDrag) {
                const dx = e.clientX - drag.startX;
                const dy = e.clientY - drag.startY;
                if (Math.hypot(dx, dy) < 5 && this.onClick) {
                    const [lx, ly] = localXY(e.clientX, e.clientY);
                    const tile = this.hexAtScreen(lx, ly);
                    if (e.pointerType === 'touch' && this.onHover) {
                        this.onHover(tile, e);
                    }
                    this.onClick(tile, e);
                }
                drag = null;
                canvas.style.cursor = 'grab';
            }
        };

        canvas.addEventListener('pointerup',     endPointer);
        canvas.addEventListener('pointercancel', endPointer);

        canvas.addEventListener('pointerleave', () => {
            if (this.onHover) this.onHover(null, null);
        });

        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const [mx, my] = localXY(e.clientX, e.clientY);
            const factor   = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            const newScale = Math.min(3.0, Math.max(0.2, this.scale * factor));
            this.offsetX = mx - (mx - this.offsetX) * (newScale / this.scale);
            this.offsetY = my - (my - this.offsetY) * (newScale / this.scale);
            this.scale   = newScale;
            this.draw();
        }, { passive: false });
    }
}

if (typeof module !== 'undefined') module.exports = {
    hexNeighbors, hexDistance, hexesInRange, hexLine,
    axialRound, hexToPixel, pixelToHex, hexCorners,
};
