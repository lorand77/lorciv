"use strict";

// The profile page: whose it is, then three tabs: Stats, My Games, Friends
// (LorChess's profile without Achievements). ?id=<userId> shows someone
// else's, with the Games and Friends tabs read-only and a friend control under
// the name.
//
// Each tab's script (stats.js, history.js, friendsPage.js) registers a
// function in window.profileTabs; this runs it the first time that tab is
// shown, so opening the page doesn't also fetch a game list or open the
// friends socket nobody asked for. The tab lives in the URL hash, so tabs can
// be linked to and back/forward moves between them.
//
// On your own profile the tabs are also listed in the left rail (shell.js), so
// the page's tab bar is marked .in-rail and styles.css hides it wherever the
// rail has room for them. Someone else's profile keeps it: the rail's links go
// to your own tabs, not theirs.

(function () {
  const id = new URLSearchParams(location.search).get("id");
  const nameEl = document.getElementById("profile-name");
  const metaEl = document.getElementById("profile-meta");
  const errEl = document.getElementById("profile-error");
  const tabsEl = document.getElementById("profile-tabs");
  const tabs = window.profileTabs || {};
  const started = {};
  let ctx;

  const fmtDate = (s) => {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? "" : d.toLocaleDateString();
  };

  // The stats payload carries the user and whether they are you, which the
  // header and the choice of tabs both need, so it is fetched here, once, and
  // handed to the Stats tab rather than fetched again there.
  async function load() {
    let data;
    try {
      const res = await fetch("/api/stats" + (id ? "/" + encodeURIComponent(id) : ""),
        { credentials: "same-origin" });
      if (res.status === 401) { location.replace("/login.html"); return; }
      if (res.status === 404 || res.status === 400) { errEl.textContent = "No such player."; return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      errEl.textContent = "Couldn't load that profile.";
      return;
    }

    const u = data.user;
    const you = data.you !== false;
    // Your own id in the URL is still your own profile.
    ctx = { data, you, userId: u.id };

    nameEl.textContent = u.username;
    document.title = "LorCiv — " + u.username;
    metaEl.textContent = "Joined " + fmtDate(u.createdAt);
    for (const s of document.querySelectorAll("[data-them]")) s.textContent = you ? s.dataset.you : s.dataset.them;
    if (!you) renderFriendControl(u);

    tabsEl.classList.toggle("in-rail", you);
    tabsEl.hidden = false;
    show();
    window.addEventListener("hashchange", show);
  }

  // Someone else's profile: Add friend, Requested, Accept or Friends. It needs
  // to know who you are, which authGuard may not have answered yet.
  function renderFriendControl(u) {
    const actions = document.getElementById("profile-actions");
    const draw = () => {
      actions.innerHTML = "";
      actions.appendChild(Friends.button(u.id, draw, {
        onError: (msg) => { errEl.textContent = msg || ""; },
      }));
      actions.hidden = false;
    };
    const start = () => Friends.load().then(draw).catch(() => { /* the profile works fine without it */ });
    if (window.currentUser) start();
    else window.addEventListener("user:known", start, { once: true });
  }

  function show() {
    let key = location.hash.slice(1);
    if (!tabsEl.querySelector(`[data-tab="${CSS.escape(key)}"]`)) key = "stats";

    for (const a of tabsEl.querySelectorAll("[data-tab]")) {
      const on = a.dataset.tab === key;
      a.classList.toggle("current", on);
      a.setAttribute("aria-selected", String(on));
    }
    for (const panel of document.querySelectorAll(".profile-tab")) {
      panel.hidden = panel.id !== "tab-" + key;
    }

    if (!started[key] && tabs[key]) {
      started[key] = true;
      tabs[key](ctx);
    }
  }

  load();
})();
