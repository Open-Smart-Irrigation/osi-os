# Loading optimization plan review

The user approved the proposed loading improvements and retained the Sol → controller → Luna → Sol workflow. This review is the delegated plan gate. The previously authorized test-server static deployment remains in scope after verification.

## Evidence and scope

The controller reproduced the delay against the deployed pilot with native Playwright touch and controlled 600 ms API responses. Continuous movement sent no request until after release; Latest duplicated a request; successive pans cancelled work near completion; returning to prior history fetched it again. These are client-policy observations, not measurements of live backend latency. The 719 ms observation is time from touch release to the controlled response release, not a measured UI-render duration.

The optimization changes the standalone pilot's loading policy. It preserves uPlot/D3, server endpoints and limits, authentication checks, missing data, unit isolation, and viewport ownership. The new plan supersedes the original pilot's single retained response and repeated background Loading status. No response merging, backend optimization, production access or live edge deployment is included.

## Required plan corrections

| Finding | Required behavior |
| --- | --- |
| An async-only loader cannot distinguish a cache hit before the UI flashes loading | Return a synchronous decision handle with a result promise. |
| Cancellation and destroyed-loader outcomes were undefined | Use a named abort outcome and settle consumers deterministically. |
| A cache hit could bypass network token checks | Check the captured token at demand, lookup/application and response acceptance; session events alone are insufficient. |
| StrictMode cleanup could permanently destroy a reused loader | Clear replayed instances and fence each mounted lifetime. Test StrictMode. |
| Partial/truncated or different-resolution direct responses could leave loading forever | Finish a still-current direct request honestly; exclude such data from reusable full coverage. |
| A cache hit could allow an older pending response to replace the selected result | Retire the prior visible intent before promoting cached data. |
| Hidden-page behavior and freshness age were ambiguous | Stop speculative work when hidden; preserve original response age, and use TTL when checking on return. |
| Request usefulness and two-slot eviction were vague | Match context/resolution first; use explicit overlap/neighbor criteria and deterministic ties; newest foreground work must start. |
| Browser request counts confused initiation with priority after promotion | Count physical requests in Playwright; prove internal priority invariants in loader tests. |
| Automatic prefetch breaks networkidle and global pending-count assumptions | Await product readiness and match intended requests by bounds/resolution; deferred replies carry their own request identity. |

## Execution ownership

One Luna worker owns the loader, range policy, hook and their unit tests because those interfaces change together. A separate Luna worker may change the quiet-loading UI after the result interface is fixed. The browser worker owns only the pilot test harness/spec; the controller owns browser execution, diagnostics, README, operational evidence and deployment. Workers do not amend/reset shared history or start competing preview servers.

The controller will run the full unit/build/browser gates, repeat the controlled loading probe, inspect phone screenshots and run the suite against the exact deployed files. Cache reuse, one-request Latest and bounded prefetch must have observed evidence before speed claims are made. Authenticated backend latency remains a separate unverified item.

## Implementation review corrections

The first implementation passed 140 unit tests but omitted much of the planned scheduler coverage. Independent review found session-cache isolation, Latest horizon, visibility freshness, leading prefetch, cancellation, cache eviction, boundary translation, and catalog Retry gaps. The first browser run passed 18 of 20, with two test-authoring failures; the gesture-prefetch test also passed without the feature and must be strengthened. These results are not a release gate.

Repair ownership is split: one Luna owns the hook and hook tests; the other owns loader/range/types and their tests after completing browser fixes. Sol reviews each finished set. Root coordinates browser execution and deployment.

The demand interface needs `direction?: 'back' | 'forward'` to evaluate the previously specified exact directional neighbor in the loader. The hook supplies its current direction; direct callers default to Back. This supplies missing information to the existing ranking rule and adds no new policy.

The hook must restore catalog Retry for zone/card failures. A late consumer from a retired lifetime may neither apply data nor clear a newer valid session. Session checks precede cache lookup, and account clear invalidates pending resolved-Promise consumers synchronously.

Independent Sol reviews of the final loader, range policy, hook, scheduler tests, UI, and browser harness finished GREEN. Runtime corrections to the browser tests preserved their assertions while accounting for cache hits, ISO timestamp parsing, and a clock paused before navigation. The controller's controlled-delay probe verified warm navigation without extra requests, one physical Latest refresh, and prefetch during native touch. Cold uncached round-trip latency was unchanged. Release results are recorded in `docs/operations/uplot-loading-optimization-2026-10-07.md`.
