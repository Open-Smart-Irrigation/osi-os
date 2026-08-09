#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INIT = path.join(
  ROOT,
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init',
);
const CONFIGS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config',
].map((relativePath) => path.join(ROOT, relativePath));

function validate(root, cache = '4294967296', reserve = '4294967296') {
  return spawnSync('/bin/sh', [
    '-c',
    '. "$1"; validate_journal_media_settings "$2" "$3" "$4"',
    'journal-config-test', INIT, cache, reserve, root,
  ], { encoding: 'utf8' });
}

test('journal media settings accept positive safe integers and an exact canonical root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = validate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), root);
});

test('journal byte limits reject zero, negative, non-numeric, and unsafe integers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const value of ['0', '-1', '1.5', 'unsafe', '9007199254740992']) {
    const result = validate(root, value);
    assert.notEqual(result.status, 0, value + ' accepted');
  }
});

test('journal media root rejects symlinks and non-canonical spellings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-config-'));
  const link = root + '-link';
  fs.symlinkSync(root, link, 'dir');
  t.after(() => {
    fs.rmSync(link, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.notEqual(validate(link).status, 0);
  assert.notEqual(validate(root + '/child/../').status, 0);

  const escapedChild = path.join(link, 'must-not-be-created');
  assert.notEqual(validate(escapedChild).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'must-not-be-created')), false);
});

test('journal UCI defaults are absent-only and preserve operator overrides on rerun', () => {
  for (const configPath of CONFIGS) {
    const source = fs.readFileSync(configPath, 'utf8');
    const unconditionalBatch = source.match(/uci -q batch <<EOF\n([\s\S]*?)\nEOF/);
    assert.ok(unconditionalBatch, configPath);
    for (const key of [
      'journal_photo_cache_bytes', 'journal_min_free_bytes', 'journal_media_root',
    ]) {
      assert.doesNotMatch(unconditionalBatch[1], new RegExp('osi-server\\.cloud\\.' + key));
      assert.match(source, new RegExp(
        'uci -q get osi-server\\.cloud\\.' + key + '[\\s\\S]*?' +
        'uci set osi-server\\.cloud\\.' + key,
      ));
    }
  }
});
