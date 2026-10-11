"use strict";

// The leaderboard page: /api/leaderboard rendered as a table, your own row
// marked once authGuard says who you are.

(function () {
  const content = document.getElementById("lb-content");
  let rows = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    if (!rows) return;
    content.innerHTML = "";
    if (!rows.length) { content.appendChild(el("p", "muted", "No finished games yet.")); return; }
    const table = el("table", "lb-table");
    const head = el("tr");
    for (const h of ["#", "Player", "Games", "Wins", "Win rate"]) head.appendChild(el("th", null, h));
    table.appendChild(head);
    const me = window.currentUser;
    rows.forEach((r, i) => {
      const tr = el("tr", me && me.id === r.id ? "me" : "");
      tr.append(el("td", "num", String(i + 1)), el("td", "name", r.username),
        el("td", "num", String(r.games)), el("td", "num", String(r.wins)),
        el("td", "num", r.games ? Math.round(100 * r.wins / r.games) + "%" : "—"));
      table.appendChild(tr);
    });
    content.appendChild(table);
  }

  fetch("/api/leaderboard", { credentials: "same-origin" })
    .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
    .then((data) => { rows = data; render(); })
    .catch(() => { content.innerHTML = ""; content.appendChild(el("p", "muted", "Could not load the leaderboard.")); });
  window.addEventListener("user:known", render);
})();
