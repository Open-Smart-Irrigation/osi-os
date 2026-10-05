#!/usr/bin/env node
'use strict';

// Scoped-access ratchet (spec §5.4).
//
// Contract. For every HTTP entry of the maintained profiles (each `http in`
// node except CORS preflights), with scoped access on, a scope decision must be
// made on the entry's own path before any data is read or written, and when
// that decision says no the request must stop: nothing further is read or
// written and the caller gets an error answer. A scope decision is a call to
// one of the deciding functions of osi-scope-helper (assertFresh*Access,
// assertRole, assertFreshRole, assertEnabledAccount, assertAuthenticatedRole,
// authorizeAdminRead, isAdmin, canMutate, resolveScope), loaded through
// osiLib.require('scope') and made by the entry's guard or by a seam module the
// guard hands the helper to. A mention of the helper elsewhere in the chain
// does not count: many nodes load it only to resolve the token secret.
//
// How it is checked. scripts/lib/scope-guard-probe.js sends a request down
// each entry with every deciding function forced to say no, and records which
// node decided and what was read or written on the way. The old text search
// passed a route when any downstream node mentioned the helper, so removing a
// guard's own call went unnoticed (#389).
//
// Every entry the probe cannot run to a verdict fails, naming the entry. An
// entry is exempt only through one of the lists below, each entry with its
// reason; an exempt entry that the probe finds compliant fails as stale, so a
// list can only shrink when a guard lands.
//
// This is still a ratchet, not the correctness gate: the probe sees the one
// request it sends. The behavioural matrix (scripts/test-scoped-access-*.js)
// decides whether each decision is the right one.
const fs = require('node:fs');
const path = require('node:path');
const { probeEntry } = require('./lib/scope-guard-probe');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const DEFAULT_MODULES_ROOT = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red'
);

// Endpoints with no scoped data or Phase-A/public semantics (exact http-in ids).
const PUBLIC_ALLOWLIST = new Set([
  'auth-register-http',
  'auth-login-http',
  // Reports the caller's own role and scope; it reads the scope instead of
  // deciding on it, and answers 200 to every authenticated caller by design.
  'api-me-http',
  'history-system-features-http',
]);

// Phase B lands before write enforcement by design. These exact pre-existing
// mutation/effect routes are tracked debt, not general exemptions. Phase C
// removes each id as its scope guard lands; any newly-added route still fails,
// and an id whose guard has landed fails as stale until it is removed here.
// (sys-reboot-in and sys-fan-in left this list once each made its own admin
// decision before the effect.)
const PHASE_C_PENDING = new Set([
  'al-link-in',
  'al-unlink-in',
  'sync-force-http',
  'history-rollups-run-http',
  // Wave 3 scoped-access port: these routes don't exist anywhere in AgroLink's
  // scope arc (valve-control and SDI-12 landed on main after AgroLink's fork;
  // AgroLink itself never scoped them). Tracked debt, same discipline as the
  // rest of this list -- not a blanket exemption for the two features.
  // sdi12-config-http and sdi12-identify-http are guard reconciliation done:
  // both now route through scoped-device-config-guard (routeTable extended
  // with POST /sdi12/identify -> sdi12-identify-action-fn and PUT /sdi12/config
  // -> sdi12-config-auth-fn), matching AgroLink's own guard scope exactly.
  // sdi12-recipe-apply-http/sdi12-recipe-rollback-http stay pending: AgroLink's
  // own guard-extension commit (853c1b3584) never added routeTable entries for
  // the recipe apply/rollback routes either -- this is upstream's own scope,
  // not a gap introduced by this port.
  'sdi12-recipe-apply-http',
  'sdi12-recipe-rollback-http',
  'valve-list-get-http',
  'valve-schedules-get-http',
  'valve-schedules-post-http',
  'valve-schedule-put-http',
  'valve-schedule-delete-http',
  'valve-plan-resend-post-http',
  'valve-scheduler-status-post-http',
  'valve-settings-put-http',
  'sys-settings-get-in',
  'sys-settings-put-in',
]);

// Known gaps: entries the probe showed reading or writing without a scope
// decision that has to be there, found when this verifier learned to see the
// decision itself (#389). Each is a real gap, tracked as its own change; the
// entry leaves this list when its guard lands (the stale check enforces it).
// Placeholder until the tracking issue exists: #TBD-389-gaps.
const KNOWN_GAPS = new Map([
  [
    'improvement-requests-post-http',
    'POST /api/improvement-requests stores a request and its gateway diagnostics ' +
      'for any token holder, a disabled account included; it needs an enabled-account ' +
      'decision before it reads the diagnostics (#TBD-389-gaps)',
  ],
  [
    'journal-catalog-get-http',
    'GET /api/journal/catalog without a plot or zone filter answers a disabled ' +
      'account with the catalog and the custom terms of its own account; it needs the ' +
      'enabled-account decision the other journal reads make (#TBD-389-gaps)',
  ],
]);

// Entries whose decision is real but made without the helper, so the probe
// cannot see it. Each must refuse a disabled account: the verifier probes them
// with a disabled account's token and fails if the request reads or writes
// anything or gets a non-error answer. Moving the check onto the helper retires
// the entry (the stale check enforces it).
const INLINE_ACCOUNT_CHECKS = new Map([
  ...[
    'history-zone-cards-http',
    'history-zone-card-data-http',
    'history-zone-card-advanced-http',
    'history-zone-card-preferences-http',
    'history-zone-card-opened-http',
    'history-zone-export-csv-http',
    'history-workspaces-get-http',
    'history-workspaces-post-http',
    'history-workspaces-put-http',
    'history-workspaces-delete-http',
  ].map((id) => [
    id,
    'history-api-router-fn reads users.disabled_at itself (scopeCheckForRoute) and ' +
      'refuses a disabled account before any history read; zone history is ' +
      'account-wide by design (W1) and workspaces are filtered by owner',
  ]),
]);

// Entries that answer every caller with an error and read nothing, so there is
// nothing to decide on. The probe holds them to that: any read or write, or a
// success answer, fails. Implementing the route retires the entry.
const NO_DATA_ENTRIES = new Map([
  [
    'journal-export-adapt-get-http',
    'GET /api/journal/export.adapt.json answers 501 not_implemented after resolving ' +
      'the caller; it reads no journal data',
  ],
]);

// Entries that decide per row and leave denied rows out: when every row is
// denied the right answer is a success with an empty list, not an error. For
// these entries alone the probe accepts a success answer after a denial; it
// still fails on any read or write before the decision or after it.
const FILTERING_ENTRIES = new Map([
  [
    'network-api-http-0',
    'GET /api/network/observations calls assertFreshDeviceAccess for each device and ' +
      'returns observations only for the devices it allows; all denied gives an empty list',
  ],
]);

const ALLOWLIST = new Set([...PUBLIC_ALLOWLIST, ...PHASE_C_PENDING, ...KNOWN_GAPS.keys()]);

// Request inputs an entry needs to get past its own validation and reach its
// decision. Without them the guard answers 400 before deciding, which proves
// nothing; the probe then reports the entry as having no scope call.
const REQUEST_FIXTURES = {
  'sensor-history-http': { query: { field: 'swt_1', hours: '24' } },
  'improvement-requests-post-http': {
    body: {
      type: 'bug',
      severity: 'idea',
      area: 'other',
      title: 'Probe title',
      description: 'Probe description long enough',
      consent_public: true,
      consent_diagnostics: true,
    },
  },
};

// Link-in targets that a denied request may reach because they do not act on
// the request's data: they record that an error happened or nudge the sync
// outbox to flush. The probe stops at them.
const TERMINAL_LINK_INS = new Map([
  ['record-error-link-in', 'counts the error for the health report; reads no request data'],
  ['sync-outbox-flush-link-in', 'asks the outbox to flush what is already queued; adds nothing'],
]);

// Write-only scoping (W1): the read-filter API is retired. A route that
// reintroduces one of these calls is reintroducing read scoping, which the
// behavioral matrix would catch only if someone wrote the matching test.
const RETIRED_READ_FILTERS = [
  'assertZoneAccess',
  'assertPlotAccess',
  'assertDeviceAccess',
  'listScopeZoneUuids',
  'filterZoneUuids',
];

function findReadFilterRegressions(flows, profileLabel) {
  const failures = [];
  for (const node of flows) {
    const text = String(node.func || '');
    for (const name of RETIRED_READ_FILTERS) {
      if (text.includes(name + '(')) {
        failures.push(
          `${profileLabel}: node ${node.id} (${node.name || 'unnamed'}) calls retired read filter ${name}()`
        );
      }
    }
  }
  return failures;
}

function entryLabel(profileLabel, entry) {
  return `${profileLabel}: ${String(entry.method || '').toUpperCase()} ${entry.url} (${entry.id})`;
}

// Turns one probe trace into the failures of the scope-decision contract.
// options.filtering: the entry is in FILTERING_ENTRIES.
function judgeTrace(label, trace, options = {}) {
  const failures = [];
  for (const reason of trace.unanalysable) failures.push(`${label} cannot be analysed: ${reason}`);
  if (!trace.decisions.length) {
    const first = trace.accesses[0];
    const detail = first ? `; it reaches ${first.node}: ${first.what}` : '';
    failures.push(`${label} has no scope call: no node on its path made a scope decision${detail}`);
    return failures;
  }
  for (const access of trace.accesses) {
    failures.push(access.before
      ? `${label} reads or writes data before its scope decision: ${access.node}: ${access.what}`
      : `${label} goes on after its scope decision said no: ${access.node}: ${access.what}`);
  }
  for (const response of trace.responses) {
    if (response.status >= 400) continue;
    if (options.filtering && response.decided) continue;
    failures.push(response.decided
      ? `${label} goes on after its scope decision said no: answers ${response.status} (${response.node})`
      : `${label} answers ${response.status} on a path without a scope decision (${response.node})`);
  }
  if (!failures.length && !trace.responses.length) {
    failures.push(`${label} cannot be analysed: the denied request reaches no http response`);
  }
  return failures;
}

// The request must be refused without any read or write and without a success
// answer. Used for inline account checks (probed with a disabled account) and
// for entries that answer without data (probed with the usual caller).
function judgeRefusal(label, trace, failurePrefix) {
  const failures = [];
  for (const reason of trace.unanalysable) failures.push(`${label} cannot be analysed: ${reason}`);
  for (const access of trace.accesses) {
    failures.push(`${label} ${failurePrefix}: ${access.node}: ${access.what}`);
  }
  for (const response of trace.responses) {
    if (response.status < 400) {
      failures.push(`${label} ${failurePrefix}: answers ${response.status} (${response.node})`);
    }
  }
  if (!trace.responses.length && !failures.length) {
    failures.push(`${label} cannot be analysed: the request reaches no http response`);
  }
  return failures;
}

function modulesRootFor(profileLabel) {
  if (PROFILES.includes(profileLabel)) {
    return path.join(ROOT, path.dirname(profileLabel), 'node-red');
  }
  return DEFAULT_MODULES_ROOT;
}

// options.only: probe just these entry ids (tests use it; the CLI probes all).
// options.modulesRoot: the profile's node-red directory for its seam modules.
async function findFailures(flows, profileLabel, allowlist = ALLOWLIST, options = {}) {
  const failures = [];
  const byId = new Map(flows.map((node) => [node.id, node]));
  const entries = flows.filter((node) => node.type === 'http in' && node.method !== 'options');
  const entryIds = new Set(entries.map((node) => node.id));
  const modulesRoot = options.modulesRoot || modulesRootFor(profileLabel);
  const terminalLinkIns = new Set(TERMINAL_LINK_INS.keys());

  const inventories = [
    ['allowlist', [...allowlist]],
    ['inline account check list', [...INLINE_ACCOUNT_CHECKS.keys()]],
    ['no-data list', [...NO_DATA_ENTRIES.keys()]],
    ['filtering list', [...FILTERING_ENTRIES.keys()]],
    ['request fixture list', Object.keys(REQUEST_FIXTURES)],
  ];
  for (const [name, ids] of inventories) {
    for (const id of ids) {
      if (!entryIds.has(id)) failures.push(`${profileLabel}: ${name} entry ${id} matches no http in node`);
    }
  }
  for (const id of TERMINAL_LINK_INS.keys()) {
    const node = byId.get(id);
    if (!node || node.type !== 'link in') {
      failures.push(`${profileLabel}: terminal link-in entry ${id} matches no link in node`);
    }
  }

  for (const entry of entries) {
    if (options.only && !options.only.has(entry.id)) continue;
    const label = entryLabel(profileLabel, entry);
    const probeOptions = {
      byId,
      modulesRoot,
      terminalLinkIns,
      fixture: REQUEST_FIXTURES[entry.id],
    };
    const trace = await probeEntry(flows, entry, probeOptions);
    const verdict = judgeTrace(label, trace, { filtering: FILTERING_ENTRIES.has(entry.id) });

    if (allowlist.has(entry.id)) {
      if (!verdict.length) {
        failures.push(`${label} is allowlisted but makes its scope decision; remove it from the allowlist`);
      }
      continue;
    }
    if (INLINE_ACCOUNT_CHECKS.has(entry.id)) {
      if (!verdict.length) {
        failures.push(`${label} is listed as an inline account check but makes its scope decision on the helper; remove it from the list`);
        continue;
      }
      const disabledTrace = await probeEntry(flows, entry, { ...probeOptions, actor: 'disabled' });
      failures.push(...judgeRefusal(label, disabledTrace, 'does not refuse a disabled account'));
      continue;
    }
    if (NO_DATA_ENTRIES.has(entry.id)) {
      if (trace.decisions.length) {
        failures.push(`${label} is listed as answering without data but makes a scope decision; remove it from the list`);
        continue;
      }
      failures.push(...judgeRefusal(label, trace, 'is listed as answering without data, yet it goes on'));
      continue;
    }
    failures.push(...verdict);
  }
  return failures;
}

// options.load(profile): flows loader (tests mutate one profile with it).
// options.only: forwarded to findFailures.
async function verifyProfiles(profiles = PROFILES, options = {}) {
  const load = options.load || ((relativePath) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')));
  const failures = [];
  for (const relativePath of profiles) {
    const flows = load(relativePath);
    failures.push(...await findFailures(flows, relativePath, ALLOWLIST, { only: options.only }));
    failures.push(...findReadFilterRegressions(flows, relativePath));
  }
  return failures;
}

if (require.main === module) {
  verifyProfiles().then((failures) => {
    if (failures.length) {
      console.error('FAIL: scoped-access ratchet:\n  ' + failures.join('\n  '));
      process.exit(1);
    }
    console.log(
      'verify-scoped-access: OK (every entry decides on scope before touching data, ' +
      `or is listed: ${PUBLIC_ALLOWLIST.size} public, ${PHASE_C_PENDING.size} Phase C, ` +
      `${KNOWN_GAPS.size} known gaps, ${INLINE_ACCOUNT_CHECKS.size} inline checks, ` +
      `${NO_DATA_ENTRIES.size} without data, ${FILTERING_ENTRIES.size} filtering; ` +
      'the behavioral matrix is the correctness gate)'
    );
  }, (error) => {
    console.error('verify-scoped-access: fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  ALLOWLIST,
  FILTERING_ENTRIES,
  INLINE_ACCOUNT_CHECKS,
  KNOWN_GAPS,
  NO_DATA_ENTRIES,
  PHASE_C_PENDING,
  PROFILES,
  PUBLIC_ALLOWLIST,
  REQUEST_FIXTURES,
  RETIRED_READ_FILTERS,
  TERMINAL_LINK_INS,
  findFailures,
  findReadFilterRegressions,
  judgeTrace,
  verifyProfiles,
};
