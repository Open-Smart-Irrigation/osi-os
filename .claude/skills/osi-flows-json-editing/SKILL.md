---
name: osi-flows-json-editing
description: "Use before any edit to flows.json (either profile): function nodes, HTTP endpoints, injects, MQTT IN nodes, REST routes, scheduler or sync orchestration, or wiring a helper module into a function node."
---

# OSI Flows.json Editing

## Overview

`flows.json` is the Node-RED flow definition that IS the edge backend for OSI OS:
REST API routes, the scheduler, sync orchestration, and sensor ingest are all
nodes in this one JSON array. The maintained copies are formatted as
`JSON.stringify(flows, null, 2) + '\n'`, but node counts and byte counts drift as
features land. Re-measure them in the current branch before citing them. The
canonical copy at
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` must be
mirrored byte-for-byte into
`conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`.

This skill covers the mechanics of making a safe, wiring-correct edit to that
file — not deploying it, diagnosing a live symptom, schema/migration changes,
sensor semantics, or env-var/flag semantics (see "When NOT to use").

## When to use / When NOT to use

Use this skill when you are about to:
- Add, remove, or modify a node in either `flows.json` copy (function, http in/out,
  inject, mqtt in/out, link in/out, etc.).
- Add a new REST endpoint or scheduler tick.
- Wire a new npm module or shared helper (`osi-db-helper`, `osi-cloud-http`,
  `osi-chameleon-helper`, `osi-dendro-helper`) into a function node.
- Change existing wiring (a node's `wires` array) between nodes.

Do NOT use this skill, and instead go to the named sibling, when you are:
- Diagnosing a live symptom (hanging endpoint, 404 flood, silent crash on a
  running Pi) — go to `osi-debugging-playbook` first; come back here once you
  know which node to change.
- Deploying an edited `flows.json` to a live or demo Pi — go to
  `osi-live-ops-runbook`.
- Changing SQLite schema, adding a migration, or touching the frozen boot-DDL
  node (`sync-init-fn` / "Sync Init Schema + Triggers") for schema behavior —
  go to `osi-schema-change-control`. That skill owns the FROZEN boot-DDL policy
  in full; this skill only tells you not to add schema DDL there.
- Deciding what a sensor field means, which device type owns which reading, or
  irrigation/agronomy semantics — go to `osi-agronomy-sensors-reference`.
- Looking up what an env var or `env.get(...)` flag controls — go to
  `osi-config-and-flags`.

## The iron rule

**`flows.json` is edited by a one-shot Node script, never by hand, never by
string patching, never by a text-replacement tool.** The file is machine-formatted
JSON; a manual edit that looks harmless (wrong quote style, wrong indentation,
reordered keys) silently breaks the byte-identical profile-parity check or,
worse, produces JSON Node-RED still parses but with subtly wrong structure.

Canonical procedure, every time:

1. Write a throwaway Node script in your scratchpad (never in the repo).
2. `JSON.parse` the current file.
3. Mutate the in-memory node array (push new nodes, edit `wires`, edit `func`,
   etc.).
4. `fs.writeFileSync(path, JSON.stringify(flows, null, 2) + '\n')`.
5. Do this for **both** `conf/full_raspberrypi_bcm27xx_bcm2712/.../flows.json`
   (canonical) and `conf/full_raspberrypi_bcm27xx_bcm2709/.../flows.json`
   (mirror) — either by running the mutation twice or by mutating the
   canonical file then `cp`-ing it over the mirror.

**Before any mutation**, verify the no-op roundtrip is byte-identical: read the
file, `JSON.parse` it, `JSON.stringify(parsed, null, 2) + '\n'`, and
`Buffer.compare` against the original bytes. If they are not identical, STOP —
either the file's real formatting has drifted from this assumption, or your
script has a serialization bug (e.g. wrong indent width, missing trailing
newline, a `Map`/`Set` in the mutation that doesn't round-trip). Do not
proceed with a real mutation until the no-op case is proven byte-identical.

Expected output of that check: `references/edit-script.md`, "Expected roundtrip-check output".

## Stable node ids

Never regenerate or reuse an existing node's `id` — every `wires` array in
every other node references ids directly, so changing one breaks wiring
silently (Node-RED will not error; the edge from the old id just stops
being a target). Real ids observed in this file take one of two forms:
16-lowercase-hex-character Node-RED-generated ids (e.g. `062a0f9bf66d9789`,
`c2b43a6c6e7d2c11`) or short descriptive slugs (e.g. `auth-db-query`,
`sync-init-fn`, `write-strega-expectation`). Re-measure the current distribution
if you need exact counts for a report.
For a new node, mint a fresh 16-hex id
(`node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"`)
or a new, clearly-unique descriptive slug if you are extending a named
subsystem — but never copy an id from an existing node "to be safe."

## Pre-commit checklist

Run every row before committing a `flows.json` change. All commands below run
from the repo root.

| Check | Command | Pass signal |
|---|---|---|
| Roundtrip byte-check ran on both profiles (before AND after your mutation) | your scratchpad roundtrip script | `byte-identical: true` for both `.../bcm2712/.../flows.json` and `.../bcm2709/.../flows.json` |
| Both profile copies updated | `git status --short` shows both `flows.json` paths changed together | both paths listed, never just one |
| Profile parity | `node scripts/verify-profile-parity.js` | ends `All parity checks passed.`, exit 0 |
| Sync flow verification (chains schema/history/parity checks) | `node scripts/verify-sync-flow.js` | prints `Sync flow verification passed` at the end of its own section, then chains profile parity; a healthy full run ends `All parity checks passed.`, exit 0 |
| MQTT topic compliance | `scripts/check-mqtt-topics.sh` | three `OK:` lines, one per flow copy, exit 0 |
| Flow wiring guards | `node scripts/test-flows-wiring.js` | ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`, exit 0 |
| Silent catch ratchet | `node scripts/verify-no-new-silent-catch.js` | exit 0; no new or worsened empty catches in maintained flow nodes |
| Stray DDL ratchet | `node scripts/verify-no-stray-ddl.js` | exit 0; no unreviewed DDL-marker count increase in flows/deploy surfaces |
| Flows size ratchet | `node scripts/verify-flows-size-ratchet.js` | exit 0; no node grew, no new node exceeds 4 KB, total embedded JS did not increase |
| Bare require scan | `node scripts/flows-bare-require-scan.js` | exit 0; no function node uses bare `require()` instead of `osiLib.require()` |
| Function-node parse | `node scripts/verify-flows-fn-parse.js` | ends `verify-flows-fn-parse: OK`, exit 0 — required for any function-node edit |
| Helper registration (only when adding or moving a helper/seam module) | `node scripts/verify-helper-registration.js` | exit 0; registry, loader test, and deploy.sh coverage all match |

If you intentionally changed a pinned wiring contract, update
`scripts/test-flows-wiring.js` in the same commit and say why in the commit
message — do not just make the test pass by weakening the assertion.

This checklist is the mechanical gate only. A non-trivial flows.json change is
a risk class and goes through the full risk-class loop
(`docs/engineering-playbook.md` §2: written plan, adversarial review,
independent verification by a non-author); §8 defines done, not a green
checklist.

## References

- `references/edit-script.md`: Read when writing the one-shot edit script: expected roundtrip output and the complete skeleton. Sections: "Expected roundtrip-check output"; "Complete script skeleton".
- `references/function-node-conventions.md`: Read before writing or changing a function node: `libs`, `osiLib.require`, `global.get`, DB handles, try/catch scoping, auth blocks, node ids, placement. Sections: "Function-node conventions (verified against real nodes in this repo)"; "npm modules: bind via `libs`, not `functionExternalModules` alone"; "In-repo seam modules: bind `osiLib`, load with `osiLib.require()`"; "Guarded shared-module locals: `global.get(...)`, not `libs`"; "Every opened DB handle must be closed"; "Function nodes must never crash the flow"; "Empty catches are ratcheted"; "Authenticated HTTP endpoints"; "No ad hoc DDL in flows.json"; "Placement: additive over teeing".
- `references/guards-and-parity.md`: Read when a guard fails or to see what `test-flows-wiring.js`, profile parity and the MQTT topic check enforce. Sections: "Guard tests: `scripts/test-flows-wiring.js`"; "Profile parity"; "MQTT IN topic rule".
- `references/pitfalls-and-maintenance.md`: Read when a flow edit misbehaves, or to re-verify this skill against the repo. Sections: "Common mistakes"; "Provenance and maintenance".
