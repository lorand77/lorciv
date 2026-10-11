"use strict";

// The Customize page: the colour scheme, dark or light. A choice is applied at
// once and saved straight away (PUT /api/settings); if the save fails, the
// page goes back to what the server holds. Named customize.js because
// /js/settings.js is the engine's settings catalogue (src/shared/settings.js).

(function () {
  const radios = document.querySelectorAll('input[name="scheme"]');
  const msg = document.getElementById("settings-msg");

  function check(scheme) {
    for (const r of radios) r.checked = r.value === scheme;
  }

  function say(text, ok) {
    msg.textContent = text;
    msg.className = "settings-msg " + (ok ? "ok" : "bad");
  }

  check(Theme.current.scheme);
  // theme.js fetches the saved settings as the page loads; follow its answer.
  window.addEventListener("theme:changed", (e) => check(e.detail.scheme));

  for (const r of radios) {
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      const previous = Theme.current;
      Theme.apply({ ...previous, scheme: r.value });
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheme: r.value }),
        });
        if (res.status === 401) { location.replace("/login.html"); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not save.");
        Theme.set(data);
        say("Saved.", true);
      } catch (e) {
        Theme.apply(previous);
        say(e.message === "Failed to fetch" ? "Could not reach the server." : e.message, false);
      }
    });
  }
})();
