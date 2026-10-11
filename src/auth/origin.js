"use strict";

// Refuses requests that a page on another site made with the user's cookie.
// The session cookie is SameSite=Lax, which stops other *sites* but not other
// hosts of the same site: lorchess.lorand77.dev and lorciv.lorand77.dev are
// one site to a browser, so a script on any *.lorand77.dev page could open a
// socket to LorCiv or post a form to it as the signed-in user. WebSockets and
// body-less form posts are not covered by CORS, so the server checks itself.
//
// The check: when a browser says where a request comes from (the Origin
// header, which it always sends on a WebSocket handshake and on a POST, and
// which a page cannot set), that origin's host must be the host the request
// was sent to. Comparing with Host needs no configured URL and works the same
// on localhost and behind Caddy, which passes Host through. A request with no
// Origin is not from another page (curl, the tests, a same-origin GET) and
// passes; "null", sent from sandboxed frames and the like, does not.

const log = require("../log");

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // "null" or garbage
  }
}

// REST: every request that can change something (anything but GET, HEAD and
// OPTIONS). Reads are left alone: another origin cannot see the answer anyway.
function requireSameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || sameOrigin(req)) return next();
  log.warn("auth.origin_refused", { via: "http", origin: req.headers.origin, method: req.method, path: req.path });
  return res.status(403).json({ error: "Requests from other sites are not accepted." });
}

// Socket.IO's allowRequest: run on every handshake, polling and WebSocket.
function allowSocketRequest(req, callback) {
  if (sameOrigin(req)) return callback(null, true);
  log.warn("auth.origin_refused", { via: "socket", origin: req.headers.origin });
  return callback("origin", false);
}

module.exports = { sameOrigin, requireSameOrigin, allowSocketRequest };
