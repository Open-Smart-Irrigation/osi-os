# census source (c) generator

`generate.js` builds one census source per historical release: it boots that
release's own flows and boot node headlessly, in the T1 oracle style, and
drives the release's own writers through its HTTP routes and MQTT uplinks so
the tables the aged fixtures leave empty get rows written by the release
itself. Example identifiers only (gateway `0016C001F1000001`, devices
`A840410000000001`..`A840410000000003`); it prints counts and per-step
statuses, never a row value.

```bash
npm ci --prefix scripts/fixtures/release-smoke --no-audit --no-fund   # under the pinned Node
node edge/harness/census/generate.js --ref 904491b1 --label v0.8.3 \
  --census-out <spike>/census/gen-v0.8.3.json --work <scratch>/v0.8.3
```

What it does, per ref (a tag, or `904491b1` for v0.8.3, which has no tag):

1. `git archive` of the ref into `<work>/tree`; the ref's own
   `database/farming.db` seed goes to `<work>/run/data/db/farming.db`.
2. Spawns `edge/harness/oracle-node-red.js` with `OSI_SMOKE_SOURCE` pointed
   at that tree, under the pinned oracle Node (`OSI_CENSUS_ORACLE_NODE`,
   default 20.18.3 — the release-smoke workflow pin; the sqlite3 binding is
   ABI-bound to it). The tag's flows, helpers and codecs run; the Node-RED
   and sqlite3 modules come from the release-smoke lock.
3. Registers and logs in, creates a zone over HTTP, inserts the three
   devices as fixture setup (the release-smoke pattern), then drives the
   writers: KIWI uplinks; a WATERMARK calibration plus LSN50 profile-3
   frames; STREGA opens, valve reports, a second open, cancel and close;
   valve ticks; the threshold schedule and a scheduler tick (injects are
   found by walking the wiring backwards from the irrigation-events writer,
   skipping disabled tabs); the weekly valve plan; journal plot, plot-group
   and draft-entry writes. Steps whose routes do not exist at that release
   are skipped and recorded in `<work>/steps.json`.
4. Stops the oracle and runs `edge/harness/typeof-census.js --json` on the
   result, writing `<census-out>`.

Env: `OSI_CENSUS_HARNESS_ROOT` (default this repo), `OSI_CENSUS_ORACLE_NODE`,
`OSI_CENSUS_SYSTEM_NODE`. Scratch DBs, step logs and census JSONs stay
outside the repository; only this generator and README are committed.
