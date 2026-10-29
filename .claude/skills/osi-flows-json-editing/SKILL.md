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

## Where new logic goes

New features do not go into `flows.json`. Put the logic in a tested `osi-*`
module, register it in `osi-lib`, and add a thin function node that loads it with
`osiLib.require`. `verify-flows-size-ratchet.js` enforces this against
`origin/main`: no existing node may grow, the total may not increase, and a new
node is at most 1,536 chars and over 400 chars only if it loads its logic through
`osiLib.require`. When a bug fix has to touch a large node, move the code you
touch into a module so the node shrinks.

The only exception is for a bug fix that cannot wait for an extraction. Run the
ratchet on the fix branch; on failure it prints the entry to add to
`scripts/flows-growth-exceptions.json`. Merge that entry in its own PR first:
the gate reads the file from the base ref, so a PR cannot grant itself growth.
The entry lets its listed nodes grow for 14 days; other code cannot use that
room. From day 14 every run fails until the per-profile total is back at or
below the entry's `payback_total`, and the entry cannot be deleted before then,
so plan the extraction when you file the exception. Payback is measured on the
total, so a second fix filed while an earlier entry is outstanding is due by the
earlier date, and a new entry cannot be added until expired ones are deleted.
Size counts a node's On Start and On Stop code too.

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
| Flows size ratchet | `node scripts/verify-flows-size-ratchet.js` | exit 0; no node grew, new nodes are wiring (≤ 1,536 chars; over 400 only via `osiLib.require`), total embedded JS did not increase |
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

## Function-node rules

Each rule below is also in `references/function-node-conventions.md`, under the section named before it, with its code precedent.

"In-repo seam modules: bind `osiLib`, load with `osiLib.require()`":

`osiLib.require(name)` never throws. It always returns either
`{ ok: true, value }` or `{ ok: false, error, quarantined? }` — check `.ok`
before touching `.value`, and on `ok: false` call `node.error(...)` and
return, exactly as above.

"Guarded shared-module locals: `global.get(...)`, not `libs`":

Do not add `fs`/`os`/`cp` to a node's `libs` array — that binding mechanism is
for npm modules declared in `settings.js`'s external-modules allowlist, and
mixing the two patterns on the same variable is confusing and redundant.

"Every opened DB handle must be closed":

Any function node that does `new osiDb.Database(...)` must also call
`.close(` somewhere in the same function body.

"Function nodes must never crash the flow":

Wrap every sysfs/file/subprocess read in its own `try/catch` that resolves to
`null` for that one reading — a sampler failing to read one sysfs path must
never take down the rest of the function or the flow.

Always declare-with-default before the `try`, assign inside it, and never
`const`/`let` a name inside `try{}` that anything outside the block needs.

"Authenticated HTTP endpoints":

For a gated HTTP endpoint, copy the auth block verbatim from the newest shipped
endpoint with the same auth mode, then diff your block against that precedent.
Do not retype timing-safe HMAC checks, expiry checks, or token parsing from
memory.

Every code path must send exactly one HTTP response: success, validation
failure, auth failure, not-found, and exception paths all terminate in one
`http response` node or one response send. A route that sometimes returns no
response is a silent hang; a route that sends twice becomes a Node-RED runtime
error.

Two clusters are explicitly hot/frozen and need a blast-radius check before
any touch:
- The **heartbeat cluster** (`Build Heartbeat` / `062a0f9bf66d9789` and its
  MQTT wiring) — read for precedent, do not modify without checking who else
  reads/writes it.
- The **`sync-init-fn`** boot-DDL node ("Sync Init Schema + Triggers") — fully
  FROZEN for new schema behavior. Policy and the narrow sanctioned exception
  (guarded `devices` rebuild) live in `osi-schema-change-control`; this skill
  only tells you to route there.

Before editing any shared node, run a blast-radius grep:

The script is in `references/function-node-conventions.md`.

## References

- `references/edit-script.md`: Read when writing the one-shot edit script: expected roundtrip output and the complete skeleton. Sections: "Expected roundtrip-check output"; "Complete script skeleton".
- `references/function-node-conventions.md`: Read before writing or changing a function node: `libs`, `osiLib.require`, `global.get`, DB handles, try/catch scoping, auth blocks, node ids, placement. Sections: "Function-node conventions (verified against real nodes in this repo)"; "npm modules: bind via `libs`, not `functionExternalModules` alone"; "In-repo seam modules: bind `osiLib`, load with `osiLib.require()`"; "Guarded shared-module locals: `global.get(...)`, not `libs`"; "Every opened DB handle must be closed"; "Function nodes must never crash the flow"; "Empty catches are ratcheted"; "Authenticated HTTP endpoints"; "No ad hoc DDL in flows.json"; "Placement: additive over teeing".
- `references/guards-and-parity.md`: Read when a guard fails or to see what `test-flows-wiring.js`, profile parity and the MQTT topic check enforce. Sections: "Guard tests: `scripts/test-flows-wiring.js`"; "Profile parity"; "MQTT IN topic rule".
- `references/pitfalls-and-maintenance.md`: Read when a flow edit misbehaves, or to re-verify this skill against the repo. Sections: "Common mistakes"; "Provenance and maintenance".
