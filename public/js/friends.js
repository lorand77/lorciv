"use strict";

// Shared client for /api/friends plus a small widget that renders the right
// control for a given user: Add friend / Requested / Accept / Friends. Copied
// from LorChess. Pages call Friends.load() once, then Friends.button(userId,
// onChange) per user; every action refetches and invokes onChange so the
// caller re-renders. The socket's `friends:changed` nudge is the page's to
// hook: it calls load() and re-renders the same way.

window.Friends = (function () {
  let state = { friends: [], incoming: [], outgoing: [] };

  async function api(method, path, body) {
    const res = await fetch("/api/friends" + path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.replace("/login.html");
      throw new Error("Not logged in.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function load() {
    state = await api("GET", "");
    return state;
  }

  // What is my relationship to `userId`?
  function relation(userId) {
    const find = (list) => list.find((f) => f.userId === userId);
    let row;
    if ((row = find(state.friends))) return { kind: "friend", row };
    if ((row = find(state.incoming))) return { kind: "incoming", row };
    if ((row = find(state.outgoing))) return { kind: "outgoing", row };
    return { kind: "none", row: null };
  }

  const request = (userId) => api("POST", "/requests", { toUserId: userId });
  const accept = (id) => api("POST", "/requests/" + id + "/accept");
  const decline = (id) => api("POST", "/requests/" + id + "/decline");
  const remove = (id) => api("DELETE", "/" + id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Run an action, refetch, and hand control back to the page. Errors surface
  // via `opts.onError` (or a title tooltip on the widget as a fallback).
  function act(fn, wrap, onChange, opts) {
    for (const b of wrap.querySelectorAll("button")) b.disabled = true;
    fn()
      .then(load)
      .catch((err) => {
        if (opts.onError) opts.onError(err.message);
        else wrap.title = err.message;
      })
      .then(() => onChange && onChange());
  }

  // `compact` leaves out Remove next to a friend, for tables with a control
  // on every row (the leaderboard); the profile offers it.
  function button(userId, onChange, opts) {
    opts = opts || {};
    const wrap = el("span", "friend-ctl");
    const me = window.currentUser ? window.currentUser.id : null;
    if (userId == null || userId === me) return wrap;

    const btn = (label, cls, fn) => {
      const b = el("button", cls, label);
      b.addEventListener("click", () => act(fn, wrap, onChange, opts));
      wrap.appendChild(b);
    };

    const { kind, row } = relation(userId);
    if (kind === "friend") {
      wrap.appendChild(el("span", "tag friend", "✓ Friends"));
      if (!opts.compact) btn("Remove", "", () => remove(row.id));
    } else if (kind === "incoming") {
      btn("Accept friend", "primary", () => accept(row.id));
      btn("Decline", "", () => decline(row.id));
    } else if (kind === "outgoing") {
      wrap.appendChild(el("span", "tag pending", "Requested"));
      btn("Withdraw", "", () => remove(row.id));
    } else {
      btn("+ Add friend", "", () => request(userId));
    }
    return wrap;
  }

  return {
    load, relation, request, accept, decline, remove, button,
    get state() { return state; },
  };
})();
