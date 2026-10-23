# Mobile history prototype execution amendment

The user approved implementation through three passing prototypes and deployment to the test server on 2026-10-07. This amendment supersedes the original plans where they describe a local-only handoff, native Chart.js gestures, or acceptable gesture-suitability failures.

## Gesture decision

All three renderers now use the shared D3 controller. uPlot, ECharts, and Chart.js still render the same datasets independently, allowing the user to compare responsiveness, axes, and rendering on a phone.

The native Chart.js plugin was implemented and measured before this change. In an independent Chromium touchscreen run, a spread from an 80-pixel gap to a 160-pixel gap produced these results:

| Renderer and gesture owner | Final span, 60 moves / initial span | Final span, 4 moves / initial span | Vertical spread | Moving-midpoint drift |
| --- | --- | --- | --- | --- |
| uPlot + D3 | 0.500000 | 0.500000 | 0.500000 | about 1 CSS pixel |
| ECharts + D3 | 0.500000 | 0.500000 | 0.500000 | about 1 CSS pixel |
| Chart.js + native plugin | 0.497908 | 0.466667 | 1.000000, no zoom | about 87.7 CSS pixels |

These measurements are desktop Chromium mobile emulation, not a Pixel hardware performance result. They establish that fixing the native plugin's start-event coordinate mismatch was insufficient: its gesture behavior still missed the agreed criteria. The failed native measurements remain part of the execution evidence. There is no fourth live route.

The Chart.js adapter therefore drops the zoom plugin and its gesture callbacks. Its adapter callback argument remains in the common interface but is unused, as for the other two renderers. The shell attaches exactly one D3 overlay to every active renderer. Every gesture criterion must pass for every live route at the same tolerance; no candidate-specific exceptions remain.

## Verification and deployment

The browser suite runs the production build at the fixed 448 × 998 CSS-pixel comparison profile, DPR 3, with mobile and touch emulation enabled. Rotation swaps those dimensions; compact-screen coverage uses 390 × 844. The test driver uses native CDP touch events and the renderer's actual domain and plot rectangle. Fixture acceptance, point count, and rendered pixels must be observed before recording stress or data-fidelity results.

The user authorized the test-server deployment at `https://server.opensmartirrigation.org/prototypes/history-zoom/`. Root performs the bounded static deployment after the implementation and independent Sol review pass. It adds a dedicated Caddy path, verifies local and remote artifact hashes, preserves the existing backend and MQTT handlers, and retains a configuration backup and rollback record. Production access is outside scope.

The implementation roles remain unchanged: Luna writes code, root reviews plans and coordinates fixes, and fresh Sol contexts review the implementation. The final browser suite must be independently checked for meaningful assertions as well as passing results.
