"use strict";

// Drives login.html: posts to /api/login or /api/register, then redirects into
// the app on success. On 4xx it shows the server's error message.

const form = document.getElementById("authForm");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const errorEl = document.getElementById("error");
const messageEl = document.getElementById("message");

// Where to go once authenticated — the lobby (the realtime hub).
const AFTER_AUTH = "/lobby.html";

// If already signed in, skip the form.
fetch("/api/me", { credentials: "same-origin" }).then((r) => {
  if (r.ok) location.replace(AFTER_AUTH);
});

function setBusy(busy) {
  loginBtn.disabled = busy;
  registerBtn.disabled = busy;
}

async function submit(endpoint) {
  errorEl.textContent = "";
  messageEl.textContent = "";
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    errorEl.textContent = "Enter a username and password.";
    return;
  }
  setBusy(true);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || "Something went wrong.";
      return;
    }
    // Success → session cookie is set; enter the app.
    location.href = AFTER_AUTH;
  } catch (err) {
    errorEl.textContent = "Network error — is the server running?";
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submit("/api/login");
});
registerBtn.addEventListener("click", () => submit("/api/register"));
