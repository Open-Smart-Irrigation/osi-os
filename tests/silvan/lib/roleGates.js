'use strict';
// Pure, offline-testable classifiers for the two role-gate SHAPES osi-os#244
// and osi-os#263 put around OSI_SCOPED_ACCESS, used by A2 to prove -- from
// the gateway's OWN deployed function-node source, read read-only over SSH
// (never guessed, never assumed) -- what "role/permission denial" really
// means on Silvan today, where OSI_SCOPED_ACCESS is off by default.
//
// Why this exists instead of just calling the routes: POST /api/system/reboot
// cannot safely be probed for its role gate (calling it succeeds by actually
// rebooting the gateway), and there is no way to mint a second gateway
// account with role='admin' while scoped access is off (the public register
// route only ever assigns the schema default 'researcher' in that mode --
// verified 2026-09-17 against auth-db-insert in flows.json; the
// first-registrant-becomes-admin path only runs when OSI_SCOPED_ACCESS='1').
// Reading the deployed source and classifying its SHAPE proves the contract
// without ever exercising the dangerous side effect.
//
// Shape 1 -- an ADMIN ROUTER (the /api/users, /api/grants/* API) that 404s
// the ENTIRE route before any bearer/role check runs, whenever scoped access
// is off -- so the gate is on the FEATURE FLAG, not the caller's role or
// identity. Verified against flows.json node id `scoped-admin-account-router`
// (2026-09-17, this repo): its very first line is
//   if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') { return respond(404, ...
const ADMIN_ROUTER_GATE_RE =
  /if\s*\(\s*String\(env\.get\('OSI_SCOPED_ACCESS'\)\s*\|\|\s*''\)\s*!==\s*'1'\s*\)\s*\{\s*\n?\s*return\s+respond\(404/;

// Shape 2 -- a system WRITE route (Reboot / Fan Control) that verifies a
// bearer token unconditionally, but only asserts an admin ROLE when scoped
// access is on -- so with it off (Silvan's default), any authenticated user
// succeeds; there is no role distinction at all in the unscoped state.
// Verified against flows.json nodes `sys-reboot-fn` and `sys-fan-fn`
// (2026-09-17, this repo): each contains
//   const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
//   if (scopedOn) { ... await scopeLoad.value.assertAuthenticatedRole(roleDb, auth, 'admin', ...
const SCOPED_ONLY_ROLE_ASSERT_RE =
  /if\s*\(\s*scopedOn\s*\)\s*\{[\s\S]{0,600}?assertAuthenticatedRole\([\s\S]{0,160}?'admin'/;

function hasAdminRouterScopedGate(source) {
  return ADMIN_ROUTER_GATE_RE.test(String(source || ''));
}

function hasScopedOnlyRoleAssert(source) {
  return SCOPED_ONLY_ROLE_ASSERT_RE.test(String(source || ''));
}

module.exports = {
  ADMIN_ROUTER_GATE_RE, SCOPED_ONLY_ROLE_ASSERT_RE,
  hasAdminRouterScopedGate, hasScopedOnlyRoleAssert,
};
