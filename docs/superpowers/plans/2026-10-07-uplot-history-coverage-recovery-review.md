# Controller review: history coverage and empty recovery

The bounded frontend fix is approved with the requirements below. Sol authored the plan; the controller checked the chart gate, viewport store, D3 controller, both API implementations, and read-only field-gateway/test-cloud database observations.

1. Separate navigation dates from maximum visible span. The navigation extent may start at epoch, but both the store and D3 must enforce the same 90-day maximum. A store-only clamp lets D3 continue zooming beyond that limit and delays recovery on a reverse pinch.
2. Keep the accepted-empty chart mounted, including its DOM identity and geometry. Preserve context-scoped unit and sensor-selection metadata through an empty response. Retained metadata must never supply old points to the renderer. Keep the previous controls' layout or reserve its space so the plot does not move under an active touch.
3. Prove native gesture recovery after populated-to-empty and initially empty results on both API families. Assert that populated data returns, rather than accepting the presence of an empty chart as recovery. Also test native pinch reversal at the 90-day maximum and navigation before the old cutoff.
4. Do not add the proposed automatic daily fallback. That changes query meaning and cache identity; the current task has enough evidence for gesture recovery and broader navigation, but not a complete resolution-availability policy.
5. Report the real data limitation precisely. The field gateway retains April readings; the inspected test-cloud raw Kiwi streams begin on 10 September. Aggregation coverage varies by source and resolution. The frontend fix cannot backfill that gap.

Luna workers own implementation and focused tests. Sol reviews the final patch. The controller owns browser runs and the already-authorized static preview deployment. No backend, database, account, or live Pi mutation is included.

## Runtime amendment

The complete browser suite exposed D3's default double-tap zoom after the chart stopped remounting on unit changes. A tap intended to inspect a temperature reading halved the viewport and failed the existing inspection test. D3 routes two touch taps through its optional `dblclick.zoom` listener. Remove that listener after each behavior installation so taps remain available for inspection; pinch and pan retain their existing handlers. Add a two-touch-tap regression and rerun the original three-renderer browser suite.
