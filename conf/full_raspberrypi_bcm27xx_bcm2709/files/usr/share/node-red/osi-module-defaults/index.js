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

const MODULE_SETTINGS = Object.freeze([
  // The Data header link and the Data tab (/analysis, /history).
  Object.freeze({ field: 'dataModuleEnabled', key: 'data_module_enabled', defaultEnabled: true }),
  // The Network header link (/network).
  Object.freeze({ field: 'networkModuleEnabled', key: 'network_module_enabled', defaultEnabled: true }),
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
// as `moduleDefaults` and the shape every test compares against.
const MODULE_DEFAULTS = Object.freeze(MODULE_SETTINGS.reduce(function (acc, module) {
  acc[module.field] = module.defaultEnabled;
  return acc;
}, {}));

function moduleDefaultForKey(key) {
  const module = SETTING_BY_KEY.get(key);
  if (!module) throw new Error('unknown module setting key: ' + key);
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

function moduleDefaultForField(field) {
  return settingForField(field).defaultEnabled;
}

// One reading of a stored app_settings value, used by both the route and the
// worker. `rawValue` is whatever the row held; pass undefined/null for "no row",
// which includes the read having failed outright. Both callers fail to the
// shipped default rather than to a hardcoded "on": a gateway whose DB predates
// app_settings then behaves exactly like a fresh one on the same firmware.
function interpretStoredValue(key, rawValue) {
  if (rawValue === null || rawValue === undefined) return moduleDefaultForKey(key);
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
