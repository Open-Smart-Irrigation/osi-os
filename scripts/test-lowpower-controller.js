#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const controllerPath = path.join(
  repoRoot,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-lowpower-window.sh'
);

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-lowpower-controller-'));
  const bin = path.join(root, 'bin');
  const stateFile = path.join(root, 'window.env');
  const logFile = path.join(root, 'calls.log');
  fs.mkdirSync(bin);

  writeExecutable(path.join(bin, 'uci'), `#!/bin/sh
if [ "$1" = "-q" ]; then shift; fi
cmd="$1"
shift || true
case "$cmd:$1" in
  get:osi-lowpower.main.enabled) printf '%s\\n' "\${LOWPOWER_ENABLED:-1}" ;;
  get:osi-lowpower.main.window_start) printf '%s\\n' "\${LOWPOWER_WINDOW_START:-00:00}" ;;
  get:osi-lowpower.main.window_duration_minutes) printf '%s\\n' "\${LOWPOWER_WINDOW_DURATION:-1440}" ;;
  get:osi-lowpower.main.usb_control) printf '%s\\n' "\${LOWPOWER_USB_CONTROL:-0}" ;;
  get:osi-lowpower.main.usb_hubs) printf '%s\\n' "\${LOWPOWER_USB_HUBS:-}" ;;
  get:osi-lowpower.main.eth_control) printf '%s\\n' "\${LOWPOWER_ETH_CONTROL:-0}" ;;
  get:osi-lowpower.main.eth_ifname) printf '%s\\n' "\${LOWPOWER_ETH_IFNAME:-eth0}" ;;
  get:osi-lowpower.main.wifi_txpower) printf '%s\\n' "\${LOWPOWER_WIFI_TXPOWER:-12}" ;;
  get:osi-lowpower.main.state_file) printf '%s\\n' "$LOWPOWER_STATE_FILE" ;;
  get:osi-lowpower.main.health_url) printf '%s\\n' "\${LOWPOWER_HEALTH_URL:-}" ;;
  get:wireless.radio0.txpower) printf '%s\\n' "\${WIRELESS_TXPOWER:-}" ;;
  set:*) printf 'uci set %s\\n' "$1" >> "$LOWPOWER_CALL_LOG" ;;
  commit:*) printf 'uci commit %s\\n' "$1" >> "$LOWPOWER_CALL_LOG" ;;
  batch:*) cat >/dev/null ;;
  *) exit 1 ;;
esac
`);

  writeExecutable(path.join(bin, 'wifi'), `#!/bin/sh
printf 'wifi %s\\n' "$*" >> "$LOWPOWER_CALL_LOG"
`);

  writeExecutable(path.join(bin, 'ip'), `#!/bin/sh
if [ "$1" = "route" ] && [ "$2" = "show" ] && [ "$3" = "default" ]; then
  if [ "\${LOWPOWER_DEFAULT_ROUTE:-0}" = "1" ]; then
    printf 'default via 192.0.2.1 dev eth0\\n'
  fi
  exit 0
fi
printf 'ip %s\\n' "$*" >> "$LOWPOWER_CALL_LOG"
`);

  writeExecutable(path.join(bin, 'sleep'), `#!/bin/sh
printf 'sleep %s\\n' "$*" >> "$LOWPOWER_CALL_LOG"
`);

  writeExecutable(path.join(bin, 'uhubctl'), `#!/bin/sh
printf 'uhubctl %s\\n' "$*" >> "$LOWPOWER_CALL_LOG"
`);

  writeExecutable(path.join(bin, 'wget'), `#!/bin/sh
printf 'wget %s\\n' "$*" >> "$LOWPOWER_CALL_LOG"
exit 1
`);

  writeExecutable(path.join(bin, 'logger'), `#!/bin/sh
printf 'logger %s\\n' "$*" >> "$LOWPOWER_CALL_LOG"
`);

  function run(args, envPatch) {
    fs.writeFileSync(logFile, '');
    const result = spawnSync('sh', [controllerPath].concat(args), {
      cwd: repoRoot,
      env: Object.assign({}, process.env, {
        PATH: `${bin}:${process.env.PATH}`,
        LOWPOWER_CALL_LOG: logFile,
        LOWPOWER_STATE_FILE: stateFile,
      }, envPatch || {}),
      encoding: 'utf8',
    });
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    return Object.assign(result, { log, stateFile });
  }

  return { root, stateFile, logFile, run };
}

try {
  {
    const harness = createHarness();
    const result = harness.run(['apply-wifi'], {
      LOWPOWER_WIFI_TXPOWER: '12',
      WIRELESS_TXPOWER: '12',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.log.includes('uci set wireless.radio0.txpower=12'), result.log);
    assert.ok(!result.log.includes('uci commit wireless'), result.log);
    assert.ok(!result.log.includes('wifi reload'), result.log);
    fs.rmSync(harness.root, { recursive: true, force: true });
  }

  {
    const harness = createHarness();
    fs.writeFileSync(harness.stateFile, [
      'OSI_LOWPOWER_ENABLED=1',
      'OSI_LOWPOWER_WINDOW_STATE=open',
      'OSI_LOWPOWER_WINDOW_OPENED_AT=2026-06-25T00:00:00Z',
      'OSI_LOWPOWER_WINDOW_CLOSES_AT=2026-06-26T00:00:00Z',
      'OSI_LOWPOWER_REASON=scheduled',
    ].join('\n') + '\n');
    const result = harness.run(['reconcile'], {
      LOWPOWER_WINDOW_START: '00:00',
      LOWPOWER_WINDOW_DURATION: '1440',
      LOWPOWER_DEFAULT_ROUTE: '0',
      LOWPOWER_WIFI_TXPOWER: '12',
      WIRELESS_TXPOWER: '12',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.log.includes('sleep '), result.log);
    fs.rmSync(harness.root, { recursive: true, force: true });
  }

  console.log('Low-power controller tests passed.');
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
