"use strict";

// The profile's Friends tab: requests to answer, then your friends and the
// requests you sent. Friendships come from /api/friends (REST); the socket
// only brings a `friends:changed` nudge to refetch, and opens the first time
// the tab is shown, not with the page. LorChess's challenges and online badges
// are not here: inviting a friend to a table is for later.
//
// On someone else's profile it is only their list of friends (no requests),
// from /api/friends/user/:id.

(window.profileTabs = window.profileTabs || {}).friends = function ({ you, userId }) {
  const listEl = document.getElementById("friend-list");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.addEventListener("click", onClick);
    return b;
  }
  function personRow(f, tag) {
    const row = el("div", "row");
    const who = el("span", "row-main row-inline");
    who.appendChild(playerLink(f.userId, f.username, { cls: "name player-link" }));
    if (tag) who.appendChild(el("span", "tag pending", tag));
    row.appendChild(who);
    return row;
  }

  if (!you) return visitorList();

  document.getElementById("friends-own").hidden = false;
  const reqsEl = document.getElementById("friend-requests");
  const errorEl = document.getElementById("friends-error");

  function showError(msg) {
    errorEl.textContent = msg || "";
    if (msg) setTimeout(() => { errorEl.textContent = ""; }, 4000);
  }

  const socket = connectSocket();
  socket.on("friends:changed", refresh);

  async function refresh() {
    try {
      await Friends.load();
    } catch (e) {
      /* keep the last known list on screen */
    }
    render();
  }

  // Run a Friends change; the server's friends:changed nudge refetches, but
  // refetch here too so the page is right even with the socket down.
  function act(promise) {
    promise.catch((err) => showError(err.message)).then(refresh);
  }

  function render() {
    const { friends, incoming, outgoing } = Friends.state;

    reqsEl.innerHTML = "";
    for (const r of incoming) {
      const row = el("div", "row request-row");
      const text = el("span", "row-main row-inline");
      text.appendChild(playerLink(r.userId, r.username, { cls: "name player-link" }));
      text.appendChild(document.createTextNode(" wants to be friends"));
      row.append(text,
        button("Accept", "primary", () => act(Friends.accept(r.id))),
        button("Decline", "", () => act(Friends.decline(r.id))));
      reqsEl.appendChild(row);
    }

    listEl.innerHTML = "";
    for (const f of friends) {
      const row = personRow(f);
      row.appendChild(button("Remove", "", () => {
        if (confirm("Remove " + f.username + " from your friends?")) act(Friends.remove(f.id));
      }));
      listEl.appendChild(row);
    }
    for (const r of outgoing) {
      const row = personRow(r, "request sent");
      row.appendChild(button("Withdraw", "", () => act(Friends.remove(r.id))));
      listEl.appendChild(row);
    }

    if (!friends.length && !outgoing.length && !incoming.length) {
      listEl.appendChild(el("p", "muted empty", "No friends yet."));
    }
  }

  refresh();

  async function visitorList() {
    listEl.textContent = "Loading…";
    let friends;
    try {
      const res = await fetch("/api/friends/user/" + encodeURIComponent(userId), { credentials: "same-origin" });
      if (res.status === 401) { location.replace("/login.html"); return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      friends = (await res.json()).friends;
    } catch (e) {
      listEl.textContent = "Failed to load friends.";
      return;
    }
    listEl.innerHTML = "";
    if (!friends.length) {
      listEl.appendChild(el("p", "muted empty", "No friends yet."));
      return;
    }
    for (const f of friends) listEl.appendChild(personRow(f));
  }
};
