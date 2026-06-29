# Recent Irrigations Five-Entry Cap Design

## Source Issue

GitHub: Open-Smart-Irrigation/osi-os#69, "Limit Recent Irrigation card to latest 5 entries".

## Goal

The edge React GUI Recent irrigations card renders no more than the five newest irrigation actuation rows while preserving the existing API response, sort order, empty state, loading state, error state, and advanced-view toggle behavior.

## Chosen Approach

Apply the cap at the card boundary in `web/react-gui/src/components/farming/IrrigationOutcomesPanel.tsx`.

The Node-RED endpoint `/api/irrigation/recent-actuations` currently returns up to 50 rows ordered by `commanded_at DESC`. Keeping that endpoint unchanged avoids narrowing a local API that may later support a larger history view. The card will derive a display list from the existing `viewState.actuations` array with `slice(0, 5)` and render from that display list.

## Alternatives Considered

1. Change the Node-RED SQL limit from 50 to 5.
   - Benefit: less payload transferred to the GUI.
   - Cost: changes both Pi profile `flows.json` files and removes flexibility from the endpoint.
   - Rejected because the issue is specifically about the card and no evidence shows every endpoint consumer wants only five rows.

2. Add a new API query parameter such as `?limit=5`.
   - Benefit: preserves a general endpoint while reducing the card payload.
   - Cost: larger Node-RED/API change, new validation surface, and profile parity verification.
   - Rejected as unnecessary for this issue.

3. Cap in `IrrigationOutcomesPanel`.
   - Benefit: smallest change, no backend contract drift, easy unit coverage.
   - Cost: the browser still receives up to 50 rows.
   - Selected because it satisfies the user-visible requirement with the lowest risk.

## Behavior

- When the response has 0 rows, the existing empty state remains unchanged.
- When the response has 1 to 5 rows, all supplied rows render in their existing order.
- When the response has more than 5 rows, only indices 0 through 4 render.
- Compact view and advanced view both render from the same capped display list.
- The cap does not sort, filter by status, or mutate the response array.

## Files

- Modify `web/react-gui/src/components/farming/IrrigationOutcomesPanel.tsx`.
- Modify `web/react-gui/tests/irrigationOutcomesPanel.test.ts`.
- Do not modify `flows.json`, DB schema, locale files, or API service types.

## Testing

- Add unit coverage that supplies more than five actuations and asserts only the first five zone names render in compact view.
- Add unit coverage that enables advanced view and asserts only the first five zone/device rows render there too.
- Run the frontend unit tests for the changed harness, then run the full frontend unit suite and build before deploy.

## Deployment And Verification

After local verification, build the React GUI and deploy to Kaba100 with the repo deployment workflow. Also deploy to Silvan and Uganda when reachable, preserving live databases and taking timestamped pre-deploy backups according to `AGENTS.md`.

Post-deploy verification should prove each reachable gateway is serving the GUI, the deployed GUI artifacts match the local build, the deployed bundle contains the five-entry display cap, Node-RED is running, and the live DB passes `PRAGMA quick_check`. If live data or an authenticated local API token is available, inspect `/api/irrigation/recent-actuations`; otherwise verify the served GUI artifact and runtime health without modifying live data.

## Self-Review

- No placeholders or unresolved decisions remain.
- The scope is intentionally frontend-only; the Node-RED endpoint stays at 50.
- The selected design satisfies all issue acceptance criteria while keeping the API and Node-RED flows unchanged.
