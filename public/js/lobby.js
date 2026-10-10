"use strict";

// The lobby page: start a new game (one human seat, the rest AI, for now) and
// list the games you hold a seat in. Civ names, colours, difficulties and turn
// times come from the shared engine scripts, so the form offers exactly what
// the server accepts (src/game/routes.js checks against the same lists).

(function () {
  const rowsEl = document.getElementById("seat-rows");
  const seedEl = document.getElementById("seed-input");
  const turnEl = document.getElementById("turn-time");
  const errEl = document.getElementById("new-game-error");
  const listEl = document.getElementById("games-list");
  const countEl = document.getElementById("games-count");

  const difficulty = Array.from({ length: SEATS }, () => "prince");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Seat 0 is yours; the other seats are AI with a difficulty each.
  function renderSeats() {
    rowsEl.innerHTML = "";
    for (let i = 0; i < SEATS; i++) {
      const row = el("div", "seat-row");
      const swatch = el("span", "swatch");
      swatch.style.background = PLAYER_COLORS[i];
      const name = el("span", "name", PLAYER_NAMES[i]);
      name.style.color = PLAYER_COLORS[i];
      row.append(swatch, name);
      if (i === 0) {
        row.append(el("span", "muted", "You"));
      } else {
        const sel = document.createElement("select");
        for (const d of DIFFICULTIES) {
          const o = document.createElement("option");
          o.value = d;
          o.textContent = "AI · " + d.charAt(0).toUpperCase() + d.slice(1);
          sel.appendChild(o);
        }
        sel.value = difficulty[i];
        sel.addEventListener("change", () => { difficulty[i] = sel.value; });
        row.append(sel);
      }
      rowsEl.appendChild(row);
    }
  }

  function randomSeed() {
    seedEl.value = Math.floor(Math.random() * 1000000);
  }

  for (const t of TURN_TIMES) {
    const o = document.createElement("option");
    o.value = t.key;
    o.textContent = t.label;
    turnEl.appendChild(o);
  }
  turnEl.value = DEFAULT_TURN_TIME;
  renderSeats();
  randomSeed();
  document.getElementById("seed-random").addEventListener("click", randomSeed);

  document.getElementById("start-btn").addEventListener("click", async () => {
    errEl.textContent = "";
    const seats = Array.from({ length: SEATS }, (_, i) =>
      i === 0 ? { kind: "human" } : { kind: "ai", difficulty: difficulty[i] });
    const seed = parseInt(seedEl.value, 10);
    const body = { seats, turnTime: turnEl.value };
    if (Number.isInteger(seed) && seed >= 0) body.seed = seed;
    try {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || "Could not start the game."; return; }
      location.href = "/game.html?id=" + data.id;
    } catch (err) {
      errEl.textContent = "Network error.";
    }
  });

  // A game's one-line status: who is to play, or how it ended.
  function describe(g) {
    if (g.status === "finished") {
      const w = g.seats[g.winnerSeat];
      return w ? `${w.civ} won` : "finished";
    }
    if (g.status === "aborted") return "aborted";
    const s = g.seats[g.currentSeat];
    if (g.currentSeat === g.mySeat) return "your turn";
    return s ? `waiting for ${s.civ}${s.kind === "human" ? " (" + s.username + ")" : ""}` : "";
  }

  async function loadGames() {
    let games;
    try {
      const res = await fetch("/api/games", { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      games = await res.json();
    } catch (err) {
      listEl.innerHTML = "";
      listEl.appendChild(el("p", "muted empty", "Could not load your games."));
      return;
    }
    listEl.innerHTML = "";
    countEl.textContent = games.length ? `(${games.length})` : "";
    if (!games.length) {
      listEl.appendChild(el("p", "muted empty", "No games yet. Start one above."));
      return;
    }
    for (const g of games) {
      const row = el("div", "row");
      const main = el("div", "row-main");
      const me = g.seats[g.mySeat];
      const swatch = el("span", "swatch");
      swatch.style.background = PLAYER_COLORS[g.mySeat];
      main.append(swatch, el("span", "name", `Game #${g.id}`),
        el("span", "muted small", `${me ? me.civ : ""} · turn ${g.turn} · ${describe(g)}`));
      if (g.currentSeat === g.mySeat && g.status === "active") main.appendChild(el("span", "tag you", "your turn"));
      const open = el("a", null, g.status === "active" ? "Play" : "View");
      open.href = "/game.html?id=" + g.id;
      open.className = "button-link";
      row.append(main, open);
      listEl.appendChild(row);
    }
  }
  loadGames();
})();
