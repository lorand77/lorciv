"use strict";

// ============================================================
// ui.js — the game page. The server owns the game; this page renders the
// latest snapshot and turns clicks into actions (docs/design.md, "The game
// on the server"). It keeps a local Game built from each snapshot for
// previews only: reachable tiles, attackable tiles, yields, costs. Nothing
// here advances the state; every change arrives as a new snapshot, after the
// server has accepted the action.
//
// Bare names (Game, UNIT_DEFS, deserializeGame, HexRenderer, connectSocket,
// ...) come from the /js/*.js scripts game.html loads before this one.
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

// On a phone the sidebar is a sheet over the map (game.css, "Phones"), so the
// map has the whole width; elsewhere it shares it with the sidebar.
const COMPACT = window.matchMedia('(max-width: 700px)');

function _sizeGameCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth - (COMPACT.matches ? 0 : SIDEBAR_W);
    const h = window.innerHeight;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
}
_sizeGameCanvas();

// ============================================================
// Page state: the latest snapshot and who we are in it
// ============================================================

const GAME_ID = Number(new URLSearchParams(location.search).get('id'));
if (!Number.isInteger(GAME_ID)) location.replace('/lobby.html');

let game     = null;   // Game rebuilt from the latest snapshot; previews only
let seq      = -1;     // the snapshot's sequence number; sent back with every action
let mySeat   = null;   // our seat, or null when watching
let seats    = [];     // [{ seat, kind, username, difficulty, civ }]
let status   = null;   // 'active' | 'finished' | 'aborted'
let deadline = null;   // ms since the epoch when the current human turn expires, or null
let formerSeat = null; // our seat before the AI took it over, or null
let renderer = null;
let pending  = false;  // an action is awaiting the server's answer
// End Turn is held for a moment when a turn of ours begins. With only AI seats
// in between, the next turn is ours again before a double-click's second click
// or a held Enter's repeat arrives, and would end that turn too.
const END_TURN_LOCK_MS = 1000;
let endTurnLockedUntil = 0;
let myTurnSeen = null;  // the round whose turn of ours started the lock
let _victoryShown = false;
let techPromptTurn = null; // the round whose start the tech tree was offered at

// Selection is by id: the objects are replaced with every snapshot.
let sel = { unitId: null, cityId: null, reachable: new Map(), attackable: new Set() };

function myCiv()   { return game && mySeat !== null ? game.civs[mySeat] : null; }
function viewCiv() { return myCiv() ?? game.currentCiv(); }
function isMyTurn() {
    return !!game && mySeat !== null && status === 'active' && game.winner === null &&
           game.currentPlayer === mySeat;
}
function seatName(seat) {
    const s = seats[seat];
    const civName = game.civs[seat].name;
    if (!s) return civName;
    return s.kind === 'human' ? `${civName} (${s.username ?? '?'})` : `${civName} (AI)`;
}
function selectedUnit() { return sel.unitId === null ? null : game.unitById(sel.unitId); }
function selectedCity() { return sel.cityId === null ? null : game.cityById(sel.cityId); }

// ============================================================
// Server connection
// ============================================================

const socket = connectSocket({
    onConnect:    () => join(),
    onDisconnect: () => setConn('Disconnected — reconnecting…'),
    onError:      (err) => {
        if (String(err && err.message).includes('unauthorized')) location.replace('/login.html');
        else setConn('Cannot reach the server.');
    },
});
socket.on('game:state', applyState);
socket.on('chat:message', (m) => {
    if (m.gameId !== GAME_ID) return;
    appendChat(m);
    // On a phone the chat is folded away under More: mark that there is news.
    if (!document.body.classList.contains('sheet-open')) document.getElementById('sheet-btn').classList.add('unread');
});
socket.on('turn:yours', (info) => { if (info.gameId === GAME_ID) announceTurn(); });
socket.on('achievements:earned', (list) => AchievementToast.show(list));

function setConn(text) {
    const el = document.getElementById('conn-status');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
}

// The same event starts, resumes after a reload and catches up after a
// reconnect: the answer is always the full state.
function join() {
    socket.emit('game:join', { gameId: GAME_ID }, (res) => {
        if (!res || !res.ok) {
            const why = { no_such_game: 'No such game.', not_started: 'This game has not started yet. Its table is on the Play page.' };
            setConn((res && why[res.error]) || 'Could not join the game.');
            return;
        }
        setConn('');
        renderChat(res.state.chat || []);
        applyState(res.state);
    });
}

const ERROR_TEXT = {
    not_your_turn: 'Not your turn.',
    game_over:     'The game is over.',
    not_seated:    'You are watching this game.',
    illegal:       'Not allowed.',
    server_error:  'The server could not save that. Try again.',
};

// How long an action may wait for its answer. The AI seats that follow an
// end of turn play before the server answers, which can take seconds.
const ACK_TIMEOUT_MS = 30000;

// Send one action. The server broadcasts the new state as game:state, which is
// what redraws the page, and then answers (the ack). The state arrives while
// `pending` is still set, so the ack redraws the sidebar's buttons once more.
// With a timeout the ack also fires, with an error, if the connection drops
// first; a plain one would be dropped and leave `pending` set for good. The
// reconnect's game:join then brings the state, whether the action went
// through or not.
function send(action) {
    if (!isMyTurn() || pending) return;
    if (action.type === 'endTurn' && Date.now() < endTurnLockedUntil) return;
    pending = true;
    updateEndTurnButton();
    socket.timeout(ACK_TIMEOUT_MS).emit('game:action', { gameId: GAME_ID, seq, ...action }, (err, res) => {
        pending = false;
        updateSidebar();
        if (err) { showMessage('Lost touch with the server; that action may not have gone through.'); return; }
        if (!res) return;
        if (!res.ok) {
            // A stale seq is answered with a fresh state; nothing to show.
            if (res.error !== 'stale') showMessage(res.message || ERROR_TEXT[res.error] || 'Rejected by the server.');
            return;
        }
        if (res.message) showMessage(res.message);
    });
}

// ============================================================
// Applying a snapshot
// ============================================================

function applyState(state) {
    if (!state || state.seq < seq) return; // older than what we have
    const first = game === null;
    game   = deserializeGame(state.snapshot);
    seq    = state.seq;
    status = state.status;
    seats  = state.seats;
    deadline = state.deadline ?? null;
    if (state.mySeat !== undefined) mySeat = state.mySeat;
    if (state.formerSeat !== undefined) formerSeat = state.formerSeat;

    if (!renderer) {
        renderer = new HexRenderer(canvas, PLAYER_COLORS);
        renderer.onClick = handleClick;
        renderer.onHover = handleHover;
        renderer.loadTiles(game.tiles);
        centerOnHome();
    } else {
        renderer.tiles = game.tiles;
    }
    renderer.knownTechs = viewCiv().techsResearched;

    if (isMyTurn() && myTurnSeen !== game.turn) {
        myTurnSeen = game.turn;
        endTurnLockedUntil = Date.now() + END_TURN_LOCK_MS;
        setTimeout(updateEndTurnButton, END_TURN_LOCK_MS + 20);
    }

    reselect();
    const civ = myCiv();
    if (civ && civ.pendingMessages.length) showMessage(civ.pendingMessages.join('\n'));
    else if (first) clearMessages();

    updateSidebar();
    renderPlayers();
    renderer.draw();

    if (game.winner !== null) { closeTechTree(); showVictoryScreen(game.winner); return; }
    if (isMyTurn()) maybeOpenTechTree();
    else closeTechTree();
}

// Our capital in the middle of the map, else another city or a unit of ours;
// a spectator gets the civ to move. A civ with nothing left keeps the whole map.
function centerOnHome() {
    const civ = viewCiv();
    const spot = civ.cities.find(c => c === civ.originalCapital) ?? civ.cities[0] ?? civ.units[0];
    if (!spot) return;
    renderer.centerOn(spot.q, spot.r);
    // On a phone the sheet covers the bottom of the map: centre on what shows.
    if (COMPACT.matches) {
        renderer.offsetY -= document.getElementById('sidebar').offsetHeight / 2;
        renderer.draw();
    }
}

// Keep the selection across snapshots when it still makes sense: our unit
// with moves left, or our city. Otherwise clear it.
function reselect() {
    if (sel.unitId !== null) {
        const u = game.unitById(sel.unitId);
        if (u && u.owner === mySeat && u.movesLeft > 0) { selectUnit(u); return; }
    }
    if (sel.cityId !== null) {
        const c = game.cityById(sel.cityId);
        if (c && c.owner === mySeat) { selectCity(c); return; }
    }
    deselect();
}

// At the start of our turn only: the first snapshot of the turn decides.
// Every action brings a snapshot, so without the check the tree reopened
// whenever a move left nothing selected, though the player had closed it.
function maybeOpenTechTree() {
    if (techPromptTurn === game.turn) return;
    techPromptTurn = game.turn;
    const civ = myCiv();
    if (civ && !civ.currentResearch && availableTechs(civ.techsResearched).length > 0) openTechTree();
}

// ============================================================
// Score + Victory
// ============================================================

function showVictoryScreen(winnerIdx) {
    if (_victoryShown) return;
    _victoryShown = true;
    // Victory for the winner only; defeat for the other seats, and for whoever
    // left one; a spectator, or someone whose abandoned civ won under the AI,
    // gets a plain game over.
    const ours = mySeat ?? formerSeat;
    const outcome = mySeat === winnerIdx ? 'victory'
                  : ours !== null && ours !== winnerIdx ? 'defeat' : 'over';
    const title = document.getElementById('victory-title');
    title.textContent = { victory: 'VICTORY!', defeat: 'DEFEAT', over: 'GAME OVER' }[outcome];
    title.className = outcome;
    const civ = game.civs[winnerIdx];
    document.getElementById('victory-subtitle').textContent =
        `${civ.name} achieves Domination!`;
    document.getElementById('victory-subtitle').style.color = PLAYER_COLORS[winnerIdx];
    document.getElementById('victory-overlay').classList.remove('hidden');
    _drawVictoryGraph();
}

function _drawVictoryGraph() {
    const scoreHistory = game.scoreHistory;
    const vc = document.getElementById('victory-graph');
    const W = Math.min(window.innerWidth - 80, 760);
    const H = 220;
    vc.width  = W;
    vc.height = H;

    const ctx = vc.getContext('2d');
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

    ctx.fillStyle = '#9090b8';
    ctx.font = '13px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Score History', px, 8);

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

    ctx.strokeStyle = '#323258';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);

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

    ctx.fillStyle = '#5a5a7a';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('Turn 1', px, py + ph + 6);
    ctx.textAlign = 'right';
    ctx.fillText(`Turn ${numTurns}`, px + pw, py + ph + 6);

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

document.getElementById('victory-lobby').addEventListener('click', () => {
    location.href = '/lobby.html';
});
document.getElementById('victory-replay').addEventListener('click', () => {
    location.href = '/replay.html?id=' + GAME_ID;
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
        score:     computeScore(civ, game),
        cap_hp:    civ.originalCapital?.hp ?? 0,
    };
}

function openStats() {
    if (!game) return;
    const overlay = document.getElementById('stats-overlay');
    overlay.classList.remove('hidden');

    const civStats = game.civs.map(civ => _buildCivStats(civ));

    const hdr = document.getElementById('stats-header-row');
    hdr.innerHTML = '<th></th>';
    for (const civ of game.civs) {
        const th = document.createElement('th');
        th.textContent = civ.isEliminated ? `${civ.name} (elim)` : civ.name;
        th.style.color = civ.isEliminated ? '#5a5a5a' : PLAYER_COLORS[civ.playerIndex];
        hdr.appendChild(th);
    }

    const tbody = document.getElementById('stats-body');
    tbody.innerHTML = '';
    STAT_ROWS.forEach(({ label, key, color }, rowIdx) => {
        const tr = document.createElement('tr');
        if (rowIdx % 2 === 0) tr.className = 'stats-stripe';

        const tdLabel = document.createElement('td');
        tdLabel.textContent = label;
        tr.appendChild(tdLabel);

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
// Selection helpers
// ============================================================

function selectUnit(unit) {
    sel.unitId    = unit.id;
    sel.cityId    = null;
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
    sel.unitId    = null;
    sel.cityId    = city.id;
    sel.reachable = new Map();
    sel.attackable= new Set();
    renderer.setOverlays({ selected: `${city.q},${city.r}` });
    closeTechTree();
}

function deselect() {
    sel.unitId    = null;
    sel.cityId    = null;
    sel.reachable = new Map();
    sel.attackable= new Set();
    if (renderer) renderer.clearOverlays();
    document.getElementById('unit-panel').classList.add('hidden');
    document.getElementById('city-panel').classList.add('hidden');
}

function redraw() {
    renderer.draw();
    updateSidebar();
}

// ============================================================
// Click handler
// ============================================================

function handleClick(tile) {
    if (!game) return;
    if (!tile) { deselect(); redraw(); return; }

    const key = `${tile.q},${tile.r}`;

    // A selected unit of ours, on our turn: move or attack. The server decides;
    // the page only knows what the engine would allow.
    const unit = selectedUnit();
    if (unit && isMyTurn()) {
        if (sel.reachable.has(key)) {
            send({ type: 'move', unitId: unit.id, q: tile.q, r: tile.r });
            return;
        }
        if (sel.attackable.has(key)) {
            send({ type: 'attack', unitId: unit.id, q: tile.q, r: tile.r });
            return;
        }
    }

    // Select our own unit or city (for a look, even when it is not our turn).
    // A tile can hold a military unit, a civilian and a city at once: the first
    // click takes the first of ours, each further click on the same tile the
    // next, round and round, so a garrison never hides its city.
    const here = [tile.unit, tile.civilian, tile.city].filter(x => x && x.owner === mySeat);
    if (here.length) {
        const current = here.findIndex(x => x === tile.city ? sel.cityId === x.id : sel.unitId === x.id);
        const next = here[(current + 1) % here.length];
        if (next === tile.city) selectCity(next); else selectUnit(next);
        redraw();
        return;
    }

    deselect();
    redraw();
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

function statusText() {
    if (game.winner !== null) return `${game.civs[game.winner].name} won the game.`;
    if (status === 'aborted') return 'This game was abandoned: nobody is left to play it.';
    if (status !== 'active') return 'This game is over.';
    if (isMyTurn()) return 'Your turn';
    if (mySeat === null && formerSeat !== null) return `Your seat was handed to the AI · ${seatName(game.currentPlayer)} to play`;
    if (mySeat === null) return `Watching · ${seatName(game.currentPlayer)} to play`;
    return `Waiting for ${seatName(game.currentPlayer)}…`;
}

// "2:31" for minutes, "1h 05m" for hours, "2d 3h" for days.
function formatRemaining(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// The status line, with the time left on the clock when there is one. Called
// every second while a deadline is set.
function renderStatusLine() {
    if (!game) return;
    const line = document.getElementById('status-line');
    line.textContent = statusText();
    line.classList.toggle('mine', isMyTurn());
    if (deadline !== null && status === 'active' && game.winner === null) {
        const left = deadline - Date.now();
        const span = document.createElement('span');
        span.className = 'countdown' + (left < 30000 ? ' low' : '');
        span.textContent = '⏱ ' + formatRemaining(left);
        line.appendChild(span);
    }
}
setInterval(() => { if (deadline !== null) renderStatusLine(); }, 1000);

// The seats: who sits where, whose turn it is, missed turns.
function renderPlayers() {
    const list = document.getElementById('players-list');
    list.innerHTML = '';
    for (const s of seats) {
        const civ = game.civs[s.seat];
        const row = document.createElement('div');
        row.className = 'player-row'
            + (s.seat === game.currentPlayer && game.winner === null ? ' current' : '')
            + (civ.isEliminated ? ' eliminated' : '');
        const dot = document.createElement('span');
        dot.className = 'civ-dot';
        dot.style.background = PLAYER_COLORS[s.seat];
        const who = document.createElement('span');
        who.className = 'who';
        const name = s.kind === 'human' ? s.username : 'AI';
        who.textContent = `${civ.name} · ${name}${s.seat === mySeat ? ' (you)' : ''}`;
        row.append(dot, who);
        if (s.missedTurns > 0 && s.kind === 'human') {
            const m = document.createElement('span');
            m.className = 'missed';
            m.textContent = `⏳×${s.missedTurns}`;
            m.title = `${s.missedTurns} turn(s) ran out`;
            row.appendChild(m);
        }
        if (s.seat === game.currentPlayer && game.winner === null) {
            const mark = document.createElement('span');
            mark.className = 'mark';
            mark.textContent = '▶';
            row.appendChild(mark);
        }
        list.appendChild(row);
    }
    document.getElementById('leave-btn').classList.toggle('hidden', !(mySeat !== null && status === 'active'));
}

// ---- Chat ----

function chatLine(m) {
    const line = document.createElement('div');
    line.className = 'chat-line' + (window.currentUser && m.userId === window.currentUser.id ? ' mine' : '');
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = m.username;
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = m.text;
    line.append(who, text);
    return line;
}

function renderChat(messages) {
    const log = document.getElementById('chat-log');
    log.innerHTML = '';
    for (const m of messages) log.appendChild(chatLine(m));
    log.scrollTop = log.scrollHeight;
}

function appendChat(m) {
    const log = document.getElementById('chat-log');
    log.appendChild(chatLine(m));
    log.scrollTop = log.scrollHeight;
}

document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat:send', { gameId: GAME_ID, text }, (res) => {
        if (res && res.ok) input.value = '';
        else showMessage('Could not send that.');
    });
});

// ---- Your turn, while the tab is in the background ----

const BASE_TITLE = document.title;
function announceTurn() {
    if (!document.hidden) return;
    document.title = '● Your turn — LorCiv';
    if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('LorCiv — your turn', { body: `Game #${GAME_ID} is waiting for you.` });
        n.onclick = () => window.focus();
    }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = BASE_TITLE; });

document.getElementById('leave-btn').addEventListener('click', (e) => {
    const sure = confirm('Hand your seat to the AI for the rest of the game? This cannot be undone.');
    // The dialog hands focus back to Leave; a later Enter meant for End Turn
    // must not land on it.
    e.currentTarget.blur();
    if (!sure) return;
    socket.emit('game:leave', { gameId: GAME_ID }, (res) => {
        if (!res || !res.ok) { showMessage(ERROR_TEXT[res && res.error] || 'Could not leave.'); return; }
        // The seat is the AI's now; nothing left to do here.
        location.href = '/lobby.html';
    });
});

function updateEndTurnButton() {
    const btn = document.getElementById('end-turn-btn');
    const mine = isMyTurn();
    btn.disabled = !mine || pending || Date.now() < endTurnLockedUntil;
    btn.textContent = mine ? (pending ? 'Sending…' : 'End Turn ▶') : 'Waiting…';
}

function updateSidebar() {
    if (!game) return;
    const civ = viewCiv();

    updateScoreboard();

    const dot = `<span class="civ-dot" style="background:${PLAYER_COLORS[civ.playerIndex]}"></span>`;
    document.getElementById('turn-label').innerHTML = `Turn ${game.turn} — ${dot}${civ.name}`;
    renderStatusLine();

    document.getElementById('stat-gold').textContent    = civ.gold;
    document.getElementById('stat-sci').textContent     = civ.science;
    document.getElementById('stat-culture').textContent = civ.culture;

    if (civ.currentResearch) {
        const tech = TECH_DEFS[civ.currentResearch];
        const pct  = Math.min(100, Math.round(civ.science / tech.science_cost * 100));
        document.getElementById('stat-research').textContent = `${tech.name} (${civ.science}/${tech.science_cost})`;
        document.getElementById('research-bar').style.width = pct + '%';
    } else {
        document.getElementById('stat-research').textContent = '—';
        document.getElementById('research-bar').style.width = '0%';
    }

    const unit = selectedUnit();
    const city = selectedCity();
    if (unit) {
        renderUnitPanel(unit, game.civs[unit.owner]);
        document.getElementById('city-panel').classList.add('hidden');
    } else if (city) {
        renderCityPanel(city, game.civs[city.owner]);
        document.getElementById('unit-panel').classList.add('hidden');
    } else {
        document.getElementById('unit-panel').classList.add('hidden');
        document.getElementById('city-panel').classList.add('hidden');
    }

    updateEndTurnButton();
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

    const hpPct = unit.hp / unit.hpMax * 100;
    const bar   = document.getElementById('unit-hp-bar');
    bar.style.width  = hpPct + '%';
    bar.style.background = hpPct > 60 ? '#4c4' : hpPct > 30 ? '#cc4' : '#c44';

    const buildRow = document.getElementById('unit-build-row');
    if (unit.buildingImprovement) {
        buildRow.classList.remove('hidden');
        document.getElementById('unit-build').textContent =
            `${unit.buildingImprovement} (${unit.buildTurnsLeft}t)`;
    } else {
        buildRow.classList.add('hidden');
    }

    const actions = document.getElementById('unit-actions');
    actions.innerHTML = '';

    const mine = isMyTurn();
    const addBtn = (label, action, cls = '', disabled = false) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        if (cls) btn.className = cls;
        btn.disabled = disabled || !mine || pending;
        btn.addEventListener('click', () => send(action));
        actions.appendChild(btn);
    };

    const hasMoves = unit.movesLeft > 0;

    if (!unit.isCivilian) {
        addBtn(unit.fortified ? 'Fortified' : 'Fortify', { type: 'fortify', unitId: unit.id }, '',
            !hasMoves || unit.fortified);

        // Heal needs a full turn of rest: the unit must not have moved yet.
        const canHeal = unit.movesLeft === defn.moves && !unit.healing;
        addBtn(unit.healing ? 'Healing' : 'Heal', { type: 'heal', unitId: unit.id }, '', !canHeal);

        const upgPath = UNIT_UPGRADES[unit.unitType];
        if (upgPath) {
            const [toType, gCost] = upgPath;
            const tdef    = UNIT_DEFS[toType];
            const techOk  = !tdef.requires_tech || civ.techsResearched.has(tdef.requires_tech);
            const resOk   = !tdef.requires_resource ||
                [...game.tiles.values()].some(t => t.resource === tdef.requires_resource && t.owner === unit.owner);
            const canUpg  = hasMoves && techOk && resOk && civ.gold >= gCost;
            addBtn(`Upgrade (${gCost}g)`, { type: 'upgrade', unitId: unit.id }, '', !canUpg);
        }
    }

    if (unit.unitType === 'settler') {
        const [canFound] = game.canFoundCity(unit);
        addBtn('Found City', { type: 'foundCity', unitId: unit.id }, 'primary', !hasMoves || !canFound);
    }

    if (unit.unitType === 'worker' && hasMoves) {
        const tile = game.tiles.get(`${unit.q},${unit.r}`);
        for (const [key, imp] of Object.entries(IMPROVEMENT_DEFS)) {
            const terrainOk = imp.valid_terrain.includes(tile?.terrain);
            const goldMineOk = key === 'mine' && tile?.resource === 'gold'
                && (tile.terrain === 'grassland' || tile.terrain === 'plains');
            if (!terrainOk && !goldMineOk) continue;
            if (key === 'pasture' && tile?.resource !== 'horses') continue;
            // The engine's own rule (tech, own land, no city, not there yet),
            // so the button offers what the server accepts.
            const [can] = game.canImprove(unit, key);
            addBtn(`Build ${imp.name}`, { type: 'buildImprovement', unitId: unit.id, key }, '', !can);
        }
    }

    addBtn('Skip', { type: 'skip', unitId: unit.id }, '', !hasMoves);
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

    const prodInfo = document.getElementById('city-production-info');
    if (city.productionQueue.length) {
        const cur  = city.productionQueue[0];
        const cost = getItemCost(cur);
        const name = (UNIT_DEFS[cur] ?? BUILDING_DEFS[cur])?.name ?? cur;
        prodInfo.textContent = `${name}: ${city.productionProgress}/${cost} (${yields.prod}⚙/t)`;
    } else {
        prodInfo.textContent = 'Nothing queued';
    }

    renderProductionList(city, civ);

    const bList = document.getElementById('city-buildings');
    bList.textContent = city.buildings
        .map(b => BUILDING_DEFS[b]?.name ?? b).join(', ') || '—';
}

// The list offers what the engine would accept (game.canProduce); the server
// checks again when the choice arrives.
function renderProductionList(city, civ) {
    const list = document.getElementById('production-list');
    list.innerHTML = '';

    const buildable = [];
    for (const [key, defn] of Object.entries(UNIT_DEFS)) {
        if (game.canProduce(city, key)[0]) buildable.push({ key, name: defn.name, cost: defn.prod_cost });
    }
    for (const [key, defn] of Object.entries(BUILDING_DEFS)) {
        if (game.canProduce(city, key)[0]) buildable.push({ key, name: defn.name, cost: defn.prod_cost });
    }
    buildable.sort((a, b) => a.cost - b.cost);

    const mine = isMyTurn();
    for (const item of buildable) {
        const el = document.createElement('div');
        el.className = 'prod-item' + (city.productionQueue[0] === item.key ? ' active' : '');
        const goldCost = buyCost(city, item.key); // what the server will charge
        const canAfford = civ.gold >= goldCost;
        el.innerHTML = `<span>${item.name}</span><span class="cost">${item.cost}⚙</span>`
            + `<button class="buy-btn" ${canAfford && mine ? '' : 'disabled'} title="Purchase for ${goldCost} gold">${goldCost}g</button>`;
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('buy-btn')) return;
            send({ type: 'setProduction', cityId: city.id, key: item.key });
        });
        el.querySelector('.buy-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            send({ type: 'buy', cityId: city.id, key: item.key });
        });
        list.appendChild(el);
    }
}

// ---- Tech Tree Overlay ----

function openTechTree() {
    if (!game) return;
    const overlay = document.getElementById('tech-overlay');
    overlay.classList.remove('hidden');
    const tc = document.getElementById('tech-tree-canvas');
    const maxW = Math.min(window.innerWidth - 40, TREE_W * 2);
    // Never so small that a card cannot be read or tapped: on a phone the
    // overlay scrolls instead.
    const scale = Math.max(0.8, Math.min(1.6, maxW / TREE_W));
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round(TREE_W * scale);
    const displayH = Math.round(TREE_H * scale);
    tc.style.width  = displayW + 'px';
    tc.style.height = displayH + 'px';
    tc.width  = Math.round(displayW * dpr);
    tc.height = Math.round(displayH * dpr);
    tc._treeScale = scale;
    drawTechTree(tc, viewCiv());
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
    if (!game) return;
    const tc    = e.currentTarget;
    const scale = tc._treeScale ?? 1;
    const rect  = tc.getBoundingClientRect();
    const mx    = (e.clientX - rect.left) / scale;
    const my    = (e.clientY - rect.top)  / scale;
    const civ   = viewCiv();

    for (const [key, pos] of Object.entries(TECH_POSITIONS)) {
        if (mx >= pos.x && mx <= pos.x + CARD_W && my >= pos.y && my <= pos.y + CARD_H) {
            if (isMyTurn() && canResearch(key, civ.techsResearched)) {
                send({ type: 'setResearch', key });
                closeTechTree();
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
    const panel = document.getElementById('msg-panel');
    panel.classList.remove('hidden');
    document.getElementById('msg-text').textContent = msg;
}

function clearMessages() {
    document.getElementById('msg-panel').classList.add('hidden');
}

// ============================================================
// Buttons, overlays, keyboard
// ============================================================

document.getElementById('end-turn-btn').addEventListener('click', () => send({ type: 'endTurn' }));

document.getElementById('center-btn').addEventListener('click', () => { if (game) centerOnHome(); });

document.getElementById('tech-btn').addEventListener('click', () => {
    const overlay = document.getElementById('tech-overlay');
    if (overlay.classList.contains('hidden')) openTechTree();
    else closeTechTree();
});
document.getElementById('tech-close').addEventListener('click', closeTechTree);

// Phones: More unfolds the sheet to the civ's numbers, players and chat.
document.getElementById('sheet-btn').addEventListener('click', (e) => {
    const open = document.body.classList.toggle('sheet-open');
    e.currentTarget.textContent = open ? 'Less' : 'More';
    e.currentTarget.classList.remove('unread');
});

document.getElementById('stats-btn').addEventListener('click', () => {
    const so = document.getElementById('stats-overlay');
    if (so.classList.contains('hidden')) openStats();
    else closeStats();
});

document.getElementById('stats-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeStats();
});
document.getElementById('tech-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTechTree();
});

window.addEventListener('resize', () => {
    _sizeGameCanvas();
    if (renderer) renderer.draw();
});

// A button clicked with the mouse gives up its focus, so a later Enter (End
// Turn) never presses it by accident. A button pressed from the keyboard
// (detail 0) keeps focus where the player put it.
document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (btn && e.detail > 0) btn.blur();
});

document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    // Ctrl+F, Cmd+P and the like belong to the browser, not to the game.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!game) return;

    const unit = selectedUnit();
    const key = e.key;
    // Enter on a focused button or link presses that, not End Turn.
    if (key === 'Enter' && e.target.closest('button, a')) return;

    switch (key) {
        case 'Enter':
            if (!e.repeat) send({ type: 'endTurn' }); // a held key ends one turn
            break;

        case 'c': case 'C':
            centerOnHome();
            break;

        case 'Escape':
            closeStats();
            closeTechTree();
            deselect(); redraw();
            break;

        case 's': case 'S': {
            const so = document.getElementById('stats-overlay');
            if (so.classList.contains('hidden')) openStats();
            else closeStats();
            break;
        }

        case 't': case 'T': {
            const overlay = document.getElementById('tech-overlay');
            if (overlay.classList.contains('hidden')) openTechTree();
            else closeTechTree();
            break;
        }

        // Settler
        case 'f': case 'F':
            if (unit?.unitType === 'settler') send({ type: 'foundCity', unitId: unit.id });
            break;

        // Worker
        case 'm': case 'M':
            if (unit?.unitType === 'worker') send({ type: 'buildImprovement', unitId: unit.id, key: 'mine' });
            break;
        case 'a': case 'A':
            if (unit?.unitType === 'worker') send({ type: 'buildImprovement', unitId: unit.id, key: 'farm' });
            break;
        case 'p': case 'P':
            if (unit?.unitType === 'worker') send({ type: 'buildImprovement', unitId: unit.id, key: 'pasture' });
            break;

        // Military
        case 'k': case 'K':
            if (unit && !unit.isCivilian) send({ type: 'fortify', unitId: unit.id });
            break;
        case 'h': case 'H':
            if (unit && !unit.isCivilian) send({ type: 'heal', unitId: unit.id });
            break;
        case 'u': case 'U':
            if (unit && !unit.isCivilian) send({ type: 'upgrade', unitId: unit.id });
            break;

        // Arrow key pan
        case 'ArrowLeft':  renderer.offsetX += 40; renderer.draw(); e.preventDefault(); break;
        case 'ArrowRight': renderer.offsetX -= 40; renderer.draw(); e.preventDefault(); break;
        case 'ArrowUp':    renderer.offsetY += 40; renderer.draw(); e.preventDefault(); break;
        case 'ArrowDown':  renderer.offsetY -= 40; renderer.draw(); e.preventDefault(); break;
    }
});
