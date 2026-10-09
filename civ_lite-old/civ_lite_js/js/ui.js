// ============================================================
// Bootstrap
// ============================================================

const SIDEBAR_W = 272;

// Tech tree layout constants
const TECH_POSITIONS = {
    mining:           { x:10,  y:30  },
    animal_husbandry: { x:10,  y:100 },
    archery:          { x:10,  y:170 },
    pottery:          { x:10,  y:240 },
    bronze_working:   { x:200, y:30  },
    horseback_riding: { x:200, y:100 },
    writing:          { x:200, y:200 },
    iron_working:     { x:390, y:30  },
    mathematics:      { x:390, y:130 },
    currency:         { x:390, y:210 },
    theology:         { x:390, y:280 },
    feudalism:        { x:580, y:30  },
    steel:            { x:580, y:100 },
    machinery:        { x:580, y:170 },
    education:        { x:580, y:250 },
    civil_service:    { x:580, y:320 },
};
const CARD_W = 160, CARD_H = 52;
const TREE_W = 760, TREE_H = 410;

const canvas  = document.getElementById('game-canvas');
canvas.style.touchAction = 'none';

function _sizeGameCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth - SIDEBAR_W;
    const h = window.innerHeight;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
}
_sizeGameCanvas();

// Game + renderer instances
let game, renderer;
let _rendererReady = false;

// Selection state
let sel = { unit: null, city: null, reachable: new Map(), attackable: new Set() };

// Last combat/event message
let lastMsg = '';

// Score history: array of [p0, p1, p2, p3] snapshots, one per game turn
let scoreHistory = [];
let _victoryShown = false;

// ============================================================
// Score + Victory
// ============================================================

function computeScore(civ) {
    if (civ.isEliminated) return 0;
    let score = 0;
    score += civ.cities.length * 50;
    score += civ.cities.reduce((s, c) => s + c.population, 0) * 20;
    score += civ.units.filter(u => !u.isCivilian)
                      .reduce((s, u) => s + UNIT_DEFS[u.unitType].strength, 0) * 3;
    score += civ.techsResearched.size * 20;
    score += [...game.tiles.values()].filter(t => t.owner === civ.playerIndex).length;
    score += Math.trunc(civ.gold / 10);
    for (const city of civ.cities)
        for (const bKey of city.buildings) {
            const b = BUILDING_DEFS[bKey]; if (!b) continue;
            const eff = b.effects ?? {};
            score += (eff.food_per_turn    ?? 0) * 4;
            score += (eff.prod_per_turn    ?? 0) * 5;
            score += (eff.gold_per_turn    ?? 0) * 3;
            score += (eff.science_per_turn ?? 0) * 6;
            score += (eff.culture_per_turn ?? 0) * 2;
            score += (b.defense            ?? 0) * 8;
        }
    return score;
}

function recordScores() {
    scoreHistory.push(game.civs.map(civ => computeScore(civ)));
}

function showVictoryScreen(winnerIdx) {
    if (_victoryShown) return;
    _victoryShown = true;
    const civ = game.civs[winnerIdx];
    document.getElementById('victory-subtitle').textContent =
        `${civ.name} achieves Domination!`;
    document.getElementById('victory-subtitle').style.color = PLAYER_COLORS[winnerIdx];
    document.getElementById('victory-overlay').classList.remove('hidden');
    _drawVictoryGraph();
}

function _drawVictoryGraph() {
    const canvas = document.getElementById('victory-graph');
    const W = Math.min(window.innerWidth - 80, 760);
    const H = 220;
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#08080f';
    ctx.fillRect(0, 0, W, H);

    if (scoreHistory.length < 1) return;

    const PAD_L = 52, PAD_R = 20, PAD_T = 28, PAD_B = 30;
    const pw = W - PAD_L - PAD_R;
    const ph = H - PAD_T - PAD_B;
    const px = PAD_L, py = PAD_T;

    const maxScore = Math.max(1, ...scoreHistory.flatMap(t => t));
    const numTurns = scoreHistory.length;
    const singlePoint = numTurns === 1;

    // Title
    ctx.fillStyle = '#9090b8';
    ctx.font = '13px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Score History', px, 8);

    // Grid lines
    ctx.strokeStyle = '#1c1c30';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const gy = py + ph - Math.round(ph * i / 5);
        ctx.beginPath(); ctx.moveTo(px, gy); ctx.lineTo(px + pw, gy); ctx.stroke();
        ctx.fillStyle = '#5a5a7a';
        ctx.font = '11px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(maxScore * i / 5), px - 4, gy);
    }

    // Plot border
    ctx.strokeStyle = '#323258';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);

    // Civ score lines
    for (let ci = 0; ci < game.civs.length; ci++) {
        const color = PLAYER_COLORS[ci];
        ctx.strokeStyle = game.civs[ci].isEliminated ? '#444' : color;
        ctx.lineWidth = 2;
        if (singlePoint) {
            const x = px + pw / 2;
            const y = py + ph - Math.round(scoreHistory[0][ci] * ph / maxScore);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = game.civs[ci].isEliminated ? '#444' : color;
            ctx.fill();
        } else {
            ctx.beginPath();
            for (let ti = 0; ti < numTurns; ti++) {
                const x = px + Math.round(ti * pw / (numTurns - 1));
                const y = py + ph - Math.round(scoreHistory[ti][ci] * ph / maxScore);
                ti === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    }

    // X-axis labels
    ctx.fillStyle = '#5a5a7a';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('Turn 1', px, py + ph + 6);
    ctx.textAlign = 'right';
    ctx.fillText(`Turn ${numTurns}`, px + pw, py + ph + 6);

    // Legend (top-right inside plot)
    const lx = px + pw - 130, ly = py + 6;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let ci = 0; ci < game.civs.length; ci++) {
        const row   = ly + ci * 18;
        const color = game.civs[ci].isEliminated ? '#444' : PLAYER_COLORS[ci];
        ctx.fillStyle = color;
        ctx.fillRect(lx, row - 5, 18, 10);
        ctx.fillStyle = '#ccc';
        ctx.font = '11px sans-serif';
        const label = game.civs[ci].isEliminated
            ? `${PLAYER_NAMES[ci]} (elim)`
            : `${PLAYER_NAMES[ci]}: ${scoreHistory[scoreHistory.length - 1][ci]}`;
        ctx.fillText(label, lx + 22, row);
    }
}

document.getElementById('victory-new-game').addEventListener('click', () => {
    document.getElementById('victory-overlay').classList.add('hidden');
    openSetup();
});

// ============================================================
// Stats window
// ============================================================

const STAT_ROWS = [
    { label: 'Military Strength', key: 'mil_str',  color: '#ff7878' },
    { label: 'Gold',              key: 'gold',      color: '#ffd700' },
    { label: 'Gold / Turn',       key: 'gpt',       color: '#dcb900' },
    { label: 'Cities',            key: 'cities',    color: '#b4dcff' },
    { label: 'Population',        key: 'pop',       color: '#8cdc8c' },
    { label: 'Science / Turn',    key: 'sci_pt',    color: '#78b4ff' },
    { label: 'Production / Turn', key: 'ppt',       color: '#e08840' },
    { label: 'Techs Researched',  key: 'techs',     color: '#c88cff' },
    { label: 'Territory',         key: 'territory', color: '#a0c8a0' },
    { label: 'Score',             key: 'score',     color: '#ffc850' },
    { label: 'Capital HP',        key: 'cap_hp',    color: '#ff6464' },
];

function _buildCivStats(civ) {
    if (civ.isEliminated) return null;
    const milStr    = civ.units.filter(u => !u.isCivilian)
                               .reduce((s, u) => s + UNIT_DEFS[u.unitType].strength, 0);
    const territory = [...game.tiles.values()].filter(t => t.owner === civ.playerIndex).length;
    const allYields = civ.cities.map(c => computeCityYields(c, game.tiles, civ));
    const gpt = allYields.reduce((s, y) => s + y.gold, 0);
    const spt = allYields.reduce((s, y) => s + y.science, 0);
    const ppt = allYields.reduce((s, y) => s + y.prod, 0);
    return {
        mil_str:   milStr,
        gold:      civ.gold,
        gpt,
        cities:    civ.cities.length,
        pop:       civ.cities.reduce((s, c) => s + c.population, 0),
        sci_pt:    spt,
        ppt,
        techs:     civ.techsResearched.size,
        territory,
        score:     computeScore(civ),
        cap_hp:    civ.originalCapital?.hp ?? 0,
    };
}

function openStats() {
    const overlay = document.getElementById('stats-overlay');
    overlay.classList.remove('hidden');

    const civStats = game.civs.map(civ => _buildCivStats(civ));

    // Header row
    const hdr = document.getElementById('stats-header-row');
    hdr.innerHTML = '<th></th>';
    for (const civ of game.civs) {
        const th = document.createElement('th');
        th.textContent = civ.isEliminated ? `${civ.name} (elim)` : civ.name;
        th.style.color = civ.isEliminated ? '#5a5a5a' : PLAYER_COLORS[civ.playerIndex];
        hdr.appendChild(th);
    }

    // Body rows
    const tbody = document.getElementById('stats-body');
    tbody.innerHTML = '';
    STAT_ROWS.forEach(({ label, key, color }, rowIdx) => {
        const tr = document.createElement('tr');
        if (rowIdx % 2 === 0) tr.className = 'stats-stripe';

        const tdLabel = document.createElement('td');
        tdLabel.textContent = label;
        tr.appendChild(tdLabel);

        // Find best value among active civs
        const activeVals = civStats.filter(Boolean).map(s => s[key]);
        const best = activeVals.length ? Math.max(...activeVals) : null;

        for (const civ of game.civs) {
            const td = document.createElement('td');
            const stats = civStats[civ.playerIndex];
            if (!stats) {
                td.textContent = '—';
                td.style.color = '#4a4a4a';
            } else {
                const v = stats[key];
                const isLeader = best !== null && v === best;
                if (isLeader) td.classList.add('stats-leader');
                if (key === 'gpt') {
                    td.textContent = v > 0 ? `+${v}` : String(v);
                    td.style.color = v > 0 ? '#64dc64' : v < 0 ? '#ff5050' : '#888';
                } else {
                    td.textContent = String(v);
                    td.style.color = isLeader ? '#ffe850' : color;
                }
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    });
}

function closeStats() {
    document.getElementById('stats-overlay').classList.add('hidden');
}

// ============================================================
// Setup screen
// ============================================================

const _setupState = {
    isCpu:       [false, true, true, true],
    difficulty:  ['prince', 'prince', 'prince', 'prince'],
};
const _DIFFICULTIES = ['prince', 'king', 'emperor'];
const _DIFF_BG = { prince: '#464658', king: '#7a6418', emperor: '#783232' };

function openSetup() {
    const seed = Math.floor(Math.random() * 1_000_000);
    document.getElementById('setup-seed-input').value = seed;
    document.getElementById('seed-input').value = seed;
    document.getElementById('setup-overlay').classList.remove('hidden');
    _renderSetupRows();
    _refreshContinueButton();
}

function _refreshContinueButton() {
    const btn  = document.getElementById('setup-continue');
    const meta = quicksaveMetadata();
    if (!meta) { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    btn.textContent = `Continue (Turn ${meta.turn}, ${meta.civName})`;
}

function _renderSetupRows() {
    const container = document.getElementById('setup-rows');
    container.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const row = document.createElement('div');
        row.className = 'setup-row';

        const swatch = document.createElement('div');
        swatch.className = 'setup-swatch';
        swatch.style.background = PLAYER_COLORS[i];
        row.appendChild(swatch);

        const name = document.createElement('div');
        name.className = 'setup-name';
        name.textContent = PLAYER_NAMES[i];
        name.style.color = PLAYER_COLORS[i];
        row.appendChild(name);

        const diffBtn = document.createElement('button');
        const diff = _setupState.difficulty[i];
        diffBtn.className = `setup-diff-btn ${diff}`;
        diffBtn.textContent = diff.charAt(0).toUpperCase() + diff.slice(1);
        diffBtn.addEventListener('click', () => {
            const idx = _DIFFICULTIES.indexOf(_setupState.difficulty[i]);
            _setupState.difficulty[i] = _DIFFICULTIES[(idx + 1) % 3];
            _renderSetupRows();
        });
        row.appendChild(diffBtn);

        const cpuBtn = document.createElement('button');
        cpuBtn.className = `setup-cpu-btn ${_setupState.isCpu[i] ? 'cpu' : 'human'}`;
        cpuBtn.textContent = _setupState.isCpu[i] ? 'CPU' : 'Human';
        cpuBtn.addEventListener('click', () => {
            _setupState.isCpu[i] = !_setupState.isCpu[i];
            _renderSetupRows();
        });
        row.appendChild(cpuBtn);

        container.appendChild(row);
    }
}

document.getElementById('setup-start').addEventListener('click', () => {
    const seed = parseInt(document.getElementById('setup-seed-input').value, 10) || 0;
    document.getElementById('seed-input').value = seed;
    document.getElementById('setup-overlay').classList.add('hidden');
    initGame(seed, [..._setupState.isCpu], [..._setupState.difficulty]);
});

document.getElementById('setup-continue').addEventListener('click', () => {
    const saveObj = loadQuick();
    if (!saveObj) { _refreshContinueButton(); return; }
    try { applyLoadedState(saveObj); }
    catch (err) {
        alert(`Failed to load quicksave: ${err.message}`);
        _refreshContinueButton();
    }
});

document.getElementById('setup-import').addEventListener('click', async () => {
    try {
        const saveObj = await importFromFile();
        applyLoadedState(saveObj);
    } catch (err) {
        if (err && err.message !== 'No file chosen')
            alert(`Failed to import save: ${err.message}`);
    }
});

// ============================================================
// Init / New Game
// ============================================================

let _activeSetup = null; // {seed, cpuFlags, difficultyFlags} of the running game

function initGame(seed, cpuFlags = null, difficultyFlags = null) {
    scoreHistory = [];
    _victoryShown = false;
    _activeSetup = {
        seed,
        cpuFlags: cpuFlags ?? [false, true, true, true],
        difficultyFlags: difficultyFlags ?? ['prince','prince','prince','prince'],
    };
    game = new Game({ seed, cpuFlags, difficultyFlags });
    if (!_rendererReady) {
        renderer = new HexRenderer(canvas, PLAYER_COLORS);
        renderer.onClick = handleClick;
        renderer.onHover = handleHover;
        _rendererReady = true;
    }
    renderer.loadTiles(game.tiles);
    renderer.knownTechs = game.currentCiv().techsResearched;
    deselect();
    updateSidebar();
    renderer.draw();

    // If turn 1 starts on a CPU civ, run their AI and chain through any
    // further CPU civs until we land on the first human (or game end).
    if (game.currentCiv().isCpu) doEndTurn();
}

function applyLoadedState(saveObj) {
    const loaded = deserializeInto(saveObj);
    game           = loaded.game;
    scoreHistory   = loaded.scoreHistory;
    _activeSetup   = {
        seed: loaded.setup.seed,
        cpuFlags: [...loaded.setup.cpuFlags],
        difficultyFlags: [...loaded.setup.difficultyFlags],
    };
    _victoryShown  = false;
    _setupState.isCpu      = [..._activeSetup.cpuFlags];
    _setupState.difficulty = [..._activeSetup.difficultyFlags];

    if (!_rendererReady) {
        renderer = new HexRenderer(canvas, PLAYER_COLORS);
        renderer.onClick = handleClick;
        renderer.onHover = handleHover;
        _rendererReady = true;
    }
    renderer.loadTiles(game.tiles);
    renderer.knownTechs = game.currentCiv().techsResearched;
    deselect();
    clearMessages();
    updateSidebar();
    renderer.draw();
    document.getElementById('setup-overlay').classList.add('hidden');
    if (game.winner !== null) showVictoryScreen(game.winner);
}

// Show setup screen on page load
openSetup();

document.getElementById('new-map-btn').addEventListener('click', () => {
    openSetup();
});
document.getElementById('seed-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('new-map-btn').click();
});

window.addEventListener('resize', () => {
    _sizeGameCanvas();
    if (renderer) renderer.draw();
});

// ============================================================
// Selection helpers
// ============================================================

function selectUnit(unit) {
    sel.unit      = unit;
    sel.city      = null;
    sel.reachable = getReachableTiles(unit, game.tiles, game.turn);
    sel.attackable= getAttackableTiles(unit, game.tiles);
    renderer.setOverlays({
        reachable:  sel.reachable,
        attackable: sel.attackable,
        selected:   `${unit.q},${unit.r}`,
    });
    closeTechTree();
}

function selectCity(city) {
    sel.unit      = null;
    sel.city      = city;
    sel.reachable = new Map();
    sel.attackable= new Set();
    renderer.setOverlays({ selected: `${city.q},${city.r}` });
    closeTechTree();
}

function deselect() {
    sel.unit      = null;
    sel.city      = null;
    sel.reachable = new Map();
    sel.attackable= new Set();
    renderer.clearOverlays();
    document.getElementById('unit-panel').classList.add('hidden');
    document.getElementById('city-panel').classList.add('hidden');
    closeTechTree();
    // Open tech tree if human civ has no current research
    const civ = game.currentCiv();
    if (!civ.isCpu && !civ.currentResearch && availableTechs(civ.techsResearched).length > 0) {
        openTechTree();
    }
}

// ============================================================
// Click handler
// ============================================================

function handleClick(tile) {
    if (!tile) { deselect(); renderer.draw(); updateSidebar(); return; }

    const key = `${tile.q},${tile.r}`;
    const civ = game.currentCiv();

    // If a unit is selected: move or attack
    if (sel.unit) {
        if (sel.reachable.has(key)) {
            game.moveUnit(sel.unit, tile.q, tile.r, sel.reachable.get(key));
            if (sel.unit.movesLeft === 0) {
                deselect();
            } else {
                selectUnit(sel.unit); // recompute reachable from new position
            }
            renderer.draw();
            updateSidebar();
            return;
        }
        if (sel.attackable.has(key)) {
            const msg = game.doAttack(sel.unit, tile.q, tile.r);
            showMessage(msg);
            deselect();
            renderer.draw();
            updateSidebar();
            if (game.winner !== null) { recordScores(); showVictoryScreen(game.winner); }
            return;
        }
    }

    // Select own unit or city
    const unit = tile.unit ?? tile.civilian;
    if (unit && unit.owner === game.currentPlayer) {
        selectUnit(unit);
        updateSidebar();
        renderer.draw();
        return;
    }
    if (tile.city && tile.city.owner === game.currentPlayer) {
        selectCity(tile.city);
        updateSidebar();
        renderer.draw();
        return;
    }

    // Click empty / enemy tile → deselect
    deselect();
    renderer.draw();
    updateSidebar();
}

// ============================================================
// Hover tooltip
// ============================================================

const tooltip = document.getElementById('tooltip');

function handleHover(tile, e) {
    if (!tile || !e) { tooltip.style.display = 'none'; return; }

    const lines = [];
    const t = tile.terrain.charAt(0).toUpperCase() + tile.terrain.slice(1);
    lines.push(t + (tile.resource ? ` · ${tile.resource}` : '')
                 + (tile.improvement ? ` · ${tile.improvement}` : ''));
    if (tile.owner !== null) lines.push(`Owner: ${game.civs[tile.owner]?.name ?? '?'}`);
    if (tile.city) lines.push(`City: ${tile.city.name} (HP ${tile.city.hp}/50)`);
    const u = tile.unit ?? tile.civilian;
    if (u) lines.push(`Unit: ${u.name} HP ${u.hp}/${u.hpMax}  Moves ${u.movesLeft}`);
    lines.push(`(${tile.q}, ${tile.r})`);

    tooltip.textContent = lines.join('\n');
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top  = (e.clientY + 14) + 'px';
}

// ============================================================
// Sidebar rendering
// ============================================================

function updateScoreboard() {
    const sb = document.getElementById('scoreboard');
    sb.classList.remove('hidden');
    const entries = game.civs
        .map(c => ({ civ: c, score: computeScore(c, game) }))
        .sort((a, b) => b.score - a.score);

    let html = '<div class="sb-title">SCORES</div>';
    for (const { civ, score } of entries) {
        const color = civ.isEliminated ? '#505058' : civ.color;
        const cls   = civ.isEliminated ? ' sb-elim' : '';
        const label = civ.isEliminated ? 'eliminated' : score;
        html += `<div class="sb-row${cls}">`
             +  `<div class="sb-swatch" style="background:${color}"></div>`
             +  `<div class="sb-name" style="color:${color}">${civ.name}</div>`
             +  `<div class="sb-score" style="color:${color}">${label}</div>`
             +  `</div>`;
    }
    sb.innerHTML = html;
}

function updateSidebar() {
    const civ = game.currentCiv();

    updateScoreboard();

    // Turn / civ label
    const dot = `<span class="civ-dot" style="background:${PLAYER_COLORS[civ.playerIndex]}"></span>`;
    document.getElementById('turn-label').innerHTML =
        `Turn ${game.turn} — ${dot}${civ.name}`;

    // Stats
    document.getElementById('stat-gold').textContent    = civ.gold;
    document.getElementById('stat-sci').textContent     = civ.science;
    document.getElementById('stat-culture').textContent = civ.culture;

    // Research bar
    if (civ.currentResearch) {
        const tech = TECH_DEFS[civ.currentResearch];
        const pct  = Math.min(100, Math.round(civ.science / tech.science_cost * 100));
        document.getElementById('stat-research').textContent = `${tech.name} (${civ.science}/${tech.science_cost})`;
        document.getElementById('research-bar').style.width = pct + '%';
    } else {
        document.getElementById('stat-research').textContent = '—';
        document.getElementById('research-bar').style.width = '0%';
    }

    // Entity panels
    if (sel.unit) {
        renderUnitPanel(sel.unit, civ);
        document.getElementById('city-panel').classList.add('hidden');
    } else if (sel.city) {
        renderCityPanel(sel.city, civ);
        document.getElementById('unit-panel').classList.add('hidden');
    } else {
        document.getElementById('unit-panel').classList.add('hidden');
        document.getElementById('city-panel').classList.add('hidden');
    }
}

// ---- Unit panel ----

function renderUnitPanel(unit, civ) {
    const panel = document.getElementById('unit-panel');
    panel.classList.remove('hidden');

    const defn = UNIT_DEFS[unit.unitType];
    document.getElementById('unit-title').textContent = unit.name;
    document.getElementById('unit-hp').textContent    = `${unit.hp}/${unit.hpMax}`;
    document.getElementById('unit-moves').textContent = `${unit.movesLeft}/${defn.moves}`;
    document.getElementById('unit-xp').textContent    = unit.xp;

    // HP bar colour
    const hpPct = unit.hp / unit.hpMax * 100;
    const bar   = document.getElementById('unit-hp-bar');
    bar.style.width  = hpPct + '%';
    bar.style.background = hpPct > 60 ? '#4c4' : hpPct > 30 ? '#cc4' : '#c44';

    // Build info
    const buildRow = document.getElementById('unit-build-row');
    if (unit.buildingImprovement) {
        buildRow.classList.remove('hidden');
        document.getElementById('unit-build').textContent =
            `${unit.buildingImprovement} (${unit.buildTurnsLeft}t)`;
    } else {
        buildRow.classList.add('hidden');
    }

    // Action buttons
    const actions = document.getElementById('unit-actions');
    actions.innerHTML = '';

    const addBtn = (label, cb, cls = '', disabled = false) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        if (cls) btn.className = cls;
        btn.disabled = disabled;
        btn.addEventListener('click', cb);
        actions.appendChild(btn);
    };

    const hasMoves = unit.movesLeft > 0;

    if (!unit.isCivilian) {
        // Fortify
        addBtn(unit.fortified ? 'Fortified' : 'Fortify', () => {
            unit.fortified  = true;
            unit.fortifyBonus = Math.min(0.5, unit.fortifyBonus + 0.25);
            unit.movesLeft  = 0;
            deselect();
            renderer.draw();
            updateSidebar();
        }, '', !hasMoves || unit.fortified);

        // Heal / skip — requires full movement (unit must not have moved this turn)
        const canHeal = unit.movesLeft === defn.moves && !unit.healing;
        addBtn(unit.healing ? 'Healing' : 'Heal', () => {
            unit.healing   = true;
            unit.movesLeft = 0;
            deselect();
            renderer.draw();
            updateSidebar();
        }, '', !canHeal);

        // Upgrade
        const upgPath = UNIT_UPGRADES[unit.unitType];
        if (upgPath) {
            const [toType, gCost] = upgPath;
            const tdef    = UNIT_DEFS[toType];
            const techOk  = !tdef.requires_tech || civ.techsResearched.has(tdef.requires_tech);
            const resOk   = !tdef.requires_resource ||
                [...game.tiles.values()].some(t => t.resource === tdef.requires_resource && t.owner === unit.owner);
            const canUpg  = hasMoves && techOk && resOk && civ.gold >= gCost;
            addBtn(`Upgrade (${gCost}g)`, () => {
                const [ok, msg] = game.upgradeUnit(unit);
                if (ok) { selectUnit(unit); renderer.draw(); }
                showMessage(msg);
                updateSidebar();
            }, '', !canUpg);
        }
    }

    // Settler: found city
    if (unit.unitType === 'settler') {
        const [canFound, why] = game.canFoundCity(unit);
        addBtn('Found City', () => {
            const [ok] = game.canFoundCity(unit);
            if (ok) {
                game.foundCity(unit);
                deselect();
                renderer.draw();
                updateSidebar();
            }
        }, 'primary', !hasMoves || !canFound);
    }

    // Worker: build improvements
    if (unit.unitType === 'worker' && hasMoves) {
        const tile = game.tiles.get(`${unit.q},${unit.r}`);
        for (const [key, imp] of Object.entries(IMPROVEMENT_DEFS)) {
            const terrainOk = imp.valid_terrain.includes(tile?.terrain);
            const goldMineOk = key === 'mine' && tile?.resource === 'gold'
                && (tile.terrain === 'grassland' || tile.terrain === 'plains');
            if (!terrainOk && !goldMineOk) continue;
            if (key === 'pasture' && tile?.resource !== 'horses') continue;
            const needsTech = imp.requires_tech && !civ.techsResearched.has(imp.requires_tech);
            addBtn(`Build ${imp.name}`, () => {
                game.startImprovement(unit, key);
                deselect();
                renderer.draw();
                updateSidebar();
            }, '', needsTech);
        }
    }

    // Skip (consume moves)
    addBtn('Skip', () => {
        unit.movesLeft = 0;
        deselect();
        renderer.draw();
        updateSidebar();
    }, '', !hasMoves);
}

// ---- City panel ----

function renderCityPanel(city, civ) {
    const panel = document.getElementById('city-panel');
    panel.classList.remove('hidden');

    document.getElementById('city-title').textContent = city.name;
    document.getElementById('city-pop').textContent   = city.population;
    document.getElementById('city-hp').textContent    = `${city.hp}/50`;
    document.getElementById('city-hp-bar').style.width = (city.hp / 50 * 100) + '%';

    const threshold = city.foodGrowthThreshold;
    document.getElementById('city-food').textContent =
        `${city.foodStored}/${threshold}`;
    document.getElementById('city-food-bar').style.width =
        Math.min(100, city.foodStored / threshold * 100) + '%';

    const yields = computeCityYields(city, game.tiles, civ);
    document.getElementById('city-yields').textContent =
        `🌾${yields.food} ⚙️${yields.prod} 💰${yields.gold} 🔬${yields.science}`;

    // Current production
    const prodInfo = document.getElementById('city-production-info');
    if (city.productionQueue.length) {
        const cur  = city.productionQueue[0];
        const cost = getItemCost(cur);
        const name = (UNIT_DEFS[cur] ?? BUILDING_DEFS[cur])?.name ?? cur;
        prodInfo.textContent = `${name}: ${city.productionProgress}/${cost} (${yields.prod}⚙/t)`;
    } else {
        prodInfo.textContent = 'Nothing queued';
    }

    // Production list
    renderProductionList(city, civ);

    // Buildings
    const bList = document.getElementById('city-buildings');
    bList.textContent = city.buildings
        .map(b => BUILDING_DEFS[b]?.name ?? b).join(', ') || '—';
}

function renderProductionList(city, civ) {
    const list = document.getElementById('production-list');
    list.innerHTML = '';

    const buildable = [];

    // Units
    for (const [key, defn] of Object.entries(UNIT_DEFS)) {
        if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;
        if (defn.requires_resource) {
            const has = [...game.tiles.values()].some(
                t => t.resource === defn.requires_resource && t.owner === city.owner);
            if (!has) continue;
        }
        buildable.push({ key, name: defn.name, cost: defn.prod_cost, category: 'unit' });
    }

    // Buildings
    for (const [key, defn] of Object.entries(BUILDING_DEFS)) {
        if (key === 'palace') continue;
        if (city.buildings.includes(key)) continue;
        if (defn.requires_tech && !civ.techsResearched.has(defn.requires_tech)) continue;
        buildable.push({ key, name: defn.name, cost: defn.prod_cost, category: 'building' });
    }

    buildable.sort((a, b) => a.cost - b.cost);

    for (const item of buildable) {
        const el = document.createElement('div');
        el.className = 'prod-item' + (city.productionQueue[0] === item.key ? ' active' : '');
        const goldCost = item.cost * 2;
        const canAfford = civ.gold >= goldCost;
        el.innerHTML = `<span>${item.name}</span><span class="cost">${item.cost}⚙</span><button class="buy-btn" ${canAfford ? '' : 'disabled'} title="Purchase for ${goldCost} gold">${goldCost}g</button>`;
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('buy-btn')) return;
            city.productionQueue = [item.key];
            city.productionProgress = 0;
            renderCityPanel(city, civ);
        });
        el.querySelector('.buy-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!canAfford) return;
            const [ok] = game.buyItem(city, item.key);
            if (ok) {
                renderCityPanel(city, civ);
                updateSidebar();
            }
        });
        list.appendChild(el);
    }
}

// ---- Tech Tree Overlay ----

function openTechTree() {
    const overlay = document.getElementById('tech-overlay');
    overlay.classList.remove('hidden');
    const tc = document.getElementById('tech-tree-canvas');
    const maxW = Math.min(window.innerWidth - 40, TREE_W * 2);
    const scale = Math.min(1.6, maxW / TREE_W);
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round(TREE_W * scale);
    const displayH = Math.round(TREE_H * scale);
    tc.style.width  = displayW + 'px';
    tc.style.height = displayH + 'px';
    tc.width  = Math.round(displayW * dpr);
    tc.height = Math.round(displayH * dpr);
    tc._treeScale = scale;
    drawTechTree(tc, game.currentCiv());
}

function closeTechTree() {
    document.getElementById('tech-overlay').classList.add('hidden');
}

function drawTechTree(tc, civ) {
    const scale = tc._treeScale ?? 1;
    const dpr = window.devicePixelRatio || 1;
    const ctx = tc.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, tc.width, tc.height);
    ctx.fillStyle = '#080c18';
    ctx.fillRect(0, 0, tc.width, tc.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);

    // Draw arrows behind cards
    for (const [key, defn] of Object.entries(TECH_DEFS)) {
        const toPos = TECH_POSITIONS[key];
        if (!toPos) continue;
        for (const preKey of defn.prerequisites) {
            const fromPos = TECH_POSITIONS[preKey];
            if (!fromPos) continue;
            const bothDone = civ.techsResearched.has(key) && civ.techsResearched.has(preKey);
            const preDone  = civ.techsResearched.has(preKey);
            const color = bothDone ? '#4ab44a' : preDone ? '#6060c0' : '#303038';
            _drawArrow(ctx,
                fromPos.x + CARD_W, fromPos.y + CARD_H / 2,
                toPos.x,            toPos.y   + CARD_H / 2,
                color);
        }
    }

    // Draw cards
    for (const [key, defn] of Object.entries(TECH_DEFS)) {
        const pos = TECH_POSITIONS[key];
        if (!pos) continue;
        const researched = civ.techsResearched.has(key);
        const isCurrent  = civ.currentResearch === key;
        const prereqsMet = defn.prerequisites.every(p => civ.techsResearched.has(p));
        const available  = !researched && prereqsMet;

        let bg, border, textColor;
        if (researched)     { bg='#1a3a1a'; border='#4ab44a'; textColor='#90e090'; }
        else if (isCurrent) { bg='#1a1a3a'; border='#8080d8'; textColor='#b0b0ff'; }
        else if (available) { bg='#1e1e32'; border='#6060a0'; textColor='#cccccc'; }
        else                { bg='#111118'; border='#303038'; textColor='#555555'; }

        ctx.fillStyle = bg;
        ctx.strokeStyle = border;
        ctx.lineWidth = 1.5;
        _roundRect(ctx, pos.x, pos.y, CARD_W, CARD_H, 4);
        ctx.fill(); ctx.stroke();

        ctx.fillStyle = textColor;
        ctx.font = `bold 11px sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(defn.name, pos.x + 6, pos.y + 6);

        ctx.font = `10px sans-serif`;
        ctx.fillStyle = researched ? '#4ab44a' : isCurrent ? '#8080d8' : '#888';
        let costStr;
        if (researched) costStr = 'Done';
        else if (isCurrent) costStr = `${civ.science} / ${defn.science_cost} sci`;
        else costStr = `${defn.science_cost} sci`;
        ctx.fillText(costStr, pos.x + 6, pos.y + 20);

        const unlocks = [
            ...defn.unlocks_units.map(u => UNIT_DEFS[u]?.name ?? u),
            ...defn.unlocks_buildings.map(b => BUILDING_DEFS[b]?.name ?? b),
            ...(defn.unlocks_improvements ?? []),
            ...(defn.reveals_resources ?? []),
        ].join(', ');
        if (unlocks) {
            ctx.font = `9px sans-serif`;
            ctx.fillStyle = researched ? '#3a7a3a' : '#4a5a70';
            const maxPx = CARD_W - 12;
            let text = unlocks;
            while (ctx.measureText(text).width > maxPx && text.length > 0)
                text = text.slice(0, -1);
            if (text !== unlocks) text += '…';
            ctx.fillText(text, pos.x + 6, pos.y + 34);
        }
    }
}

function _drawArrow(ctx, x1, y1, x2, y2, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size  = 6;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - 0.4), y2 - size * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - size * Math.cos(angle + 0.4), y2 - size * Math.sin(angle + 0.4));
    ctx.closePath(); ctx.fill();
}

function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x+w, y, x+w, y+r, r);
    ctx.lineTo(x+w, y+h-r);  ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
    ctx.lineTo(x+r, y+h);    ctx.arcTo(x, y+h, x, y+h-r, r);
    ctx.lineTo(x, y+r);      ctx.arcTo(x, y, x+r, y, r);
    ctx.closePath();
}

document.getElementById('tech-tree-canvas').addEventListener('click', e => {
    const tc    = e.currentTarget;
    const scale = tc._treeScale ?? 1;
    const rect  = tc.getBoundingClientRect();
    const mx    = (e.clientX - rect.left) / scale;
    const my    = (e.clientY - rect.top)  / scale;
    const civ   = game.currentCiv();

    for (const [key, pos] of Object.entries(TECH_POSITIONS)) {
        if (mx >= pos.x && mx <= pos.x + CARD_W && my >= pos.y && my <= pos.y + CARD_H) {
            const defn = TECH_DEFS[key];
            const prereqsMet = defn.prerequisites.every(p => civ.techsResearched.has(p));
            if (!civ.techsResearched.has(key) && prereqsMet) {
                civ.currentResearch = key;
                closeTechTree();
                updateSidebar();
            } else {
                drawTechTree(tc, civ);
            }
            break;
        }
    }
});

// ============================================================
// Messages
// ============================================================

function showMessage(msg) {
    if (!msg) return;
    lastMsg = msg;
    const panel = document.getElementById('msg-panel');
    panel.classList.remove('hidden');
    document.getElementById('msg-text').textContent = msg;
}

function clearMessages() {
    document.getElementById('msg-panel').classList.add('hidden');
    lastMsg = '';
}

// ============================================================
// End Turn
// ============================================================

document.getElementById('end-turn-btn').addEventListener('click', doEndTurn);

document.getElementById('stats-btn').addEventListener('click', () => {
    const so = document.getElementById('stats-overlay');
    if (so.classList.contains('hidden')) openStats();
    else closeStats();
});

document.getElementById('save-btn').addEventListener('click', () => {
    if (!game || !_activeSetup) return;
    const meta = saveQuick(game, scoreHistory, _activeSetup);
    showMessage(`Saved at turn ${meta.turn} (${meta.civName}).`);
});

document.getElementById('export-btn').addEventListener('click', () => {
    if (!game || !_activeSetup) return;
    exportToFile(game, scoreHistory, _activeSetup);
});

document.getElementById('stats-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeStats();
});
document.getElementById('tech-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTechTree();
});

document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;

    const unit = sel.unit;

    switch (e.key) {
        case 'Enter':
            doEndTurn();
            break;

        case 'Escape':
            closeStats();
            closeTechTree();
            deselect(); renderer.draw(); updateSidebar();
            break;

        case 's': case 'S': {
            const _so = document.getElementById('stats-overlay');
            if (_so.classList.contains('hidden')) openStats();
            else closeStats();
            break;
        }

        case 't': case 'T': {
            const _overlay = document.getElementById('tech-overlay');
            if (_overlay.classList.contains('hidden')) openTechTree();
            else closeTechTree();
            break;
        }

        // Settler
        case 'f': case 'F':
            if (unit?.unitType === 'settler') {
                const [ok, msg] = game.canFoundCity(unit);
                if (ok) { game.foundCity(unit); deselect(); renderer.draw(); updateSidebar(); }
                else showMessage(msg);
            }
            break;

        // Worker
        case 'm': case 'M':
            if (unit?.unitType === 'worker') {
                game.startImprovement(unit, 'mine');
                deselect(); renderer.draw(); updateSidebar();
            }
            break;
        case 'a': case 'A':
            if (unit?.unitType === 'worker') {
                game.startImprovement(unit, 'farm');
                deselect(); renderer.draw(); updateSidebar();
            }
            break;
        case 'p': case 'P':
            if (unit?.unitType === 'worker') {
                game.startImprovement(unit, 'pasture');
                deselect(); renderer.draw(); updateSidebar();
            }
            break;

        // Military
        case 'k': case 'K':
            if (unit && !unit.isCivilian && unit.movesLeft > 0) {
                unit.fortified = true; unit.movesLeft = 0;
                deselect(); renderer.draw(); updateSidebar();
            }
            break;
        case 'h': case 'H':
            if (unit && !unit.isCivilian && unit.movesLeft === UNIT_DEFS[unit.unitType].moves) {
                unit.healing = true; unit.movesLeft = 0;
                deselect(); renderer.draw(); updateSidebar();
            }
            break;
        case 'u': case 'U':
            if (unit && !unit.isCivilian) {
                const [ok, msg] = game.upgradeUnit(unit);
                if (ok) { selectUnit(unit); renderer.draw(); }
                showMessage(msg);
                updateSidebar();
            }
            break;

        // Arrow key pan
        case 'ArrowLeft':  renderer.offsetX += 40; renderer.draw(); e.preventDefault(); break;
        case 'ArrowRight': renderer.offsetX -= 40; renderer.draw(); e.preventDefault(); break;
        case 'ArrowUp':    renderer.offsetY += 40; renderer.draw(); e.preventDefault(); break;
        case 'ArrowDown':  renderer.offsetY -= 40; renderer.draw(); e.preventDefault(); break;
    }
});

function doEndTurn() {
    clearMessages();
    deselect();

    // Save civ BEFORE endTurn advances currentPlayer
    const prevCiv = game.currentCiv();
    // If civ 0 is CPU, let AI act before endTurn so it can found its city
    // before maintenance is deducted (otherwise it bankrupts on turn 1).
    if (prevCiv.isCpu) aiTakeTurn(game, prevCiv);
    game.endTurn();
    prevCiv.researchJustCompleted = false;

    // Show messages that were generated during the turn that just ended
    if (prevCiv.pendingMessages.length) {
        showMessage(prevCiv.pendingMessages.join('\n'));
        prevCiv.pendingMessages = [];
    }

    // Disable end-turn button while AI is running
    const endBtn = document.getElementById('end-turn-btn');
    endBtn.disabled = true;

    function _runNextCpu() {
        if (!game.currentCiv().isCpu || game.winner !== null) {
            endBtn.disabled = false;
            _afterAllCpu();
            return;
        }
        const cpuCiv = game.currentCiv();
        aiTakeTurn(game, cpuCiv);
        game.endTurn();
        const allCpu = game.civs.every(c => c.isCpu);
        if (allCpu && game.currentPlayer === 0) recordScores();
        if (allCpu) {
            renderer.knownTechs = game.currentCiv().techsResearched;
            updateSidebar();
        }
        renderer.draw();
        setTimeout(_runNextCpu, 100);
    }

    _runNextCpu();
}

function _afterAllCpu() {
    // Record scores once per round (when human player's turn begins)
    recordScores();

    renderer.knownTechs = game.currentCiv().techsResearched;
    renderer.draw();
    updateSidebar();

    if (game.winner !== null) { showVictoryScreen(game.winner); return; }

    // Prompt for research if the now-active human civ has nothing queued
    const civ = game.currentCiv();
    if (!civ.isCpu) {
        const hasTechs = availableTechs(civ.techsResearched).length > 0;
        if (!civ.currentResearch && hasTechs) {
            openTechTree();
        } else {
            closeTechTree();
        }
    }
}
