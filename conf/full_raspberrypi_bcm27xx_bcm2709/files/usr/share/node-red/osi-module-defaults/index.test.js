'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./index');

const FIELDS = ['dataModuleEnabled', 'networkModuleEnabled', 'gatewayHubModuleEnabled', 'journalModuleEnabled'];

test('every switchable module is declared once, with a key and a boolean default', () => {
  assert.deepEqual(defaults.MODULE_SETTINGS.map((m) => m.field), FIELDS);
  const keys = new Set();
  for (const module of defaults.MODULE_SETTINGS) {
    assert.equal(typeof module.key, 'string', module.field + ' needs an app_settings key');
    assert.match(module.key, /^[a-z0-9_]+$/, module.field + ' key must be snake_case');
    assert.equal(typeof module.defaultEnabled, 'boolean', module.field + ' needs a boolean default');
    assert.ok(!keys.has(module.key), 'duplicate app_settings key: ' + module.key);
    keys.add(module.key);
  }
});

test('MODULE_DEFAULTS mirrors the declared defaults field-for-field', () => {
  assert.deepEqual(
    defaults.MODULE_DEFAULTS,
    defaults.MODULE_SETTINGS.reduce((acc, m) => Object.assign(acc, { [m.field]: m.defaultEnabled }), {}),
  );
  // Frozen: a consumer that mutated the shared table would move the default for
  // every other consumer in the same process.
  assert.ok(Object.isFrozen(defaults.MODULE_DEFAULTS));
  assert.ok(Object.isFrozen(defaults.MODULE_SETTINGS));
});

test('an absent row resolves to the declared default, for every module', () => {
  for (const module of defaults.MODULE_SETTINGS) {
    assert.equal(defaults.interpretStoredValue(module.key, null), module.defaultEnabled, module.key + ' null');
    assert.equal(defaults.interpretStoredValue(module.key, undefined), module.defaultEnabled, module.key + ' undefined');
    assert.equal(defaults.moduleDefaultForKey(module.key), module.defaultEnabled);
    assert.equal(defaults.moduleDefaultForField(module.field), module.defaultEnabled);
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
