"use strict";

// "Achievement unlocked" toasts, from LorChess. The server sends each record
// fully described ({ icon, name, tierName, desc, upgraded }), so this needs no
// catalogue. Loaded by the game page and the lobby, which call
// AchievementToast.show(list) on `achievements:earned`; each toast links to the
// profile's Achievements tab. Styled by css/toast.css.

const AchievementToast = (function () {
  const SHOW_MS = 7000;
  let host = null;

  function container() {
    if (host) return host;
    host = document.createElement("div");
    host.className = "ach-toasts";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  function show(list) {
    if (!Array.isArray(list) || !list.length) return;
    list.forEach((a, i) => setTimeout(() => one(a), i * 600));
  }

  function one(a) {
    const box = document.createElement("a");
    box.className = "ach-toast";
    box.href = "/profile.html#achievements";
    box.title = "See all achievements";

    const icon = document.createElement("span");
    icon.className = "ach-toast-icon";
    icon.textContent = a.icon || "🏅";

    const body = document.createElement("span");
    body.className = "ach-toast-body";
    const head = document.createElement("span");
    head.className = "ach-toast-head";
    // "Upgraded" only when a lower tier was already held; a first award that
    // lands straight on a higher tier is still an unlock.
    head.textContent = a.upgraded ? "Achievement upgraded" : "Achievement unlocked";
    const name = document.createElement("span");
    name.className = "ach-toast-name";
    name.textContent = a.name + (a.tierName ? " · " + a.tierName : "");
    const desc = document.createElement("span");
    desc.className = "ach-toast-desc";
    desc.textContent = a.desc || "";
    body.append(head, name, desc);
    box.append(icon, body);

    container().appendChild(box);
    requestAnimationFrame(() => box.classList.add("show"));
    setTimeout(() => {
      box.classList.remove("show");
      setTimeout(() => box.remove(), 400);
    }, SHOW_MS);
  }

  return { show };
})();
