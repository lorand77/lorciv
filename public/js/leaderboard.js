"use strict";

// The leaderboard page: /api/leaderboard rendered as a table. Names link to
// profiles; once authGuard says who you are, your own row is marked and every
// other row gets a friend control (Add / Requested / Accept / Friends).

(function () {
  const content = document.getElementById("lb-content");
  const errorEl = document.getElementById("lb-error");
  let rows = null;
  let friendsReady = false;

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

  function render() {
    if (!rows) return;
    content.innerHTML = "";
    if (!rows.length) { content.appendChild(el("p", "muted", "No finished games yet.")); return; }
    const table = el("table", "lb-table");
    const head = el("tr");
    for (const h of ["#", "Player", "Games", "Wins", "Win rate", ""]) head.appendChild(el("th", null, h));
    table.appendChild(head);
    const me = window.currentUser;
    rows.forEach((r, i) => {
      const tr = el("tr", me && me.id === r.id ? "me" : "");
      const name = el("td", "name");
      name.appendChild(playerLink(r.id, r.username));
      const friend = el("td", "friend-cell");
      if (friendsReady) friend.appendChild(Friends.button(r.id, render, { compact: true, onError: showError }));
      tr.append(el("td", "num", String(i + 1)), name,
        el("td", "num", String(r.games)), el("td", "num", String(r.wins)),
        el("td", "num", r.games ? Math.round(100 * r.wins / r.games) + "%" : "—"), friend);
      table.appendChild(tr);
    });
    content.appendChild(table);
  }

  fetch("/api/leaderboard", { credentials: "same-origin" })
    .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
    .then((data) => { rows = data; render(); })
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
