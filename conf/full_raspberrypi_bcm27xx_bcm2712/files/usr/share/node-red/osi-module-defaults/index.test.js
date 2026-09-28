'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./index');

const FIELDS = ['dataModuleEnabled', 'networkModuleEnabled', 'gatewayHubModuleEnabled', 'journalModuleEnabled'];

test('every switchable module is declared once, with a key and a boolean-or-auto default', () => {
  assert.deepEqual(defaults.MODULE_SETTINGS.map((m) => m.field), FIELDS);
  const keys = new Set();
  for (const module of defaults.MODULE_SETTINGS) {
    assert.equal(typeof module.key, 'string', module.field + ' needs an app_settings key');
    assert.match(module.key, /^[a-z0-9_]+$/, module.field + ' key must be snake_case');
    // 'auto' is the one sentinel allowed in place of a boolean: it means the
    // default is derived from gateway facts rather than shipped as a constant
    // (see moduleDefaultForKey). Today only Network uses it.
    assert.ok(
      typeof module.defaultEnabled === 'boolean' || module.defaultEnabled === 'auto',
      module.field + " needs a boolean default, or the 'auto' sentinel"
    );
    assert.ok(!keys.has(module.key), 'duplicate app_settings key: ' + module.key);
    keys.add(module.key);
  }
});

test('MODULE_DEFAULTS mirrors the declared defaults field-for-field, with auto contributing false', () => {
  assert.deepEqual(
    defaults.MODULE_DEFAULTS,
    defaults.MODULE_SETTINGS.reduce(
      (acc, m) => Object.assign(acc, { [m.field]: m.defaultEnabled === 'auto' ? false : m.defaultEnabled }),
      {}
    ),
  );
  // Frozen: a consumer that mutated the shared table would move the default for
  // every other consumer in the same process.
  assert.ok(Object.isFrozen(defaults.MODULE_DEFAULTS));
  assert.ok(Object.isFrozen(defaults.MODULE_SETTINGS));
});

test('an absent row resolves to the declared default, for every module (auto resolves context-less to false)', () => {
  for (const module of defaults.MODULE_SETTINGS) {
    const expected = module.defaultEnabled === 'auto' ? false : module.defaultEnabled;
    assert.equal(defaults.interpretStoredValue(module.key, null), expected, module.key + ' null');
    assert.equal(defaults.interpretStoredValue(module.key, undefined), expected, module.key + ' undefined');
    assert.equal(defaults.moduleDefaultForKey(module.key), expected);
    assert.equal(defaults.moduleDefaultForField(module.field), expected);
    assert.equal(defaults.settingForField(module.field), module);
  }
});

test('a stored row always wins over the default, whatever the default is', () => {
  for (const module of defaults.MODULE_SETTINGS) {
    for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      assert.equal(defaults.interpretStoredValue(module.key, off), false, module.key + ' = ' + off);
    }
    for (const on of ['1', 'true', 'on', 'yes', 'anything']) {
      assert.equal(defaults.interpretStoredValue(module.key, on), true, module.key + ' = ' + on);
    }
  }
});

test('an unknown key is a programming error, not a silent "on"', () => {
  assert.throws(() => defaults.interpretStoredValue('not_a_module', null), /unknown module setting key/);
  assert.throws(() => defaults.moduleDefaultForKey('not_a_module'), /unknown module setting key/);
  assert.throws(() => defaults.moduleDefaultForField('notAModule'), /unknown module setting field/);
  assert.throws(() => defaults.settingForField('notAModule'), /unknown module setting field/);
});

// ---------------------------------------------------------------------------
// Network module: derived default (Task 8, 2026-09-22 field-test program)
// ---------------------------------------------------------------------------
// Network's defaultEnabled is 'auto', not a boolean: the Network header link
// only earns its place once a RAK10701 field tester is registered on this
// gateway. The caller supplies that fact as context.fieldTesterPresent.

test('the network module defaults to the presence of a field tester', () => {
  assert.equal(defaults.interpretStoredValue('network_module_enabled', null, { fieldTesterPresent: true }), true);
  assert.equal(defaults.interpretStoredValue('network_module_enabled', null, { fieldTesterPresent: false }), false);
});

test('a stored row still wins in both directions', () => {
  assert.equal(defaults.interpretStoredValue('network_module_enabled', '0', { fieldTesterPresent: true }), false);
  assert.equal(defaults.interpretStoredValue('network_module_enabled', '1', { fieldTesterPresent: false }), true);
});

test('the other three modules keep their static defaults', () => {
  // Derived from the table, not restated: a customer branch that flips a
  // static default in index.js must leave this suite green (see the header).
  const statics = defaults.MODULE_SETTINGS.filter((m) => m.defaultEnabled !== 'auto');
  assert.equal(statics.length, 3);
  for (const module of statics) {
    assert.equal(defaults.interpretStoredValue(module.key, null, {}), module.defaultEnabled, module.key);
    assert.equal(defaults.interpretStoredValue(module.key, null, { fieldTesterPresent: true }), module.defaultEnabled, module.key);
  }
});

// Beyond the brief's literal cases: a caller that supplies no context at all
// (it predates this change, or genuinely has no such fact) must get a
// defined, safe `false` -- never a crash, and never an accidental `true`.
test('a context-less caller resolves the network default to false, not a crash or true', () => {
  assert.equal(defaults.interpretStoredValue('network_module_enabled', null), false);
  assert.equal(defaults.interpretStoredValue('network_module_enabled', undefined), false);
  assert.equal(defaults.moduleDefaultForKey('network_module_enabled'), false);
  assert.equal(defaults.moduleDefaultForField('networkModuleEnabled'), false);
  // A context object present but missing the fact behaves the same way.
  assert.equal(defaults.interpretStoredValue('network_module_enabled', null, {}), false);
  assert.equal(defaults.interpretStoredValue('network_module_enabled', null, { someOtherFact: true }), false);
});

// moduleDefaultForKey and moduleDefaultForField are the same package's other
// two entry points that read a default; they must agree with
// interpretStoredValue rather than leaking the 'auto' sentinel to a caller
// that expects a boolean.
test('moduleDefaultForKey and moduleDefaultForField resolve auto the same way interpretStoredValue does', () => {
  for (const present of [true, false]) {
    const context = { fieldTesterPresent: present };
    assert.equal(defaults.moduleDefaultForKey('network_module_enabled', context), present);
    assert.equal(defaults.moduleDefaultForField('networkModuleEnabled', context), present);
    assert.notEqual(typeof defaults.moduleDefaultForKey('network_module_enabled', context), 'string');
  }
});

// MODULE_DEFAULTS must stay boolean-valued for every field, including
// Network's -- it is exported verbatim as GET /api/system/settings'
// `moduleDefaults`, and an 'auto' string there would be truthy everywhere it
// is read as a flag, showing the tab on every gateway.
test('MODULE_DEFAULTS stays boolean-valued for every module, network included', () => {
  for (const module of defaults.MODULE_SETTINGS) {
    assert.equal(typeof defaults.MODULE_DEFAULTS[module.field], 'boolean', module.field);
  }
  assert.equal(defaults.MODULE_DEFAULTS.networkModuleEnabled, false, "network's static default contributes false");
});

// The point of this package: a customer branch flips `defaultEnabled` here and
// nowhere else. That only holds while no consumer carries its own copy of a key
// or a default, so the consumers are checked at the source level -- an
// assertion on behaviour alone would still pass if a consumer kept a literal
// that happened to agree with this table today.
test('no consumer keeps its own copy of a module key or default', () => {
  const nodeRed = path.resolve(__dirname, '..');
  for (const rel of ['osi-system-settings/api.js', 'osi-journal-replication/index.js']) {
    const source = fs.readFileSync(path.join(nodeRed, rel), 'utf8');
    assert.doesNotMatch(source, /_module_enabled/, rel + ' must take module keys from osi-module-defaults');
    assert.doesNotMatch(source, /MODULE_OFF_VALUES\s*=/, rel + ' must take the off-value set from osi-module-defaults');
  }
});
