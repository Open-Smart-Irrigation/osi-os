#!/usr/bin/env node
'use strict';
// Contract/coverage checks only. EB5a/EB5b/EB6/CL2 must test actual consumers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isFakeEui } = require('./verify-doc-hygiene');
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
  assert.equal(inventory.sources.edge_commit, manifest.sources.edge_commit);
  assert.equal(inventory.sources.cloud_commit, manifest.sources.cloud_commit);
  for (const file of manifest.files) assert.ok(fs.existsSync(path.join(DIR, file)), `missing ${file}`);
  for (const fixture of [inventory, authority, revocation]) {
    assert.equal(fixture.contract_version, manifest.contract_version);
  }
  const pinned = file => execFileSync('git', ['show', `${inventory.sources.edge_commit}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const flows = JSON.parse(pinned(inventory.sources.flow_file));
  const nodes = new Map(flows.map(n => [n.id, n]));
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
  }
  assert.deepEqual(inventory.inline_bearer_nodes.map(n => n.node_id).sort(), flows.filter(n => /verifyBearer/.test(n.func || '')).map(n => n.id).sort(), 'all inline bearer implementations');
  for (const item of inventory.inline_bearer_nodes) {
    assert.equal(item.file, inventory.sources.flow_file);
    assert.ok(item.revocation_path);
  }
  assert.deepEqual(inventory.flow_state_consumers.map(n => n.node_id).sort(), flows.filter(n => /authUserId|authUsername|_authUser|_scopedZoneWriteAuthorized|_actorUserUuid|actor_user_uuid|request\.actorId|msg\.osi/.test(n.func || '')).map(n => n.id).sort(), 'all functions carrying or using authenticated actor state');
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
    assert.ok(source.includes(item.function), `missing ${item.file} ${item.function}`);
    assert.ok(item.checks_today && item.revocation_path);
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
  for (const c of authority.cases) {
    assert.ok(['allow', 'deny', 'unresolved'].includes(c.expected.decision));
    assert.ok(manifest.modes.includes(c.mode));
    assert.equal(typeof c.scoped_access, 'boolean');
    if (c.expected.decision !== 'allow') assert.equal(c.expected.effects, 0);
    if (c.expected.decision === 'unresolved') assert.ok(manifest.open_questions.includes(c.expected.question));
  }
  for (const mode of manifest.modes) {
    for (const scoped of [false, true]) {
      for (const action of ['admin_accounts', 'system_reboot', 'system_fan']) {
        assert.ok(authority.cases.some(c => c.mode === mode && c.scoped_access === scoped && c.action === action && c.actor.gateway_role === 'admin' && c.expected.decision === 'allow'), `${mode}/${scoped}/${action} admin coverage`);
      }
    }
  }
  for (const action of ['valve_open', 'valve_cancel', 'strega_timed', 'strega_partial', 'strega_flush', 'chameleon_config']) {
    for (const origin of ['edge', 'cloud']) {
      assert.ok(authority.cases.some(c => c.origin === origin && c.action === action && c.actor.gateway_role === 'researcher' && c.actor.zone_relation === 'granted' && c.expected.decision === 'allow'), `granted member parity ${origin}/${action}`);
    }
  }
  for (const event of ['disable', 'password_reset', 'role_change']) {
    for (const scoped of [false, true]) {
      const c = revocation.cases.find(c => c.event === event && c.scoped_access === scoped);
      assert.ok(c, `${event}/${scoped} coverage`);
      assert.ok(c.assertions.some(a => a.after === 'commit' && a.token === 'old' && a.decision === 'deny'));
      assert.ok(c.assertions.some(a => a.after === 'restart_and_cache_reload' && a.token === 'old' && a.decision === 'deny'));
    }
  }
  const doc = fs.readFileSync(path.join(DIR, 'v1.md'), 'utf8');
  for (const question of manifest.open_questions) assert.ok(doc.includes(question));
  console.log(`authority contract: OK (${inventory.routes.length} routes, ${inventory.inline_bearer_nodes.length} inline verifiers, ${inventory.module_consumers.length} module consumers, ${authority.cases.length} authority cases, ${revocation.cases.length} revocation cases)`);
}
if (require.main === module) {
  try { verify(); } catch (error) { console.error(`authority contract: FAIL: ${error.message}`); process.exitCode = 1; }
}
module.exports = { verify };
