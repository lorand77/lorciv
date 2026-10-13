"use strict";

// The lobby page: open tables to join, a form for a new table, your games,
// live games to watch, who is online. The lists come from /api/games; the
// socket says when to refetch (lobby:changed), who is about (lobby:presence),
// when a turn of yours begins (turn:yours) and what you just earned
// (achievements:earned, shown as toasts). Civ names, colours,
// difficulties and turn times come from the shared engine scripts, so the
// form offers exactly what the server accepts.

(function () {
  const $ = (id) => document.getElementById(id);
  const difficulty = Array.from({ length: SEATS }, () => "prince");
  // The civ you play (seat i is always PLAYER_NAMES[i]): the last one picked
  // in this browser, else Rome. A convenience only, so a browser that will not
  // keep it just starts at Rome.
  const CIV_KEY = "lorciv.civ";
  let mine = 0;
  try {
    const saved = Number(localStorage.getItem(CIV_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < SEATS) mine = saved;
  } catch (e) { /* no storage */ }
  const seatKind = Array.from({ length: SEATS }, (_, i) => (i === mine ? "human" : "ai"));
  let me = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function swatch(seat) {
    const s = el("span", "swatch");
    s.style.background = PLAYER_COLORS[seat];
    return s;
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  // ---- new table form ----

  // You take seat `seat`; the seat you leave gets what that one was (open, or
  // an AI and its level), so picking a civ never changes the rest of the table.
  function playAs(seat) {
    seatKind[mine] = seatKind[seat];
    difficulty[mine] = difficulty[seat];
    seatKind[seat] = "human";
    mine = seat;
    try { localStorage.setItem(CIV_KEY, String(seat)); } catch (e) { /* no storage */ }
    renderSeats();
  }

  function renderSeats() {
    const rows = $("seat-rows");
    rows.innerHTML = "";
    for (let i = 0; i < SEATS; i++) {
      const row = el("div", "seat-row");
      const name = el("span", "name", PLAYER_NAMES[i]);
      name.style.color = PLAYER_COLORS[i];
      row.append(swatch(i), name, el("span", "blurb muted", PLAYER_BLURBS[i]));
      if (i === mine) {
        row.classList.add("mine");
        row.append(el("span", "you", "You"));
      } else {
        const sel = document.createElement("select");
        sel.setAttribute("aria-label", PLAYER_NAMES[i]);
        const you = document.createElement("option");
        you.value = "you";
        you.textContent = "You";
        sel.appendChild(you);
        const open = document.createElement("option");
        open.value = "open";
        open.textContent = "Open seat";
        sel.appendChild(open);
        for (const d of DIFFICULTIES) {
          const o = document.createElement("option");
          o.value = "ai:" + d;
          o.textContent = "AI · " + d.charAt(0).toUpperCase() + d.slice(1);
          sel.appendChild(o);
        }
        sel.value = seatKind[i] === "open" ? "open" : "ai:" + difficulty[i];
        sel.addEventListener("change", () => {
          if (sel.value === "you") return playAs(i);
          if (sel.value === "open") seatKind[i] = "open";
          else { seatKind[i] = "ai"; difficulty[i] = sel.value.slice(3); }
          $("start-btn").textContent = seatKind.includes("open") ? "Create table" : "Start game";
        });
        row.append(sel);
      }
      rows.appendChild(row);
    }
    $("start-btn").textContent = seatKind.includes("open") ? "Create table" : "Start game";
  }

  function randomSeed() { $("seed-input").value = Math.floor(Math.random() * 1000000); }

  for (const t of TURN_TIMES) {
    const o = document.createElement("option");
    o.value = t.key;
    o.textContent = t.label;
    $("turn-time").appendChild(o);
  }
  $("turn-time").value = DEFAULT_TURN_TIME;
  renderSeats();
  randomSeed();
  $("seed-random").addEventListener("click", randomSeed);

  $("start-btn").addEventListener("click", async () => {
    const err = $("new-game-error");
    err.textContent = "";
    const seats = Array.from({ length: SEATS }, (_, i) =>
      i === mine ? { kind: "human" } : seatKind[i] === "open" ? { kind: "open" } : { kind: "ai", difficulty: difficulty[i] });
    // The seed as typed, or none (the server draws one). Number() reads "1e5"
    // as 100000 where parseInt read 1; anything not a whole number in range is
    // said, not swapped for another seed.
    const input = $("seed-input");
    const body = { seats, turnTime: $("turn-time").value };
    if (input.validity.badInput) { err.textContent = "The seed is a whole number."; return; }
    if (input.value.trim() !== "") {
      const seed = Number(input.value);
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
        err.textContent = "The seed is a whole number from 0 to 4294967295.";
        return;
      }
      body.seed = seed;
    }
    try {
      const data = await api("POST", "/api/games", body);
      if (data.status === "active") location.href = "/game.html?id=" + data.id;
      else refresh();
    } catch (e) {
      err.textContent = e.message;
    }
  });

  // ---- lists ----

  const who = (s) => (s.kind === "human" ? s.username : s.kind === "ai" ? "AI" : "open");

  // A game's one-line status: who is to play, or how it ended.
  function describe(g) {
    if (g.status === "lobby") {
      const open = g.seats.filter((s) => s.kind === "open").length;
      return open ? `waiting for ${open} more` : "ready to start";
    }
    if (g.status === "finished") {
      const w = g.seats[g.winnerSeat];
      return w ? `${w.civ} won` : "finished";
    }
    if (g.status === "aborted") return "abandoned";
    const s = g.seats[g.currentSeat];
    if (g.currentSeat === g.mySeat) return "your turn";
    return s ? `${s.civ}${s.kind === "human" ? " (" + s.username + ")" : " (AI)"} to play` : "";
  }

  // The four seats of a game as small chips, with a Join button on open ones
  // when the viewer can take one.
  function seatChips(g, canJoin) {
    const wrap = el("span", "seat-chips");
    for (const s of g.seats) {
      const chip = el("span", "chip " + s.kind);
      // A person's name links to their profile.
      chip.append(swatch(s.seat), s.kind === "human" && s.userId != null ? playerLink(s.userId, s.username) : el("span", null, who(s)));
      if (s.kind === "human" && s.seat === g.mySeat) chip.classList.add("me");
      if (s.kind === "open" && canJoin) {
        const b = el("button", "chip-btn", "Join");
        b.addEventListener("click", () => act(`/api/games/${g.id}/seats/${s.seat}/join`));
        chip.appendChild(b);
      }
      wrap.appendChild(chip);
    }
    return wrap;
  }

  async function act(path, method = "POST") {
    try { await api(method, path); refresh(); }
    catch (e) { alert(e.message); }
  }

  function tableControls(g) {
    const box = el("span", "controls");
    if (me && g.hostId === me.id) {
      const start = el("button", "primary", g.seats.some((s) => s.kind === "open") ? "Start anyway" : "Start");
      start.title = "Open seats left are played by the server";
      start.addEventListener("click", async () => {
        try { await api("POST", `/api/games/${g.id}/start`); location.href = "/game.html?id=" + g.id; }
        catch (e) { alert(e.message); }
      });
      const cancel = el("button", "danger", "Cancel");
      cancel.addEventListener("click", () => { if (confirm("Cancel this table?")) act(`/api/games/${g.id}`, "DELETE"); });
      box.append(start, cancel);
    } else if (g.mySeat !== null) {
      const leave = el("button", null, "Leave");
      leave.addEventListener("click", () => act(`/api/games/${g.id}/seats/${g.mySeat}/leave`));
      box.appendChild(leave);
    }
    return box;
  }

  function gameRow(g, { canJoin = false, link = true } = {}) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const head = el("div", "row-head");
    head.append(el("span", "name", `Game #${g.id}`), el("span", "muted small", describe(g)));
    if (g.status === "active" && g.currentSeat === g.mySeat) head.appendChild(el("span", "tag you", "your turn"));
    if (g.status === "lobby") head.appendChild(el("span", "tag", "table"));
    main.append(head, seatChips(g, canJoin));
    row.appendChild(main);
    if (g.status === "lobby") row.appendChild(tableControls(g));
    else if (link) {
      const links = el("span", "controls");
      const open = el("a", "button-link", g.status === "active" ? (g.mySeat !== null ? "Play" : "Watch") : "View");
      open.href = "/game.html?id=" + g.id;
      links.appendChild(open);
      // Replays open once a game is over (the server refuses them before).
      if (g.status !== "active") {
        const replay = el("a", "button-link", "Replay");
        replay.href = "/replay.html?id=" + g.id;
        links.appendChild(replay);
      }
      row.appendChild(links);
    }
    return row;
  }

  function fill(listId, countId, games, empty, opts) {
    const list = $(listId);
    list.innerHTML = "";
    $(countId).textContent = games.length ? `(${games.length})` : "";
    if (!games.length) { list.appendChild(el("p", "muted empty", empty)); return; }
    for (const g of games) list.appendChild(gameRow(g, typeof opts === "function" ? opts(g) : opts));
  }

  // One refresh at a time. A call while one is in flight (a lobby:changed, the
  // user becoming known) may carry news the running fetch missed, so it is
  // remembered and the lists are fetched once more when that one is done.
  let refreshing = false;
  let again = false;
  async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      do {
        again = false;
        await load();
      } while (again);
    } finally {
      refreshing = false;
    }
  }

  async function load() {
    try {
      const [mine, open, live] = await Promise.all([
        api("GET", "/api/games"), api("GET", "/api/games/open"), api("GET", "/api/games/live"),
      ]);
      const myTurn = mine.filter((g) => g.status === "active" && g.currentSeat === g.mySeat);
      $("turn-panel").hidden = !myTurn.length;
      fill("turn-list", "games-count", myTurn, "", { link: true });
      fill("open-list", "open-count", open, "No open tables. Create one below.", (g) => ({ canJoin: g.mySeat === null }));
      fill("games-list", "games-count", mine, "No games yet. Start one above.", { link: true });
      fill("live-list", "live-count", live.filter((g) => g.mySeat === null), "Nothing being played right now.", { link: true });
    } catch (e) {
      $("games-list").innerHTML = "";
      $("games-list").appendChild(el("p", "muted empty", "Could not load the lists."));
    }
  }

  function renderPresence(users) {
    const list = $("online-list");
    list.innerHTML = "";
    $("online-count").textContent = users.length ? `(${users.length})` : "";
    for (const u of users) {
      const row = el("div", "row small");
      row.appendChild(playerLink(u.userId, u.username, { cls: "name player-link" }));
      list.appendChild(row);
    }
  }

  // ---- turn alerts ----

  const notifyBtn = $("notify-btn");
  function renderNotifyButton() {
    if (!("Notification" in window)) { notifyBtn.hidden = true; $("notify-text").textContent = "This browser has no notifications."; return; }
    const p = Notification.permission;
    notifyBtn.hidden = p !== "default";
    if (p === "granted") $("notify-text").textContent = "Notifications are on for this browser.";
    if (p === "denied") $("notify-text").textContent = "Notifications are blocked in this browser's settings.";
  }
  notifyBtn.addEventListener("click", async () => {
    await Notification.requestPermission();
    renderNotifyButton();
  });
  renderNotifyButton();

  function yourTurn(info) {
    refresh();
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification("LorCiv — your turn", { body: `Game #${info.gameId} is waiting for you.` });
      n.onclick = () => { window.focus(); location.href = "/game.html?id=" + info.gameId; };
    }
  }

  // ---- socket ----

  const conn = document.getElementById("connStatus");
  const socket = connectSocket({
    onConnect: () => { socket.emit("lobby:enter"); refresh(); if (conn) { conn.textContent = "●"; conn.className = "conn-dot ok"; } },
    onDisconnect: () => { if (conn) { conn.textContent = "●"; conn.className = "conn-dot bad"; } },
    onError: (err) => { if (String(err && err.message).includes("unauthorized")) location.replace("/login.html"); },
  });
  socket.on("lobby:changed", refresh);
  socket.on("lobby:presence", renderPresence);
  socket.on("turn:yours", yourTurn);
  socket.on("achievements:earned", (list) => AchievementToast.show(list));

  window.addEventListener("user:known", (e) => { me = e.detail; refresh(); });
})();
