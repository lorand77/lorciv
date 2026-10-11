"use strict";

// The profile's Stats tab: the headline numbers as stat tiles, the record as
// one part-to-whole bar, then the record by civilization and by company (alone
// against the AI, or with other people). profile.js has already fetched the
// data (it needs the user for the page header) and passes it in.

(window.profileTabs = window.profileTabs || {}).stats = function ({ data: d }) {
  // Won and lost are told apart by a label on every segment and a 2px gap, not
  // by hue alone (a red/green pair is hard for many to tell apart).
  const COLORS = { won: "#199e70", lost: "#e66767", abandoned: "#6b6b6b" };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A stat tile: the number leads, the label explains it.
  function tile(parent, value, label, cls) {
    const t = el("div", "stat-tile" + (cls ? " " + cls : ""));
    t.append(el("div", "stat-value", value), el("div", "stat-label", label));
    parent.appendChild(t);
  }

  const pct = (v) => (v == null ? "—" : Math.round(v) + "%");
  const r = d.record;

  const tiles = document.getElementById("record-stats");
  tile(tiles, String(r.played), "Played");
  tile(tiles, String(r.wins), "Won", "good");
  tile(tiles, String(r.losses), "Lost", "bad");
  tile(tiles, String(r.abandoned), "Abandoned");
  tile(tiles, pct(r.winRate), "Win rate");
  tile(tiles, String(d.inProgress), "In progress");

  recordBar(document.getElementById("record-bar"), r);

  function rows(tbody, list) {
    for (const [label, rec, color] of list) {
      const tr = el("tr");
      const first = el("td");
      if (color) {
        const sw = el("span", "swatch");
        sw.style.background = color;
        first.append(sw, " ");
      }
      first.append(label);
      tr.appendChild(first);
      for (const v of [rec.played, rec.wins, rec.losses, rec.abandoned, pct(rec.winRate)]) {
        tr.appendChild(el("td", null, String(v)));
      }
      tbody.appendChild(tr);
    }
  }
  rows(document.getElementById("civ-rows"), d.byCiv.map((c) => [c.civ, c, PLAYER_COLORS[c.seat]]));
  rows(document.getElementById("company-rows"), [
    ["AI only", d.solo],
    ["Other people", d.withPeople],
  ]);

  function recordBar(container, rec) {
    container.innerHTML = "";
    if (!rec.played) {
      container.appendChild(el("p", "muted small", "No counted games yet."));
      return;
    }
    const parts = [[rec.wins, "won", COLORS.won], [rec.losses, "lost", COLORS.lost], [rec.abandoned, "abandoned", COLORS.abandoned]];
    const bar = el("div", "record-bar");
    const key = el("div", "record-key");
    for (const [n, label, colour] of parts) {
      if (n) {
        const seg = el("div", "record-seg");
        seg.style.flexGrow = String(n);
        seg.style.background = colour;
        seg.title = n + " " + label;
        bar.appendChild(seg);
      }
      const item = el("span", "record-key-item");
      const sw = el("i");
      sw.style.background = colour;
      item.append(sw, el("span", null, n + " " + label));
      key.appendChild(item);
    }
    container.append(bar, key);
  }
};
