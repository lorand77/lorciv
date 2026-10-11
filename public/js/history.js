"use strict";

// The profile's Games tab: every game and table the profile owner holds a
// seat in, newest activity first, with the civ they played, who else sat at
// the table, the result from their side and a link: Play or Watch while it
// runs, Replay once it is over. On someone else's profile the list is theirs
// and Play appears only where the viewer has a seat too.

(window.profileTabs = window.profileTabs || {}).games = async function ({ you, userId }) {
  const content = document.getElementById("history-content");
  const url = you ? "/api/games" : "/api/games/user/" + encodeURIComponent(userId);

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

  let games;
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.status === 401) { location.replace("/login.html"); return; }
    if (res.status === 404) { content.textContent = "No such player."; return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    games = await res.json();
  } catch (e) {
    content.textContent = "Failed to load games.";
    return;
  }

  content.innerHTML = "";
  if (!games.length) {
    const p = el("p", "muted", "No games yet. ");
    if (you) {
      const a = el("a", null, "Play one →");
      a.href = "/lobby.html";
      p.appendChild(a);
    }
    content.appendChild(p);
    return;
  }

  const wrap = el("div", "table-scroll");
  const table = el("table", "history-table");
  const head = el("tr");
  for (const h of ["Updated", "Game", you ? "You" : "As", "Seats", "Turn", "Result", ""]) head.appendChild(el("th", null, h));
  const thead = el("thead");
  thead.appendChild(head);
  const tbody = el("tbody");
  for (const g of games) tbody.appendChild(row(g));
  table.append(thead, tbody);
  wrap.appendChild(table);
  content.appendChild(wrap);

  function row(g) {
    const tr = el("tr");
    const res = outcome(g);
    const as = el("td");
    as.append(swatch(g.userSeat), " " + g.seats[g.userSeat].civ);
    const result = el("td", res.cls, res.text);
    tr.append(
      el("td", null, fmtDate(g.updatedAt)),
      el("td", null, "#" + g.id),
      as,
      seatsCell(g),
      el("td", "num", g.status === "lobby" ? "—" : String(g.turn)),
      result,
      action(g),
    );
    return tr;
  }

  // Everyone at the table: a person links to their profile; the owner's own
  // seat is outlined.
  function seatsCell(g) {
    const td = el("td");
    const chips = el("span", "seat-chips");
    for (const s of g.seats) {
      const chip = el("span", "chip " + s.kind);
      if (s.seat === g.userSeat) chip.classList.add("me");
      chip.appendChild(swatch(s.seat));
      if (s.userId != null) chip.appendChild(playerLink(s.userId, s.username));
      else chip.appendChild(el("span", null, s.kind === "ai" ? "AI" : "open"));
      chips.appendChild(chip);
    }
    td.appendChild(chips);
    return td;
  }

  // The result from the owner's side. A seat they left (or whose turns ran
  // out) is the AI's now; a win by that AI is not theirs.
  function outcome(g) {
    const handedOver = g.seats[g.userSeat].kind === "ai";
    if (g.status === "lobby") return { text: "Table", cls: "out-progress" };
    if (g.status === "aborted") return { text: "Abandoned", cls: "out-neutral" };
    if (g.status === "active") {
      if (handedOver) return { text: "Left", cls: "out-neutral" };
      if (g.currentSeat === g.userSeat) return { text: you ? "Your turn" : "Their turn", cls: "out-progress" };
      return { text: "In progress", cls: "out-progress" };
    }
    if (handedOver) return { text: "Left", cls: "out-neutral" };
    return g.winnerSeat === g.userSeat ? { text: "Won", cls: "out-win" } : { text: "Lost", cls: "out-loss" };
  }

  function action(g) {
    const td = el("td", "controls-cell");
    const link = (label, href) => {
      const a = el("a", "button-link", label);
      a.href = href;
      td.appendChild(a);
    };
    if (g.status === "lobby") link("Lobby", "/lobby.html");
    else if (g.status === "active") link(g.mySeat !== null ? "Play" : "Watch", "/game.html?id=" + g.id);
    else link("Replay", "/replay.html?id=" + g.id);
    return td;
  }

  // SQLite datetime('now') is UTC like "2026-06-26 13:35:07".
  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T") + "Z");
    if (isNaN(d)) return s;
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
};
