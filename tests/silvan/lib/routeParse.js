'use strict';
// Pure text parsing for `ip route` output, used by R1's bounded cloud-disconnect
// case to verify (a) the blackhole route it added is actually present before it
// asserts on the outage, and (b) the self-removing guard (or its own cleanup)
// actually removed it afterwards -- rather than trusting the shell commands'
// exit codes alone, which can both report success while the route table
// disagrees (stale cache, a second route to the same prefix, etc.).
//
// No SSH, no gateway, no state: given the text `ip route show` (or
// `ip route show table all`) already printed, does it contain a blackhole
// route for this exact IP.

// `ip route` prints a blackhole route as a line starting with "blackhole "
// followed by the destination (a bare IP is shown as "<ip>" or "<ip>/32").
function hasBlackholeRoute(ipRouteOutput, ip) {
  const needle = String(ip || '').trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^blackhole\\s+' + escaped + '(/32)?(\\s|$)', 'm');
  return re.test(String(ipRouteOutput || ''));
}

// Extracts the first IPv4 address from arbitrary text. Deliberately NOT used
// to resolve a hostname from `nslookup`/`host` output: those print the
// resolver's OWN address first ("Server: 100.100.100.100"), and grabbing the
// first IPv4 in the whole text would silently resolve to the DNS SERVER
// instead of the queried host -- exactly the kind of mistake that must never
// reach an `ip route add blackhole` command. Kept for callers that already
// have host-scoped text (e.g. a single `getent hosts <host>` line, which has
// no such ambiguity).
function firstIpv4(text) {
  const m = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/.exec(String(text || ''));
  return m ? m[1] : null;
}

// Extracts the resolved IPv4 address from BusyBox/iputils `ping` output's own
// first line, e.g. "PING bovey.cloud (83.228.220.63): 56 data bytes" or the
// iputils spelling "PING bovey.cloud (83.228.220.63) 56(84) bytes of data.".
// This ties the address unambiguously to the HOSTNAME BEING PINGED (it is the
// parenthesized address right after that name), unlike nslookup/host output
// where the resolver's own address appears first and a naive "any IPv4 in the
// text" grab would return the wrong address. Returns null if the line is not
// in this shape (e.g. "ping: bad address 'x'" on a resolution failure).
function parsePingResolvedIp(pingOutput) {
  const m = /^PING\s+\S+\s+\((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/m.exec(String(pingOutput || ''));
  return m ? m[1] : null;
}

module.exports = { hasBlackholeRoute, firstIpv4, parsePingResolvedIp };
