# Function sandbox identifier check

Run `npm ci --ignore-scripts --prefix scripts`, then
`node scripts/verify-flows-sandbox.js`. The Sync Flow Verifier workflow runs
the check and `node --test scripts/verify-flows-sandbox.test.js` on pull requests.
ESLint is a development dependency under `scripts/`; the gateway payload gains
no dependency.

The checker discovers every repository `flows.json` through Git's file inventory,
including new variants. It applies ESLint's lexical `no-undef` analysis to every
function node's `func`, `initialize` and `finalize`, including disabled nodes.
Local declarations and each node's `libs[].var` resolve names in that node only. Library aliases must
also be unique within a node and must not collide with sandbox globals,
JavaScript intrinsics or the wrapper names, including `node`. The checker
rejects `with` statements in every source field, because their dynamic scopes
can hide unresolved lexical references.
Use `--flows <path>` to check an extracted historical flow or a fixture.

The allowed globals come from the [Node-RED 3.1.15 function implementation](https://github.com/node-red/node-red/blob/3.1.15/packages/node_modules/@node-red/nodes/core/function/10-function.js):
the sandbox at lines 149–286, module bindings at 288–310, and message, setup and
close wrappers at 106–125 and 334–380. Message-only variables are unavailable in
setup and close. Close code uses a synchronous wrapper, as Node-RED does.
The VM also supplies JavaScript intrinsic globals such as `Intl` and `Promise`;
the checker enumerates those in a fresh VM context using the CI Node version,
matching Node-RED's `vm.createContext(sandbox)` at line 330. It never enumerates
the host Node global object, which would incorrectly allow `crypto`, `URL`,
`fetch` and `process`. Check the globals again when upgrading Node-RED or Node.

## Limits and reviewed exceptions

This is static identifier analysis. It does not execute flows, validate module
exports, detect misspelled properties, follow `eval` or `Function` strings, or
prove that dynamic property access returns a value. It accepts safe `typeof`
probes and checks their subsequent identifier uses. It does not infer control
flow, including feature guards and unreachable statements. ESLint suppression
comments inside flow code cannot disable the rule.

`scripts/flows-sandbox-exceptions.json` records two reviewed exceptions. Each
matches a node ID, source field, identifier, exact locations and the SHA-256 of
the complete field. Changed code or diagnostic counts fail the check and require
reviewing or removing the exception. Each applied exception is printed.

- `settings-disable-schedules-fn`: the `disabledSchedules` expression follows
  an unconditional return and cannot execute.
- `dendro-compute-fn`: **known runtime defect**, retained outside this fix's
  scope and tracked in [issue #629](https://github.com/Open-Smart-Irrigation/osi-os/issues/629).
  Both the default Open-Meteo fetch and configured OpenAgri fetch call bare
  `require('https')` or `require('http')`. The sandbox has no `require`, so
  dendrometer zones with coordinates get no weather rainfall or weather VPD
  fallback. The defect also exists in v0.8.1. Repair needs transport
  bindings plus a code change or module extraction, rather than the missing
  one-line declaration corrected by this change. The exception preserves the
  finding visibly; it does not classify that path as safe.
