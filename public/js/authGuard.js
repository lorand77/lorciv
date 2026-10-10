"use strict";

// Page guard for authenticated pages. Loaded before the page's own scripts:
// if /api/me returns 401, bounce to the login page; otherwise expose the user
// as window.currentUser, render the user bar + logout button, and dispatch a
// "user:known" event on window for scripts that ran before the answer came.
//
// Note: this is a UX redirect, not a security boundary. All privileged actions
// are enforced server-side (requireAuth on the API, and authoritative socket
// checks). The page may flash briefly before the redirect — acceptable.

(function () {
  // Only a 401 means "not signed in". Anything else — the server restarting,
  // a proxy error page, a dropped connection — is retried a few times, then the
  // user bar says so and offers a retry. Nobody is sent to the login page for
  // a blip.
  const RETRY_MS = [500, 1000, 2000, 4000];
  function check(attempt) {
    fetch("/api/me", { credentials: "same-origin" })
      .then((res) => {
        if (res.status === 401) {
          location.replace("/login.html");
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((user) => {
        if (!user) return;
        window.currentUser = user;
        renderUserBar(user);
        window.dispatchEvent(new CustomEvent("user:known", { detail: user }));
      })
      .catch(() => {
        if (attempt < RETRY_MS.length) setTimeout(() => check(attempt + 1), RETRY_MS[attempt]);
        else renderUnreachable();
      });
  }
  check(0);

  function renderUnreachable() {
    const bar = document.getElementById("userbar");
    if (!bar) return;
    bar.innerHTML = "";
    const msg = document.createElement("span");
    msg.className = "who";
    msg.textContent = "Can't reach the server.";
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => check(0));
    bar.append(msg, retry);
  }

  function renderUserBar(user) {
    const bar = document.getElementById("userbar");
    if (!bar) return;
    bar.innerHTML = "";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = user.username;
    const logout = document.createElement("button");
    logout.textContent = "Log out";
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      location.href = "/login.html";
    });
    bar.append(who, logout);
  }
})();
