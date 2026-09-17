'use strict';
// Which requests the browser in U1 may issue.
//
// A browser loads whatever the page asks it to: a font, a map tile, an
// analytics beacon -- or, if a stale bundle or a bad config points it there,
// another gateway. The endpoint guard in lib/config.js only covers the sockets
// this harness opens itself, so the smoke test pins every browser request to
// the origin of cfg.guiBase and records what it blocked. A missing tile in a
// screenshot then has an explanation in the evidence instead of being a
// mystery.
//
// data:, blob: and about: are allowed: they open no socket.

const INLINE_SCHEMES = ['data:', 'blob:', 'about:'];

// The origin ("http://127.0.0.1:18800") of a URL, or null if it has none.
function originOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch (_) {
    return null;
  }
}

// { allowed, reason }. The reason is written into the case evidence for every
// blocked request, so nothing is silently dropped.
function browserRequestDecision(url, allowedOrigin) {
  const raw = String(url == null ? '' : url);
  if (!raw) return { allowed: false, reason: 'empty request URL' };
  if (!allowedOrigin) return { allowed: false, reason: 'no allowed origin was configured for this run' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return { allowed: false, reason: 'unparseable request URL' };
  }
  if (INLINE_SCHEMES.includes(parsed.protocol)) {
    return { allowed: true, reason: 'inline ' + parsed.protocol + ' request; no socket is opened' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported scheme ' + parsed.protocol };
  }
  if (parsed.origin !== allowedOrigin) {
    return {
      allowed: false,
      reason: 'cross-origin request to ' + parsed.origin + '; this run\'s GUI origin is ' + allowedOrigin,
    };
  }
  return { allowed: true, reason: 'same origin as the GUI under test' };
}

module.exports = { browserRequestDecision, originOf, INLINE_SCHEMES };
