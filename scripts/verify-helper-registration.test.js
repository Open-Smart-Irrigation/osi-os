'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectHelperNames, checkRegistryParity, checkSurfaces, checkCodecs, inspectModuleDir, checkCallerNames,
} = require('./verify-helper-registration');

const NAME_TO_PATH = {
  'history-sync': 'osi-history-sync-helper',
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform',
};

function fixtures(overrides = {}) {
  return {
    name: 'osi-history-sync-helper',
    packageJson: { dependencies: { 'osi-history-sync-helper': 'file:osi-history-sync-helper' } },
    packageLock: { packages: {
      '': { dependencies: { 'osi-history-sync-helper': 'file:osi-history-sync-helper' } },
      'node_modules/osi-history-sync-helper': { resolved: 'osi-history-sync-helper', link: true },
      'osi-history-sync-helper': { version: '1.0.0' },
    } },
    seedSource: 'for module in osi-db-helper osi-history-sync-helper osi-lib; do\n',
    deploySource: [
      '"/srv/node-red/osi-history-sync-helper/package.json"',
      '"/srv/node-red/osi-history-sync-helper/index.js"',
    ].join('\n'),
    moduleDir: { hasDir: true, hasPackageJson: true, hasMain: true, mainName: 'index.js' },
    ...overrides,
  };
}

test('collectHelperNames: unions file: deps with non-codec NAME_TO_PATH values', () => {
  const names = collectHelperNames({
    packageJson: { dependencies: { bcryptjs: '3.0.3', 'osi-db-helper': 'file:osi-db-helper' } },
    nameToPath: NAME_TO_PATH,
  });
  assert.deepEqual(names, ['osi-db-helper', 'osi-history-sync-helper']); // codec entry excluded
});

test('checkRegistryParity: mirrored osi-lib registries must be byte-for-byte equivalent mappings', () => {
  assert.deepEqual(checkRegistryParity(NAME_TO_PATH, { ...NAME_TO_PATH }), []);
  assert.match(checkRegistryParity(NAME_TO_PATH, { ...NAME_TO_PATH, 'sdi12-recipe': 'osi-sdi12-recipe' })[0], /NAME_TO_PATH/);
});

test('checkSurfaces: fully registered helper produces no issues', () => {
  assert.deepEqual(checkSurfaces(fixtures()), []);
});

test('checkSurfaces: each missing surface is reported', () => {
  assert.match(checkSurfaces(fixtures({ packageJson: { dependencies: {} } })).join(' '), /runtime package\.json/);
  assert.match(checkSurfaces(fixtures({ packageLock: { packages: { '': { dependencies: {} } } } })).join(' '), /package-lock\.json/);
  assert.match(checkSurfaces(fixtures({ seedSource: 'for module in osi-db-helper; do\n' })).join(' '), /98_osi_node_red_seed/);
  assert.match(checkSurfaces(fixtures({ deploySource: '' })).join(' '), /deploy\.sh/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: false } })).join(' '), /directory missing/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: true, hasPackageJson: false, hasMain: true, mainName: 'index.js' } })).join(' '), /package\.json missing/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: true, hasPackageJson: true, hasMain: false, mainName: 'index.js' } })).join(' '), /main file/);
});

test('checkSurfaces: lockfile must carry both the node_modules link and local package metadata', () => {
  const fixture = fixtures();
  delete fixture.packageLock.packages['osi-history-sync-helper'];

  const issues = checkSurfaces(fixture);

  assert.equal(issues.length, 1);
  assert.match(issues[0], /local package metadata/);
});

test('checkCodecs: codec entries need a deploy.sh fetch line + the file on disk', () => {
  const issues = checkCodecs({ nameToPath: NAME_TO_PATH, deploySource: '', codecsDir: '/nonexistent' });
  assert.equal(issues.length, 2);
  assert.match(issues[0], /agroscope_uplink_transform\.js.*deploy\.sh/);
  assert.match(issues[1], /agroscope_uplink_transform\.js.*missing under/);
});

test('inspectModuleDir warns on malformed package metadata while preserving fallback main', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-helper-registration-'));
  try {
    const dir = path.join(base, 'bad-helper');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{bad json');
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    const warnings = [];

    const result = inspectModuleDir(base, 'bad-helper', (message) => warnings.push(message));

    assert.deepEqual(result, {
      hasDir: true,
      hasPackageJson: true,
      hasMain: true,
      mainName: 'index.js',
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bad-helper\/package\.json/);
    assert.match(warnings[0], /Expected property name/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// osi-command-ledger reaches a gateway only through deploy.sh's pinned staging
// path (fetch into a private stage directory, digest check, deferred
// activation after the schema migration), never through a direct fetch into
// /srv/node-red. The verifier accepts that path for that module only, and
// asserts every part of it so the check cannot go blind.
function stagedLedgerDeploy(omit = []) {
  const lines = {
    packageFetch: '    "$COMMAND_LEDGER_STAGE/osi-command-ledger/package.json"',
    indexFetch: '    "$COMMAND_LEDGER_STAGE/osi-command-ledger/index.js"',
    packagePin: 'COMMAND_LEDGER_PACKAGE_SHA256="' + 'a'.repeat(64) + '"',
    indexPin: 'COMMAND_LEDGER_INDEX_SHA256="' + 'b'.repeat(64) + '"',
    stageDef: 'stage_command_ledger_dependency() {\n}',
    activateDef: 'activate_command_ledger_dependency() {\n}',
    stageCall: 'stage_command_ledger_dependency',
    activateCall: 'activate_command_ledger_dependency || exit 1',
  };
  return Object.entries(lines).filter(([key]) => !omit.includes(key)).map(([, line]) => line).join('\n');
}

function ledgerFixtures(deploySource) {
  const name = 'osi-command-ledger';
  return fixtures({
    name,
    packageJson: { dependencies: { [name]: 'file:' + name } },
    packageLock: { packages: {
      '': { dependencies: { [name]: 'file:' + name } },
      ['node_modules/' + name]: { resolved: name, link: true },
      [name]: { version: '1.0.0' },
    } },
    seedSource: 'for module in osi-db-helper ' + name + ' osi-lib; do\n',
    deploySource,
  });
}

test('checkSurfaces: the command ledger may be delivered by the pinned staging path', () => {
  assert.deepEqual(checkSurfaces(ledgerFixtures(stagedLedgerDeploy())), []);
});

test('checkSurfaces: the command ledger delivered by neither path fails', () => {
  const issues = checkSurfaces(ledgerFixtures('')).join(' ');
  assert.match(issues, /osi-command-ledger: missing package\.json fetch_required in deploy\.sh/);
  assert.match(issues, /osi-command-ledger: missing index\.js fetch_required in deploy\.sh/);
});

test('checkSurfaces: every part of the staged ledger path is asserted', () => {
  for (const part of ['packageFetch', 'indexFetch', 'packagePin', 'indexPin', 'stageDef', 'activateDef', 'stageCall', 'activateCall']) {
    const issues = checkSurfaces(ledgerFixtures(stagedLedgerDeploy([part])));
    assert.ok(issues.length > 0, 'missing ' + part + ' must be reported');
    assert.match(issues.join(' '), /osi-command-ledger/, part);
  }
});

test('checkSurfaces: the staged path is accepted only for the module it delivers', () => {
  const staged = stagedLedgerDeploy().replace(/osi-command-ledger/g, 'osi-history-sync-helper');
  assert.match(checkSurfaces(fixtures({ deploySource: staged })).join(' '), /fetch_required in deploy\.sh/);
});

test('the shipped deploy.sh delivers the command ledger through the staged path', () => {
  const deploySource = fs.readFileSync(path.join(__dirname, '..', 'deploy.sh'), 'utf8');
  assert.deepEqual(checkSurfaces(ledgerFixtures(deploySource)), []);
});

// Caller names (#564): a function node's osiLib.require('<name>') must name a
// key of its profile's NAME_TO_PATH. Merge Data asked for 'history-helper',
// which no registry listed, and every gateway silently dropped rain_day.
const CALLER_REGISTRY = { rain: 'osi-rain', 'history-helper': 'osi-history-helper' };
const OSI_LIB = [{ var: 'osiLib', module: 'osi-lib' }];

function fnNode(func, extra = {}) {
  return { id: 'n1', type: 'function', name: 'Node One', func, libs: OSI_LIB, ...extra };
}

function callerIssues(nodes, nameToPath = CALLER_REGISTRY) {
  return checkCallerNames({ flows: nodes, nameToPath });
}

test('checkCallerNames: registered names pass and every call is counted', () => {
  const result = callerIssues([fnNode([
    "const a = osiLib.require('rain');",
    'const b = osiLib . require ( "history-helper" );',
    'const c = osiLib?.require(`rain`);',
  ].join('\n'))]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.calls, 3);
});

test('checkCallerNames: an unregistered name fails with node and name', () => {
  const result = callerIssues([fnNode("const h = osiLib.require('history-helper');")], { rain: 'osi-rain' });
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /n1 \(Node One\)/);
  assert.match(result.issues[0], /'history-helper' is not a NAME_TO_PATH key/);
});

test('checkCallerNames: a misspelled name fails', () => {
  const result = callerIssues([fnNode("const h = osiLib.require('history-helpr');")]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /'history-helpr'/);
});

test('checkCallerNames: the loader variable is whatever libs binds to osi-lib', () => {
  const renamed = fnNode("lib.require('nope'); osiLib.require('also-nope');", {
    libs: [{ var: 'lib', module: 'osi-lib' }],
  });
  const result = callerIssues([renamed]);
  assert.equal(result.calls, 1);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /'nope'/);

  const notALoader = fnNode("osiDb.require('nope');", { libs: [{ var: 'osiDb', module: 'osi-db-helper' }] });
  assert.deepEqual(callerIssues([notALoader]), { issues: [], calls: 0 });
});

test('checkCallerNames: comments, strings and other require methods do not count', () => {
  const result = callerIssues([fnNode([
    "// osiLib.require('nope-line-comment')",
    "/* osiLib.require(\"nope-block-comment\") */",
    "const s = \"osiLib.require('nope-string')\";",
    "const t = `osiLib.require('nope-template')`;",
    "const fs = require('fs');",
    "other.require('nope-other');",
    "myosiLib.require('nope-prefix');",
    "x.osiLib.require('nope-member');",
    "osiLib.requireAll('nope-method');",
    "const ok = osiLib.require('rain');",
  ].join('\n'))]);
  assert.deepEqual(result, { issues: [], calls: 1 });
});

test('checkCallerNames: a name that is not one plain string literal fails', () => {
  for (const call of [
    'osiLib.require(name)',
    "osiLib.require('ra' + 'in')",
    'osiLib.require(`${name}`)',
    "osiLib.require('rain', extra)",
    "osiLib.require('ra\\x69n')",
  ]) {
    const result = callerIssues([fnNode(call + ';')]);
    assert.equal(result.issues.length, 1, call);
    assert.match(result.issues[0], /not one plain string literal/, call);
  }
});

test('checkCallerNames: initialize and finalize are scanned; other node types are not', () => {
  const result = callerIssues([
    fnNode("osiLib.require('rain');", { initialize: "osiLib.require('nope-init');", finalize: "osiLib.require('nope-final');" }),
    { id: 'c1', type: 'comment', func: "osiLib.require('nope-comment-node');", libs: OSI_LIB },
  ]);
  assert.equal(result.calls, 3);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues.join(' '), /initialize.*'nope-init'/);
  assert.match(result.issues.join(' '), /finalize.*'nope-final'/);
});

test('every shipped osi-lib caller names a registered module, in both profiles', () => {
  for (const soc of ['bcm2712', 'bcm2709']) {
    const share = path.join(__dirname, '..', 'conf', `full_raspberrypi_bcm27xx_${soc}`, 'files', 'usr', 'share');
    const flows = JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8'));
    const { NAME_TO_PATH: nameToPath } = require(path.join(share, 'node-red', 'osi-lib')); // eslint-disable-line global-require
    const result = checkCallerNames({ flows, nameToPath });
    assert.deepEqual(result.issues, [], soc);
    assert.ok(result.calls > 0, soc + ': the scan found no osi-lib calls');
  }
});
