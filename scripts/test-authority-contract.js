#!/usr/bin/env node
'use strict';
// Source coverage and executable normalized vectors; runtime consumers need conformance tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isFakeEui } = require('./verify-doc-hygiene');
const Ajv2020 = require('ajv/dist/2020');
const model = require('./lib/authority-contract-model');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'docs/contracts/authority');
const read = name => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `duplicate ${label}`);
}
function verify() {
  const manifest = read('MANIFEST.json');
  assert.equal(manifest.contract_version, 'authority-v1');
  const inventory = read('fixtures/auth-consumers.json');
  const authority = read('fixtures/authorization.json');
  const revocation = read('fixtures/revocation.json');
  const pauses = read('fixtures/pause-continuations.json');
  const upgrades = read('fixtures/admin-upgrade.json');
  const decisions = read('fixtures/decisions.json');
  assert.deepEqual([...manifest.decision_ids].sort(), decisions.decisions.map(d => d.id).sort());
  assert.deepEqual(manifest.open_questions, []);
  assert.equal(manifest.ruling_date, '2026-11-20');
  assert.equal(manifest.actor_capability, 'authority_actor_v1');
  const schema = read('vectors.schema.json');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(schema);
  const validate = (def, value) => {
    const check = ajv.getSchema(schema.$id + '#/$defs/' + def);
    assert.ok(check(value), `${def}: ${ajv.errorsText(check.errors)}`);
  };
  const projection = (actual, expected, where) => {
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(actual[key], value, `${where}.${key}`);
    }
  };
  const verifyCase = c => {
    validate('authorityCase', c);
    const input = model.merge(authority.valid_defaults, c.input);
    validate('authorityInput', input);
    projection(model.authorize(input), c.expected, c.id);
    return input;
  };
  assert.equal(inventory.sources.edge_commit, manifest.sources.edge_commit);
  assert.equal(inventory.sources.cloud_commit, manifest.sources.cloud_commit);
  for (const file of manifest.files) assert.ok(fs.existsSync(path.join(DIR, file)), `missing ${file}`);
  for (const fixture of [inventory, authority, revocation, pauses, upgrades, decisions]) {
    assert.equal(fixture.contract_version, manifest.contract_version);
  }
  const pinned = file => execFileSync('git', ['show', `${inventory.sources.edge_commit}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const flows = JSON.parse(pinned(inventory.sources.flow_file));
  const nodes = new Map(flows.map(n => [n.id, n]));
  assert.equal(pinned(inventory.sources.flow_file), pinned(inventory.sources.mirror_flow_file), 'both profile flow copies');
  unique(inventory.routes.map(r => r.node_id), 'HTTP node');
  assert.deepEqual(inventory.routes.map(r => r.node_id).sort(), flows.filter(n => n.type === 'http in').map(n => n.id).sort(), 'every HTTP route, including public/preflight/disabled routes');
  for (const route of inventory.routes) {
    const n = nodes.get(route.node_id);
    assert.equal(route.method, n.method.toUpperCase());
    assert.equal(route.path, n.url);
    assert.equal(route.entry_node, n.wires[0][0]);
    assert.equal(route.file, inventory.sources.flow_file);
    assert.equal(typeof route.installer_only_in_0_9, 'boolean');
    assert.ok(inventory.check_groups[route.check_group], `check group ${route.node_id}`);
    for (const id of route.auth_nodes) assert.ok(nodes.has(id), `unknown auth node ${id}`);
    const selected = {};
    const entry = nodes.get(route.entry_node);
    if (entry.id === 'scoped-device-config-guard') {
      const table = JSON.parse(entry.func.match(/const routeTable = (\[.*?\]);/)[1]);
      selected[entry.id] = table.find(r => r.method === route.method && r.suffix === route.path.split(':deveui')[1]).index;
    } else if (entry.id === 'scoped-zone-config-guard') {
      const table = JSON.parse(entry.func.match(/const routes = (\[.*?\]);/)[1]);
      selected[entry.id] = table.find(r => r.method === route.method && r.routePath === route.path).index;
    } else if (entry.id === 'sdi12-config-auth-fn') {
      const selectors = [...entry.func.matchAll(/suffix === '([^']+)' \? (\d+)/g)];
      selected[entry.id] = Number(selectors.find(m => route.path.endsWith(m[1]))[2]);
    }
    assert.deepEqual(route.selected_outputs, selected, `route-specific outputs ${route.path}`);
    const seen = new Set();
    const pending = [route.node_id];
    while (pending.length) {
      const id = pending.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodes.get(id);
      if (['http response', 'link out', 'mqtt out'].includes(node.type)) continue;
      const wires = Object.hasOwn(selected, id) ? [node.wires[selected[id]], node.wires.at(-1)] : node.wires || [];
      pending.push(...wires.flat());
    }
    for (const id of route.auth_nodes) assert.ok(seen.has(id), `unreachable consumer ${route.path}/${id}`);
  }
  assert.deepEqual(inventory.inline_bearer_nodes.map(n => n.node_id).sort(), flows.filter(n => /verifyBearer/.test(n.func || '')).map(n => n.id).sort(), 'all inline bearer implementations');
  for (const item of inventory.inline_bearer_nodes) {
    assert.equal(item.file, inventory.sources.flow_file);
    assert.ok(item.revocation_path);
  }
  const borrowed = /authUserId|authUsername|_authUser|_scopedZoneWriteAuthorized|_actorUserUuid|actor_user_uuid|request\.actorId|msg\.osi|_unlinkAuth|_recoveryActor|msg\.deviceRow/;
  assert.equal(inventory.borrowed_authority_pattern, borrowed.source);
  assert.deepEqual(inventory.flow_state_consumers.map(n => n.node_id).sort(), flows.filter(n => borrowed.test(n.func || '')).map(n => n.id).sort(), 'all borrowed authority consumers');
  assert.deepEqual(inventory.verification_callers.map(n => n.node_id).sort(), flows.filter(n => /verifyBearer|authorizeAdminRead/.test(n.func || '')).map(n => n.id).sort(), 'includes delegated admin guards');
  assert.equal(inventory.verification_callers.filter(c => c.kind === 'inline_hmac').length, 73);
  assert.equal(inventory.verification_callers.filter(c => c.kind === 'shared_bearer').length, 10);
  assert.equal(inventory.verification_callers.filter(c => c.kind === 'shared_admin').length, 6);
  for (const route of inventory.routes) {
    for (const sink of route.module_sinks || []) {
      assert.ok(pinned(sink.file).includes(sink.function));
      assert.ok(nodes.get(sink.caller_node).func.includes(sink.function), `real sink caller ${sink.caller_node}`);
    }
  }
  for (const edge of inventory.caller_edges) {
    const caller = edge.caller_node ? nodes.get(edge.caller_node).func : pinned(edge.caller_file);
    assert.ok(caller.includes(edge.call), `real caller ${edge.caller_file}/${edge.call}`);
    assert.ok(pinned(edge.callee_file).includes(`function ${edge.callee_function}(`), `real function ${edge.callee_function}`);
  }
  for (const state of inventory.state_consumers) {
    if (state.file === inventory.sources.flow_file) {
      for (const id of state.nodes) assert.ok(nodes.has(id), `unknown state consumer ${id}`);
    }
  }
  const inventoryText = fs.readFileSync(path.join(DIR, 'fixtures/auth-consumers.json'), 'utf8');
  for (const match of inventoryText.matchAll(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{16}(?![0-9A-Fa-f])/g)) {
    if (!isFakeEui(match[0])) assert.ok(nodes.has(match[0]), 'hygiene allowance must contain only source node ids');
  }
  const gaps = new Set(Object.keys(inventory.gaps));
  for (const route of inventory.routes) {
    for (const gap of route.additional_gaps || []) assert.ok(gaps.has(gap));
  }
  for (const group of Object.values(inventory.check_groups)) {
    assert.ok(group.checks_today.flag_on && group.checks_today.flag_off && group.revocation_path);
    for (const gap of group.gaps) assert.ok(gaps.has(gap), `unknown gap ${gap}`);
  }
  for (const item of inventory.module_consumers) {
    const source = pinned(item.file);
    assert.equal(source, pinned(item.file.replace('bcm2712', 'bcm2709')), `both profile modules: ${item.file}`);
    assert.ok(source.includes(item.function), `missing ${item.file} ${item.function}`);
    assert.ok(item.checks_today && item.revocation_path);
    assert.ok(!/add installer entitlement|and installer at/.test(item.revocation_path), 'radio handoff must use existing owner/admin authority');
    for (const gap of item.gaps) assert.ok(gaps.has(gap));
  }
  const moduleFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', inventory.sources.edge_commit, inventory.sources.payload_root], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => /\/osi-[^/]+\/.*\.js$/.test(file) && !/\.test\.js$|\/test[^/]*\.js$/.test(file));
  for (const file of moduleFiles) {
    for (const match of pinned(file).matchAll(/function (verifyBearer|portableVerifyBearer)\(/g)) {
      assert.ok(inventory.module_consumers.some(item => item.file === file && item.function === match[1]), `unlisted module bearer verifier ${file}/${match[1]}`);
    }
  }
  unique(authority.cases.map(c => c.id), 'authorization case');
  unique(revocation.cases.map(c => c.id), 'revocation case');
  unique(pauses.cases.map(c => c.id), 'pause case');
  const inputs = authority.cases.map(verifyCase);
  for (const c of revocation.cases) {
    validate('lifecycleCase', c);
    model.runLifecycle(c.initial, c.steps, authority.valid_defaults, (actual, expected, op) => projection(actual, expected, `${c.id}/${op}`));
  }
  for (const [id, op, oldDecision] of [
    ['relink-delayed-credential-cannot-cross', 'credential_delivery', 'committed'],
    ['credential-ordering-and-duplicate', 'credential_delivery', 'committed'],
    ['v1-invalid-subject-no-legacy-fallback', 'login', 'allow'],
  ]) {
    const bad = structuredClone(revocation.cases.find(c => c.id === id));
    const step = bad.steps.find(s => s.op === op && s.expected?.decision === 'deny');
    assert.ok(step, `mutation target ${id}`);
    step.expected = { decision: oldDecision };
    validate('lifecycleCase', bad);
    assert.throws(() => model.runLifecycle(bad.initial, bad.steps, authority.valid_defaults,
      (actual, expected, name) => projection(actual, expected, `${id}/${name}`)), /decision/);
  }
  for (const c of pauses.cases) {
    validate('pauseCase', c);
    model.runPause(c.initial, c.steps, authority.valid_defaults, (actual, expected, op) => projection(actual, expected, `${c.id}/${op}`));
  }
  unique(upgrades.cases.map(c => c.id), 'upgrade case');
  for (const c of upgrades.cases) {
    validate('adminUpgradeCase', c);
    model.runAdminUpgrade(c.initial, c.steps, (actual, expected, op) => projection(actual, expected, `${c.id}/${op}`));
  }
  assert.deepEqual(authority.valid_defaults.policies, manifest.policy_defaults);
  assert.equal(manifest.product_decisions_selected, true);
  assert.deepEqual(manifest.phil_overridable_defaults, []);
  for (const d of decisions.decisions) {
    assert.equal(d.status, ['R6', 'R7'].includes(d.id) ? 'decided' : 'decided_default');
    assert.equal(d.ruling_date, '2026-11-20');
    if (d.policy_dimension) assert.equal(d.selected_default, manifest.policy_defaults[d.policy_dimension]);
    assert.equal(d.product_default, false);
    assert.equal(d.phil_may_override, false);
    assert.equal(d.override_owner, null);
    if (['R6', 'R7'].includes(d.id)) assert.equal(d.decision_owner, 'Phil');
  }
  const radioTools = [
    { id: 'network_observations', action: 'radio_observations', origins: ['edge'] },
    { id: 'radio_configuration', action: 'radio_configuration', origins: ['edge'] },
    { id: 'radio_configuration_history', action: 'radio_configuration_history', origins: ['edge'] },
    { id: 'field_test_survey', action: 'radio_survey', origins: ['edge'] },
    { id: 'field_test_download', action: 'radio_survey_download', origins: ['edge'] },
    { id: 'cloud_network_observations', action: 'radio_observations', origins: ['cloud'] },
    { id: 'raw_radio_exports', action: 'radio_raw_export', origins: ['edge', 'cloud'] },
  ];
  assert.deepEqual(authority.radio_tools, radioTools, 'every Phil Q1 tool has an explicit fixture family');
  for (const tool of radioTools) for (const origin of tool.origins) for (const scoped of [false, true]) {
    for (const subject of ['owner', 'admin', 'member', 'viewer', 'super_admin']) {
      const id = `radio-tool-${tool.id}-${origin}-${Number(scoped)}-${subject}`;
      const c = authority.cases.find(c => c.id === id);
      assert.ok(c, `required radio boundary case ${id}`);
      const input = model.merge(authority.valid_defaults, c.input);
      assert.equal(input.action, tool.action);
      assert.equal(input.origin, origin);
      assert.equal(input.scoped_access, scoped);
      assert.equal(input.actor.enabled, true);
      assert.equal(input.actor.gateway_owner, subject === 'owner');
      assert.equal(input.actor.gateway_role, subject === 'admin' ? 'admin' : ['viewer', 'super_admin'].includes(subject) ? 'viewer' : 'researcher');
      if (subject === 'owner') assert.equal(input.actor.ownership_proven, true);
      if (subject === 'super_admin') assert.equal(input.actor.cloud_role, 'SUPER_ADMIN');
      assert.equal(c.expected.decision, ['owner', 'admin'].includes(subject) ? 'allow' : 'deny');
    }
  }
  for (const input of inputs) assert.deepEqual(input.policies, manifest.policy_defaults, 'only decided defaults are executable');
  for (const [dimension, superseded] of Object.entries({ installer: 'gateway_installer', offline: 'bounded_offline_lease', stop_authority: 'current_rights', first_admin: 'operator_provisioned', clock: 'durable_high_water', prediction: 'admin_zone_write', owner_system: 'mapped_admin_only' })) {
    assert.throws(() => validate('authorityInput', model.merge(authority.valid_defaults, { policies: { [dimension]: superseded } })), /constant/);
  }
  const wrongBootstrap = structuredClone(authority.cases.find(c => c.id === 'fresh-flag-off-stored-admin'));
  wrongBootstrap.expected.stored_role = 'researcher';
  assert.throws(() => verifyCase(wrongBootstrap), /stored_role/);
  const missingOriginal = structuredClone(upgrades.cases.find(c => c.id === 'missing-bootstrap-operator-fallback'));
  missingOriginal.steps[0].expected.decision = 'promoted_original_bootstrap';
  assert.throws(() => model.runAdminUpgrade(missingOriginal.initial, missingOriginal.steps,
    (actual, expected, op) => projection(actual, expected, op)), /decision/);
  const refusedStop = structuredClone(pauses.cases.find(c => c.id === 'lost-authority-before_apply-reduce_only_continuation'));
  refusedStop.steps.find(s => s.op === 'apply_pause').expected.decision = 'deny';
  assert.throws(() => model.runPause(refusedStop.initial, refusedStop.steps, authority.valid_defaults,
    (actual, expected, op) => projection(actual, expected, op)), /decision/);
  // Deliberately corrupt required expectations to the reviewed old behavior.
  // A shape-only checker would accept these records.
  for (const id of ['sdi12_recipe_apply-1-missing_bearer', 'sdi12_recipe_rollback-1-revoked', 'cloud-owner-viewer-zone_config', 'rename-no-name-capability', 'clock-behind-high-water-expires-still-young-token', 'actorless-queued-valve_open-refused-at-upgrade']) {
    const bad = structuredClone(authority.cases.find(c => c.id === id));
    assert.ok(bad, id);
    bad.expected = { decision: 'allow', effects: 1 };
    // Schema is still valid after preserving the required reason.
    bad.expected.reason = 'authorized';
    validate('authorityCase', bad);
    assert.throws(() => verifyCase(bad), /decision/, `${id} old behavior must fail`);
  }
  const doc = fs.readFileSync(path.join(DIR, 'v1.md'), 'utf8');
  for (const id of manifest.decision_ids) assert.ok(doc.includes(id));
  assert.ok(doc.includes('20 Nov 2026'));
  assert.ok(doc.includes(upgrades.release_note_line), 'exact release-note line');
  assert.ok(!doc.includes('## Open questions'));
  console.log(`authority contract: OK (${inventory.routes.length} routes, ${inventory.verification_callers.length} verifier callers (73 inline, 10 shared, 6 admin), ${inventory.module_consumers.length} module consumers, ${authority.cases.length} authority cases, ${revocation.cases.length} lifecycle cases, ${pauses.cases.length} pause cases, ${upgrades.cases.length} admin-upgrade cases; old-behavior mutation probes rejected)`);
}
if (require.main === module) {
  try { verify(); } catch (error) { console.error(`authority contract: FAIL: ${error.message}`); process.exitCode = 1; }
}
module.exports = { verify };
