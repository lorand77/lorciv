"use strict";

// Thin wrapper over the Socket.IO client. The session cookie is sent
// automatically on the same-origin handshake, so the server authenticates the
// socket against the same session as the REST API — no token needed here.
//
// Requires /socket.io/socket.io.js (served by the server) to be loaded first.
// Returns the socket; pass handlers for the lifecycle events you care about.
//
// A disconnect the server initiated ("io server disconnect": logout in another
// tab, an expired session, a deactivated account) is one Socket.IO never
// reconnects from by itself. Ask /api/me what happened: a 401 goes to the
// login page, anything else reconnects, and a refused handshake then lands in
// onError like any other.

function connectSocket(handlers = {}) {
  // eslint-disable-next-line no-undef
  const socket = io({ withCredentials: true });

  socket.on("connect", () => handlers.onConnect && handlers.onConnect(socket));
  socket.on("welcome", (data) => handlers.onWelcome && handlers.onWelcome(data));
  socket.on("disconnect", (reason) => {
    if (handlers.onDisconnect) handlers.onDisconnect(reason);
    if (reason === "io server disconnect") setTimeout(() => afterServerDisconnect(socket), 1000);
  });
  // Fired when the handshake is rejected (e.g. unauthenticated) or transport fails.
  socket.on("connect_error", (err) => handlers.onError && handlers.onError(err));

  return socket;
}

function afterServerDisconnect(socket) {
  fetch("/api/me", { credentials: "same-origin" })
    .then((res) => {
      if (res.status === 401) location.replace("/login.html");
      else socket.connect();
    })
    .catch(() => socket.connect());
}
