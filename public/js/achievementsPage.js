"use strict";

// The profile's Achievements tab: the whole catalogue (/js/achievements.js),
// grouped, with what this player has earned and, for the tiered ones, how far
// along the next tier they are. Locked achievements show too, greyed, so the
// tab reads the same on anyone's profile.

(window.profileTabs = window.profileTabs || {}).achievements = async function ({ you, userId }) {
  const content = document.getElementById("ach-content");
  const summary = document.getElementById("ach-summary");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // SQLite's datetime('now') is UTC, like "2026-10-12 13:35:07".
  const fmtDate = (s) => {
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? "" : d.toLocaleDateString();
  };

  let data;
  try {
    const res = await fetch("/api/achievements" + (you ? "" : "/" + encodeURIComponent(userId)),
      { credentials: "same-origin" });
    if (res.status === 401) { location.replace("/login.html"); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    summary.textContent = "Couldn't load the achievements.";
    return;
  }

  const earned = {};
  for (const e of data.earned) earned[e.key] = e;
  const got = ACHIEVEMENTS.filter((a) => earned[a.key]).length;
  const maxed = ACHIEVEMENTS.filter((a) => earned[a.key] && earned[a.key].tier >= maxTier(a)).length;
  summary.textContent = `${got} of ${ACHIEVEMENTS.length} unlocked · ${maxed} at the highest tier`;

  content.innerHTML = "";
  for (const g of ACHIEVEMENT_GROUPS) {
    const items = ACHIEVEMENTS.filter((a) => a.group === g.key);
    const panel = el("section", "panel");
    const h = el("h2", null, g.title + " ");
    h.appendChild(el("span", "count", `${items.filter((a) => earned[a.key]).length}/${items.length}`));
    panel.appendChild(h);
    const grid = el("div", "ach-grid");
    for (const a of items) grid.appendChild(card(a, earned[a.key]));
    panel.appendChild(grid);
    content.appendChild(panel);
  }

  function card(a, e) {
    const tier = e ? e.tier : 0;
    const max = maxTier(a);
    const c = el("div", "ach-card" + (e ? "" : " locked") + (e && tier >= max ? " maxed" : ""));
    c.appendChild(el("div", "ach-icon", a.icon));

    const body = el("div", "ach-body");
    body.appendChild(el("div", "ach-name", a.name));
    // The next tier's goal while there is one, else the tier held.
    body.appendChild(el("div", "ach-desc", describeAchievement(a, Math.min(tier + 1, max))));

    if (a.tiers) {
      const pips = el("div", "ach-tiers");
      a.tiers.forEach((n, i) => {
        const p = el("span", "ach-pip" + (i < tier ? " on" : ""));
        p.title = TIER_NAMES[i] + ": " + describeAchievement(a, i + 1);
        pips.appendChild(p);
      });
      const have = data.progress[a.key] ?? 0;
      const label = tier >= max ? TIER_NAMES[max - 1] : `${have} / ${a.tiers[tier]}`;
      pips.appendChild(el("span", "ach-tier-label", (tier && tier < max ? TIER_NAMES[tier - 1] + " · " : "") + label));
      body.appendChild(pips);
    }

    if (e) {
      const meta = el("div", "ach-meta muted small", "Earned " + fmtDate(e.earnedAt));
      if (e.gameId) {
        meta.appendChild(document.createTextNode(" · "));
        const link = el("a", null, "replay");
        link.href = "/replay.html?id=" + e.gameId;
        meta.appendChild(link);
      }
      body.appendChild(meta);
    }
    c.appendChild(body);
    return c;
  }
};
