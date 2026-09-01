const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..');
const INSTALLER = path.join(REPO, 'scripts', 'install-node-red-dependencies.sh');

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-node-red-install-'));
  const nodeRedDir = path.join(root, 'node-red');
  const systemSqliteDir = path.join(root, 'system-sqlite3');
  const npmLog = path.join(root, 'npm-args.log');
  const fakeNpm = path.join(root, 'npm');

  fs.mkdirSync(path.join(nodeRedDir, 'node_modules'), { recursive: true });
  fs.mkdirSync(systemSqliteDir, { recursive: true });
  fs.writeFileSync(path.join(systemSqliteDir, 'package.json'), JSON.stringify({ name: 'sqlite3', main: 'index.js' }));
  fs.writeFileSync(path.join(systemSqliteDir, 'index.js'), 'module.exports = { source: "openwrt" };\n');
  fs.writeFileSync(path.join(nodeRedDir, 'package.json'), JSON.stringify({ dependencies: { sqlite3: '^5.1.7' } }));
  fs.writeFileSync(path.join(nodeRedDir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { sqlite3: '^5.1.7' } },
      'node_modules/protobufjs': { hasInstallScript: true },
      'node_modules/sqlite3': { hasInstallScript: true }
    }
  }));

  writeExecutable(fakeNpm, `#!/bin/sh
set -eu
echo "$*" >> "$NPM_TEST_LOG"
if [ "$1" = "install" ]; then
  case " $* " in
    *" --ignore-scripts "*) ;;
    *) exit 91 ;;
  esac
  rm -rf node_modules/sqlite3
  mkdir -p node_modules/sqlite3
  echo broken > node_modules/sqlite3/from-registry
fi
exit "\${NPM_TEST_EXIT:-0}"
`);

  return { root, nodeRedDir, systemSqliteDir, npmLog, fakeNpm };
}

function runInstaller(f, extraEnv = {}) {
  return spawnSync('sh', [INSTALLER], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_RED_DIR: f.nodeRedDir,
      SYSTEM_SQLITE3_DIR: f.systemSqliteDir,
      NPM_BIN: f.fakeNpm,
      NODE_BIN: process.execPath,
      NPM_TEST_LOG: f.npmLog,
      ...extraEnv
    }
  });
}

test('installer skips registry lifecycle scripts, restores OpenWrt sqlite3, and rebuilds protobufjs only', () => {
  const f = fixture();
  try {
    const result = runInstaller(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.realpathSync(path.join(f.nodeRedDir, 'node_modules', 'sqlite3')), f.systemSqliteDir);
    assert.deepEqual(fs.readFileSync(f.npmLog, 'utf8').trim().split('\n'), [
      'install --ignore-scripts --omit=dev --no-fund --no-audit',
      'rebuild protobufjs --no-fund --no-audit'
    ]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('installer restores OpenWrt sqlite3 when npm fails after replacing the link', () => {
  const f = fixture();
  try {
    const result = runInstaller(f, { NPM_TEST_EXIT: '17' });
    assert.equal(result.status, 17, result.stderr || result.stdout);
    assert.equal(fs.realpathSync(path.join(f.nodeRedDir, 'node_modules', 'sqlite3')), f.systemSqliteDir);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
