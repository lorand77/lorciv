"use strict";

// The app chrome: a top bar and the left navigation rail, built on every
// signed-in page that includes this file. There is no templating in this
// project, so the alternative was pasting the same markup into every HTML file
// and keeping them in sync by hand — this keeps the navigation in one place.
//
// Load it BEFORE authGuard.js. It relocates the page's existing #userbar into
// the top bar rather than making a second one, so authGuard still finds it by
// id when its /api/me request comes back.
//
// The profile's tabs are listed under My Profile as sub-items, on every page,
// so any of them is one click away. They are plain links to the tab's hash;
// profile.js does the switching. On a phone the rail is a single row with no
// room for nesting, so styles.css hides them there and the profile page keeps
// its own tab bar.

(function () {
  const ITEMS = [
    { href: "/lobby.html", icon: "⬡", label: "Play" },
    { href: "/profile.html", icon: "👤", label: "My Profile", children: [
      { tab: "stats", icon: "📊", label: "Stats" },
      { tab: "games", icon: "📜", label: "My Games" },
      { tab: "friends", icon: "👥", label: "Friends" },
    ] },
    { href: "/customize.html", icon: "🎨", label: "Customize" },
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
  // Someone else's profile is not "yours": keep the Profile rail item as a link
  // back to your own.
  const someoneElses = here === "/profile.html" && new URLSearchParams(location.search).has("id");
  let ownProfile = here === "/profile.html" && !someoneElses;
  for (const item of ITEMS) {
    const current = here === item.href && !(item.children && someoneElses);
    // The page you are on is not a link to itself.
    const node = el(current ? "span" : "a", "rail-item" + (current ? " current" : ""));
    if (current) node.setAttribute("aria-current", "page");
    else node.href = item.href;
    if (item.children) node.classList.add("rail-parent");
    node.append(el("span", "rail-icon", item.icon), el("span", "rail-label", item.label));
    rail.appendChild(node);
    // Sub-items stay links even when current: switching tabs only changes the
    // hash, and swapping elements on every hashchange buys nothing.
    for (const sub of item.children || []) {
      const a = el("a", "rail-item rail-sub");
      a.href = item.href + "#" + sub.tab;
      a.dataset.tab = sub.tab;
      a.append(el("span", "rail-icon", sub.icon), el("span", "rail-label", sub.label));
      rail.appendChild(a);
    }
  }

  // On your own profile, highlight the open tab. An unknown or empty hash is
  // the first tab, as in profile.js.
  function markProfileTab() {
    if (!ownProfile) return;
    const subs = rail.querySelectorAll(".rail-sub");
    const key = location.hash.slice(1);
    const open = Array.prototype.some.call(subs, (a) => a.dataset.tab === key) ? key : subs[0].dataset.tab;
    for (const a of subs) {
      const on = a.dataset.tab === open;
      a.classList.toggle("current", on);
      if (on) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  }
  markProfileTab();
  window.addEventListener("hashchange", markProfileTab);
  // Your own id in the URL is still your own profile. Who you are is only
  // known once authGuard's request comes back, so the rail corrects itself then.
  window.addEventListener("user:known", (e) => {
    if (!someoneElses) return;
    if (new URLSearchParams(location.search).get("id") !== String(e.detail.id)) return;
    const link = rail.querySelector('a.rail-item[href="/profile.html"]');
    if (!link) return;
    const current = el("span", "rail-item rail-parent current");
    current.setAttribute("aria-current", "page");
    current.append(...link.childNodes);
    link.replaceWith(current);
    ownProfile = true;
    markProfileTab();
  });
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
