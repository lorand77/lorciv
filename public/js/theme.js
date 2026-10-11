"use strict";

// Applies the user's colour scheme, dark or light, on every page with the
// shell. styles.css keys the light palette off <html data-scheme="light">. The
// setting comes from GET /api/settings; a copy is kept in localStorage so the
// page paints in the right colours before that answer comes back, which is
// why this loads in <head>, before anything is drawn. The game and replay
// pages keep their own dark map colours (game.css) and do not load it.

window.Theme = (function () {
  // authGuard.js removes it on logout, from every page, this one or not.
  const CACHE_KEY = "lorciv.theme";
  const DEFAULTS = { scheme: "dark" };
  let current = { ...DEFAULTS };

  function apply(settings) {
    current = { ...DEFAULTS, ...(settings || {}) };
    if (current.scheme === "light") document.documentElement.dataset.scheme = "light";
    else delete document.documentElement.dataset.scheme;
    window.dispatchEvent(new CustomEvent("theme:changed", { detail: current }));
  }

  function cache(settings) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked */ }
  }

  // Apply and remember settings the server has confirmed (the Customize page
  // calls this after saving).
  function set(settings) {
    cache(settings);
    apply(settings);
  }

  async function load() {
    const res = await fetch("/api/settings", { credentials: "same-origin" });
    if (!res.ok) throw new Error("settings " + res.status);
    const s = await res.json();
    set(s);
    return s;
  }

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cached) apply(cached);
  } catch (e) { /* no cache */ }
  load().catch(() => { /* signed out or offline: the cached or default scheme stays */ });

  return { apply, set, load, get current() { return current; } };
})();
