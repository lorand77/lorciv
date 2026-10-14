"use strict";

// The leaderboard page: /api/leaderboard rendered as a table. Names link to
// profiles; once authGuard says who you are, your own row is marked and every
// other row gets a friend control (Add / Requested / Accept / Friends).
// Clicking a column header sorts by it, again to reverse; the sort is done
// here over the rows the server sent, and # stays each player's rank by wins.

(function () {
  const content = document.getElementById("lb-content");
  const errorEl = document.getElementById("lb-error");
  let rows = null;
  let friendsReady = false;

  // Each sortable column: its header, the value it sorts by and the first
  // direction (numbers high first, names A to Z). A null value (no win rate
  // without a game) goes last either way; ties keep the rank order.
  const COLUMNS = [
    { key: "rank", label: "#", value: (r) => r.rank, dir: 1 },
    { key: "player", label: "Player", value: (r) => r.username.toLowerCase(), dir: 1 },
    { key: "games", label: "Games", value: (r) => r.games, dir: -1 },
    { key: "wins", label: "Wins", value: (r) => r.wins, dir: -1 },
    { key: "rate", label: "Win rate", value: (r) => (r.games ? r.wins / r.games : null), dir: -1 },
  ];
  let sort = { key: "rank", dir: 1 };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showError(msg) {
    errorEl.textContent = msg || "";
    if (msg) setTimeout(() => { errorEl.textContent = ""; }, 4000);
  }

  function sorted() {
    const col = COLUMNS.find((c) => c.key === sort.key);
    return rows.slice().sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      if (x === y) return a.rank - b.rank;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }

  function sortBy(key) {
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: COLUMNS.find((c) => c.key === key).dir };
    render();
  }

  function headerCell(col) {
    const th = el("th");
    const on = sort.key === col.key;
    if (on) th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
    const btn = el("button", "sort-btn" + (on ? " on" : ""), col.label + (on ? (sort.dir > 0 ? " ▲" : " ▼") : ""));
    btn.type = "button";
    btn.addEventListener("click", () => sortBy(col.key));
    th.appendChild(btn);
    return th;
  }

  function render() {
    if (!rows) return;
    content.innerHTML = "";
    if (!rows.length) { content.appendChild(el("p", "muted", "No players yet.")); return; }
    const table = el("table", "lb-table");
    const head = el("tr");
    for (const col of COLUMNS) head.appendChild(headerCell(col));
    head.appendChild(el("th"));
    table.appendChild(head);
    const me = window.currentUser;
    sorted().forEach((r) => {
      const tr = el("tr", me && me.id === r.id ? "me" : "");
      const name = el("td", "name");
      name.appendChild(playerLink(r.id, r.username));
      const friend = el("td", "friend-cell");
      if (friendsReady) friend.appendChild(Friends.button(r.id, render, { compact: true, onError: showError }));
      tr.append(el("td", "num", String(r.rank)), name,
        el("td", "num", String(r.games)), el("td", "num", String(r.wins)),
        el("td", "num", r.games ? Math.round(100 * r.wins / r.games) + "%" : "—"), friend);
      table.appendChild(tr);
    });
    content.appendChild(table);
  }

  fetch("/api/leaderboard", { credentials: "same-origin" })
    .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
    .then((data) => { rows = data.map((r, i) => Object.assign({ rank: i + 1 }, r)); render(); })
    .catch(() => { content.innerHTML = ""; content.appendChild(el("p", "muted", "Could not load the leaderboard.")); });

  // Friend controls need to know who you are (yours has none) and your
  // friendships; a change made elsewhere arrives as friends:changed.
  async function loadFriends() {
    try {
      await Friends.load();
      friendsReady = true;
    } catch (e) { /* the table works without them */ }
    render();
  }
  window.addEventListener("user:known", loadFriends);
  if (window.currentUser) loadFriends();
  const socket = connectSocket();
  socket.on("friends:changed", loadFriends);
})();
