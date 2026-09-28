'use strict';
// osi-module-defaults — the single definition of the four switchable gateway
// modules: their app_settings key, the GET/PUT field name the GUI sees, and the
// value a gateway ships with before anyone touches the switch.
//
// Why a package of its own: these defaults had three independent copies (the
// GET handler in osi-system-settings/api.js, the journalModuleEnabled helper in
// osi-journal-replication/index.js, and DEFAULT_FLAGS in the React hook), and a
// product decision that ships a module hidden had to be made in all three at
// once or the surfaces disagreed. The replication helper runs inside the
// Node-RED worker and must not depend on an HTTP route module, so neither
// existing package could host the shared copy; this leaf does, with no runtime
// dependencies of its own. The GUI copy is gone entirely -- GET
// /api/system/settings now reports these defaults in its `moduleDefaults`
// object, so the browser reads them from the gateway it is talking to.
//
// CUSTOMER BRANCHES: flip `defaultEnabled` below and nothing else. Every
// consumer and every test derives its expectation from this table, so a pick
// that changes only this file leaves the suite green.
//
// A stored app_settings row always wins over the default; these values only
// decide what a gateway does before the switch has ever been written (and when
// the row cannot be read at all -- see interpretStoredValue).
//
// `defaultEnabled` is normally a boolean. Network's is the string 'auto': the
// Network header link only earns its place once a RAK10701 field tester is
// registered on the gateway, so there is no single boolean to ship. The
// caller (osi-system-settings/api.js) supplies that fact as
// `context.fieldTesterPresent` -- this package stays dependency-free and never
// queries a database itself. A context-less caller (or 'auto' with no
// fieldTesterPresent) resolves to `false`, never `true`: an unproven field
// tester must not show the tab. See moduleDefaultForKey.

const MODULE_SETTINGS = Object.freeze([
  // The Data header link and the Data tab (/analysis, /history).
  Object.freeze({ field: 'dataModuleEnabled', key: 'data_module_enabled', defaultEnabled: true }),
  // The Network header link (/network). 'auto': see the header comment above.
  Object.freeze({ field: 'networkModuleEnabled', key: 'network_module_enabled', defaultEnabled: 'auto' }),
  // The gateway hub card on the dashboard.
  Object.freeze({ field: 'gatewayHubModuleEnabled', key: 'gateway_hub_module_enabled', defaultEnabled: true }),
  // Field Journal entry points -- and the journal-v2 replication worker, which
  // stops contacting the cloud entirely when this one is off.
  Object.freeze({ field: 'journalModuleEnabled', key: 'journal_module_enabled', defaultEnabled: true }),
]);

// Stored values that mean "off". Anything else stored means "on"; an absent row
// means the default. Shared so the route and the worker cannot disagree about
// what a row says.
const MODULE_OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

const SETTING_BY_KEY = new Map(MODULE_SETTINGS.map((module) => [module.key, module]));
const SETTING_BY_FIELD = new Map(MODULE_SETTINGS.map((module) => [module.field, module]));

// { dataModuleEnabled: true, ... } -- the shape GET /api/system/settings reports
// as `moduleDefaults` and the shape every test compares against. Boolean-valued
// ONLY: Network's 'auto' entry contributes `false` here. This object is a
// static, per-process constant (no gateway facts in scope to derive from), and
// every consumer treats it as a plain boolean map -- an 'auto' string would be
// truthy everywhere it is read as a flag, which is the exact bug this feature
// exists to prevent. The route reports the resolved (possibly derived) value
// separately, alongside this fixed table -- see osi-system-settings/api.js.
const MODULE_DEFAULTS = Object.freeze(MODULE_SETTINGS.reduce(function (acc, module) {
  acc[module.field] = module.defaultEnabled === 'auto' ? false : module.defaultEnabled;
  return acc;
}, {}));

// The one place 'auto' is resolved. `context` carries whatever fact a derived
// default needs -- today just `{ fieldTesterPresent }` for Network -- supplied
// by the caller, since this package must stay dependency-free (no DB query of
// its own; see the header comment). No context (or a context missing the fact)
// resolves 'auto' to `false`: a context-less caller predating this change, or
// one that legitimately has no such fact, gets a safe, defined answer rather
// than a crash or an accidental `true`. A boolean default ignores `context`
// entirely, so the other three modules are unaffected either way.
function moduleDefaultForKey(key, context) {
  const module = SETTING_BY_KEY.get(key);
  if (!module) throw new Error('unknown module setting key: ' + key);
  if (module.defaultEnabled === 'auto') return Boolean(context && context.fieldTesterPresent);
  return module.defaultEnabled;
}

// Lookup by the GET/PUT field name, for a consumer that cares about exactly one
// module (the journal replication worker). Throws rather than returning
// undefined: a miss means this table and its consumer disagree about what the
// modules are, which must not degrade into a silent "on".
function settingForField(field) {
  const module = SETTING_BY_FIELD.get(field);
  if (!module) throw new Error('unknown module setting field: ' + field);
  return module;
}

// Coherent with moduleDefaultForKey (and so with interpretStoredValue): routed
// through the same 'auto' resolution rather than returning `module.defaultEnabled`
// verbatim, so this entry point can never hand a caller the literal string
// 'auto' where every existing caller expects a boolean.
function moduleDefaultForField(field, context) {
  return moduleDefaultForKey(settingForField(field).key, context);
}

// One reading of a stored app_settings value, used by both the route and the
// worker. `rawValue` is whatever the row held; pass undefined/null for "no row",
// which includes the read having failed outright. Both callers fail to the
// shipped (or derived) default rather than to a hardcoded "on": a gateway whose
// DB predates app_settings then behaves exactly like a fresh one on the same
// firmware. `context` is forwarded to moduleDefaultForKey untouched -- see
// there for what an absent/partial context resolves to.
function interpretStoredValue(key, rawValue, context) {
  if (rawValue === null || rawValue === undefined) return moduleDefaultForKey(key, context);
  return !MODULE_OFF_VALUES.has(String(rawValue).trim().toLowerCase());
}

module.exports = {
  MODULE_SETTINGS,
  settingForField,
  MODULE_OFF_VALUES,
  MODULE_DEFAULTS,
  moduleDefaultForKey,
  moduleDefaultForField,
  interpretStoredValue,
};
