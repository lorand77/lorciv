"use strict";

// The replay page: a game's states rebuilt in the browser from its seed and
// its recorded actions (src/shared/replay.js), shown step by step on the same
// canvas as the game. Nothing here talks to the game; it only reads.

(function () {
    const SIDEBAR_W = 272;
    const canvas = document.getElementById('game-canvas');
    canvas.style.touchAction = 'none';
    function sizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth - SIDEBAR_W, h = window.innerHeight;
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    sizeCanvas();

    const GAME_ID = Number(new URLSearchParams(location.search).get('id'));
    if (!Number.isInteger(GAME_ID)) location.replace('/lobby.html');
    document.getElementById('game-link').href = '/game.html?id=' + GAME_ID;

    const $ = (id) => document.getElementById(id);
    let record = null;
    let states = [];   // serialized snapshots, states[i] = after action i
    let labels = [];
    let step = 0;
    let game = null;
    let renderer = null;
    let timer = null;

    function status(text) { $('status-line').textContent = text; }

    // Rebuild in slices so the page stays responsive on a long game.
    function build(record, done) {
        const game = replayStart(record.setup);
        const seats = record.setup.cpuFlags.map(cpu => ({ kind: cpu ? 'ai' : 'human', missedTurns: 0 }));
        states = [serializeGame(game)];
        labels = ['Start'];
        let i = 0;
        const total = record.actions.length;
        function slice() {
            const until = Math.min(total, i + 25);
            for (; i < until; i++) {
                const rec = record.actions[i];
                const res = replayStep(game, seats, rec);
                if (!res.ok) {
                    status(`The record stops making sense at action ${rec.seq} (${res.error}).`);
                    return done();
                }
                states.push(serializeGame(game));
                labels.push(describeStep(rec, PLAYER_NAMES[rec.seat]));
            }
            $('replay-progress').textContent = i < total ? `Rebuilding… ${i}/${total}` : '';
            if (i < total) setTimeout(slice, 0); else done();
        }
        slice();
    }

    function show(i) {
        step = Math.max(0, Math.min(states.length - 1, i));
        game = deserializeGame(states[step]);
        if (!renderer) {
            renderer = new HexRenderer(canvas, PLAYER_COLORS);
            renderer.onHover = hover;
            renderer.loadTiles(game.tiles);
        } else {
            renderer.tiles = game.tiles;
        }
        renderer.knownTechs = null;
        renderer.draw();
        $('step').value = String(step);
        $('step-label').textContent = `${step} / ${states.length - 1} · ${labels[step]}`;
        $('turn-label').textContent = `Turn ${game.turn}`;
        status(game.winner !== null ? `${game.civs[game.winner].name} wins.` : `${game.civs[game.currentPlayer].name} to play`);
        renderPlayers();
        renderScoreboard();
    }

    function renderPlayers() {
        const list = $('players-list');
        list.innerHTML = '';
        for (const s of record.seats) {
            const civ = game.civs[s.seat];
            const row = document.createElement('div');
            row.className = 'player-row' + (s.seat === game.currentPlayer && game.winner === null ? ' current' : '')
                + (civ.isEliminated ? ' eliminated' : '');
            const dot = document.createElement('span');
            dot.className = 'civ-dot'; dot.style.background = PLAYER_COLORS[s.seat];
            const who = document.createElement('span');
            who.className = 'who';
            who.textContent = `${civ.name} · ${s.username ?? 'AI'}`;
            row.append(dot, who);
            list.appendChild(row);
        }
    }

    function renderScoreboard() {
        const sb = $('scoreboard');
        sb.classList.remove('hidden');
        const entries = game.civs.map(c => ({ civ: c, score: computeScore(c, game) })).sort((a, b) => b.score - a.score);
        let html = '<div class="sb-title">SCORES</div>';
        for (const { civ, score } of entries) {
            const color = civ.isEliminated ? '#505058' : civ.color;
            html += `<div class="sb-row${civ.isEliminated ? ' sb-elim' : ''}"><div class="sb-swatch" style="background:${color}"></div>`
                + `<div class="sb-name" style="color:${color}">${civ.name}</div>`
                + `<div class="sb-score" style="color:${color}">${civ.isEliminated ? 'eliminated' : score}</div></div>`;
        }
        sb.innerHTML = html;
    }

    const tooltip = $('tooltip');
    function hover(tile, e) {
        if (!tile || !e) { tooltip.style.display = 'none'; return; }
        const lines = [tile.terrain + (tile.resource ? ` · ${tile.resource}` : '') + (tile.improvement ? ` · ${tile.improvement}` : '')];
        if (tile.owner !== null) lines.push(`Owner: ${game.civs[tile.owner]?.name ?? '?'}`);
        if (tile.city) lines.push(`City: ${tile.city.name} (HP ${tile.city.hp}/50)`);
        const u = tile.unit ?? tile.civilian;
        if (u) lines.push(`Unit: ${u.name} HP ${u.hp}/${u.hpMax}`);
        tooltip.textContent = lines.join('\n');
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top = (e.clientY + 14) + 'px';
    }

    function playing() { return timer !== null; }
    function stop() { if (timer) clearInterval(timer); timer = null; $('play-btn').textContent = '▶ Play'; }
    function play() {
        if (playing()) { stop(); return; }
        if (step >= states.length - 1) show(0);
        $('play-btn').textContent = '⏸ Pause';
        timer = setInterval(() => {
            if (step >= states.length - 1) { stop(); return; }
            show(step + 1);
        }, Number($('speed').value));
    }

    $('step').addEventListener('input', () => { stop(); show(Number($('step').value)); });
    $('first-btn').addEventListener('click', () => { stop(); show(0); });
    $('prev-btn').addEventListener('click', () => { stop(); show(step - 1); });
    $('next-btn').addEventListener('click', () => { stop(); show(step + 1); });
    $('last-btn').addEventListener('click', () => { stop(); show(states.length - 1); });
    $('play-btn').addEventListener('click', play);
    $('speed').addEventListener('change', () => { if (playing()) { stop(); play(); } });
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'ArrowRight') { stop(); show(step + 1); }
        else if (e.key === 'ArrowLeft') { stop(); show(step - 1); }
        else if (e.key === ' ') { e.preventDefault(); play(); }
        else if (e.key === 'Home') { stop(); show(0); }
        else if (e.key === 'End') { stop(); show(states.length - 1); }
    });
    window.addEventListener('resize', () => { sizeCanvas(); if (renderer) renderer.draw(); });

    fetch(`/api/games/${GAME_ID}/replay`, { credentials: 'same-origin' })
        .then((res) => { if (!res.ok) throw new Error(res.status === 404 ? 'No such game, or it has not started.' : 'HTTP ' + res.status); return res.json(); })
        .then((data) => {
            record = data;
            status('Rebuilding the game…');
            build(record, () => {
                $('step').max = String(states.length - 1);
                show(states.length - 1);
            });
        })
        .catch((err) => status(err.message));
})();
