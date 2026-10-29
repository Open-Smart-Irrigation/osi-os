# Edit script

Part of the osi-flows-json-editing skill; read SKILL.md first.

## Expected roundtrip-check output

Expected roundtrip-check output shape after you rerun it in the current branch:

```
$ node roundtrip-check.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
byte-identical: true   (<current bytes> / <current bytes>)

$ node roundtrip-check.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
byte-identical: true   (<current bytes> / <current bytes>)
```

Do not reuse old byte counts as proof. Fresh output from the branch you are
editing is the evidence.

## Complete script skeleton

Save this in your scratchpad (e.g. `flows-edit.js`), read it fully, adapt the
`MUTATE` section, then run it with plain `node`. Before writing anything it
runs the mandatory roundtrip guard on both profile copies and refuses when the
two copies differ; then it writes both.

```js
#!/usr/bin/env node
// One-shot flows.json editor skeleton. Run from the repo root.
// Usage: node flows-edit.js
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd(); // run from repo root; verify with `pwd` first
const CANONICAL = path.join(
  REPO_ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const MIRROR = path.join(
  REPO_ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function assertRoundtripByteIdentical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  const reserialized = serialize(parsed);
  if (Buffer.compare(original, reserialized) !== 0) {
    throw new Error(
      `Roundtrip guard failed for ${filePath}: file formatting has drifted ` +
      `from JSON.stringify(x, null, 2) + '\\n'. STOP and investigate before mutating.`
    );
  }
  return parsed;
}

// --- Step 1: guard BOTH profiles, then load canonical (nothing is written yet) ---
const flows = assertRoundtripByteIdentical(CANONICAL);
assertRoundtripByteIdentical(MIRROR);
// Step 3 overwrites the mirror with the canonical result, so a mirror that
// differs now would lose its own bytes. The roundtrip guard cannot catch this:
// two different, correctly formatted files each pass it.
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) {
  throw new Error(
    'Profile copies differ before mutation. STOP: reconcile them ' +
    '(node scripts/verify-profile-parity.js) before running this edit.'
  );
}
console.log('Pre-write guards OK on both profiles. Node count:', flows.length);

// --- Step 2: MUTATE (edit this section for your change) ---
// Example: add a new, fully self-contained inject + function node pair.
// Mint a NEW id — never reuse or regenerate an existing id. Real ids in this
// file are either a 16-lowercase-hex-char Node-RED-generated id (e.g.
// "062a0f9bf66d9789", the Build Heartbeat node) or a short descriptive slug
// (e.g. "auth-db-query"). Prefer the hex form for new nodes to avoid clashes;
// generate one with: node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"
const NEW_FUNCTION_ID = 'REPLACE_WITH_FRESH_16_HEX_ID';
const NEW_INJECT_ID = 'REPLACE_WITH_ANOTHER_FRESH_16_HEX_ID';

const exampleFunctionNode = {
  id: NEW_FUNCTION_ID,
  type: 'function',
  z: 'REPLACE_WITH_TARGET_TAB_ID', // copy z from a neighboring node in the same tab
  name: 'Example Sampler',
  func: [
    "let value = null;",
    "try {",
    "  const fs = global.get('fs');", // functionGlobalContext local, NOT an npm module — no libs entry needed
    "  value = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());",
    "} catch (e) {",
    "  node.warn('Example Sampler read failed: ' + (e && e.message ? e.message : e));",
    "}",
    "msg.payload = { value };",
    "return msg;",
  ].join('\n'),
  outputs: 1,
  // libs only needed for real npm modules bound via settings.js functionExternalModules,
  // e.g. [{ var: 'osiDb', module: 'osi-db-helper' }] — see "Function-node conventions" below.
  // In-repo seam modules: bind osiLib and call osiLib.require('<name>') — see "In-repo seam modules" below.
  libs: [],
  x: 400,
  y: 400,
  wires: [[]],
};

const exampleInjectNode = {
  id: NEW_INJECT_ID,
  type: 'inject',
  z: 'REPLACE_WITH_TARGET_TAB_ID',
  name: 'Example Tick (60s)',
  props: [{ p: 'payload' }],
  repeat: '60',
  crontab: '',
  once: true,
  onceDelay: 5,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 180,
  y: 400,
  wires: [[NEW_FUNCTION_ID]],
};

flows.push(exampleInjectNode, exampleFunctionNode);

// --- Step 3: write canonical, then mirror ---
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
console.log('Wrote canonical + mirror. New node count:', flows.length);

// --- Step 4: re-run the roundtrip guard on what you just wrote ---
assertRoundtripByteIdentical(CANONICAL);
assertRoundtripByteIdentical(MIRROR);
console.log('Post-write roundtrip guard OK on both profiles.');
```

After running this, always run the full pre-commit checklist (below) before
considering the edit done.
