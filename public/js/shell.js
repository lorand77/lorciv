"use strict";

// The app chrome: a top bar and the left navigation rail, built on every
// signed-in page that includes this file. There is no templating in this
// project, so the alternative was pasting the same markup into every HTML file
// and keeping them in sync by hand — this keeps the navigation in one place.
//
// Load it BEFORE authGuard.js. It relocates the page's existing #userbar into
// the top bar rather than making a second one, so authGuard still finds it by
// id when its /api/me request comes back.

(function () {
  const ITEMS = [
    { href: "/lobby.html", icon: "⬡", label: "Play" },
    { href: "/leaderboard.html", icon: "🏆", label: "Leaderboard" },
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const body = document.body;
  if (!body || body.classList.contains("has-shell")) return;

  // Everything already on the page becomes the main column. Scripts are left
  // where they are: moving them around achieves nothing and only risks
  // surprises with execution order.
  const existing = [];
  for (const node of Array.prototype.slice.call(body.childNodes)) {
    if (node.nodeType === 1 && node.tagName === "SCRIPT") continue;
    existing.push(node);
  }

  // --- top bar ---
  const topbar = el("header", "topbar");
  const brand = el("a", "brand", "⬡ LorCiv");
  brand.href = "/lobby.html";
  const right = el("div", "topbar-right");

  // Pages with a live socket fill this in; it stays hidden while empty, so
  // static pages don't advertise a connection they never make.
  const conn = el("span", "conn-dot pending");
  conn.id = "connStatus";
  conn.title = "Server connection";

  // Reuse the page's own userbar so authGuard's lookup still works.
  let userbar = document.getElementById("userbar");
  if (!userbar) {
    userbar = el("div", "userbar");
    userbar.id = "userbar";
  }
  right.append(conn, userbar);
  topbar.append(brand, right);

  // --- left rail ---
  const rail = el("nav", "app-rail");
  rail.setAttribute("aria-label", "Sections");
  const here = location.pathname.replace(/\/$/, "") || "/lobby.html";
  for (const item of ITEMS) {
    const current = here === item.href;
    // The page you are on is not a link to itself.
    const node = el(current ? "span" : "a", "rail-item" + (current ? " current" : ""));
    if (current) node.setAttribute("aria-current", "page");
    else node.href = item.href;
    node.append(el("span", "rail-icon", item.icon), el("span", "rail-label", item.label));
    rail.appendChild(node);
  }
  // Terms and privacy, pinned to the bottom of the rail. The pages themselves
  // carry no shell: they must be readable before anyone has an account.
  const legal = el("div", "rail-legal");
  for (const [href, label] of [["/terms.html", "Terms"], ["/privacy.html", "Privacy"]]) {
    const a = el("a", null, label);
    a.href = href;
    legal.appendChild(a);
  }
  rail.appendChild(legal);

  const main = el("div", "app-main");
  for (const node of existing) main.appendChild(node);

  body.insertBefore(main, body.firstChild);
  body.insertBefore(rail, main);
  body.insertBefore(topbar, rail);
  body.classList.add("has-shell");
})();
