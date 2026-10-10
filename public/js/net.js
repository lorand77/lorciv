"use strict";

// Thin wrapper over the Socket.IO client. The session cookie is sent
// automatically on the same-origin handshake, so the server authenticates the
// socket against the same session as the REST API — no token needed here.
//
// Requires /socket.io/socket.io.js (served by the server) to be loaded first.
// Returns the socket; pass handlers for the lifecycle events you care about.

function connectSocket(handlers = {}) {
  // eslint-disable-next-line no-undef
  const socket = io({ withCredentials: true });

  socket.on("connect", () => handlers.onConnect && handlers.onConnect(socket));
  socket.on("welcome", (data) => handlers.onWelcome && handlers.onWelcome(data));
  socket.on("disconnect", (reason) => handlers.onDisconnect && handlers.onDisconnect(reason));
  // Fired when the handshake is rejected (e.g. unauthenticated) or transport fails.
  socket.on("connect_error", (err) => handlers.onError && handlers.onError(err));

  return socket;
}
