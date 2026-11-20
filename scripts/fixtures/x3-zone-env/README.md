# X3 environment and run projection characterization

`legacy-nodes.json` freezes the four function nodes at base `ec822b556`. The
harness executes those bodies with a fixed clock, real SQLite, recorded HTTP
transport, and synthetic accounts and measurements. It records complete output
messages (including output-port placement), exact SQL and parameters, cache table
contents, diagnostics, module resolution, and database close calls.

`cases.json` and `expected.json` are captured before extracting the bodies. Capture
is an explicit maintenance operation; normal verification never rewrites them.
The SQL-failure cases fail each statement in the ordinary execution trace. Other
cases exercise shared-station reads, scoped account reads, provider transport,
authentication storage, and cache branches. The fixed response clock sits on the
Zurich autumn DST transition; separate cases cover spring and midnight.

Run from the repository root, with a private `TMPDIR` outside `/tmp`:

```sh
TZ=UTC node scripts/test-x3-zone-env-parity.js --legacy
TZ=UTC node scripts/test-x3-zone-env-parity.js --verify
TZ=Europe/Zurich node scripts/test-x3-zone-env-parity.js --verify
```

Capture and UTC verification compare to the same committed oracle. A non-UTC run
must compare old and new directly because the existing today-liters handler uses
the process-local midnight. This behavior is retained.

For real function-node VM execution, use the pinned release Node 20.18.3 binary
and set `X3_NODE_RED_DIR` to an installed Node-RED 3.1.15 or 4.0.9 package directory:

```sh
TZ=UTC X3_NODE_RED_DIR=/absolute/path/to/node-red node scripts/test-x3-zone-env-runtime.js
```

Every test-suite run must go through `osi-heavy` under the common implementer
brief. Neither harness starts an HTTP listener or calls a live service.

The production entry points take a message and injected dependencies. Request
state remains in that call; the module uses no flow context. The runtime harness
uses test-only global context to bind its recording dependencies into Node-RED.
This is test infrastructure, not application storage.

The source fixture also protects the handoff: `scripts/x3-zone-env-adapters.js`
refuses an intervening change to any source body. It renders both profiles into
an external scratch directory and prints the exact unified patch. It never
writes a reserved repository flow file.
