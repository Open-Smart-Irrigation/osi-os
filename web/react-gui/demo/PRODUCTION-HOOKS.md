# Production hook dispositions

The simulator source changed the following production files. Ported hooks use the compile-time `VITE_PUBLIC_SIMULATOR` flag; the production Vite config defines it as `"false"`. The public demo gets `"true"` from `vite.demo.config.ts`.

| Source file | Disposition | Reason |
|---|---|---|
| `src/App.tsx` | Port route redirects | Public build sends analysis, network, journal and gateway-card detail routes to the dashboard. |
| `src/components/analysis/AnalysisSeriesTray.tsx` | Drop localization changes | Production wording and locale scope stay on main. |
| `src/components/farming/AddDeviceModal.tsx` | Port fictional DevEUI prefill | Uses the simulator-only identity generator; the normal build compiles the branch out. |
| `src/components/farming/AdvancedScheduleDrawer.tsx` | Drop public evaluation display | Conditional-policy qualification remains false; the demo does not present legacy evaluation text as conditional advice. |
| `src/components/farming/DraginoTempCard.tsx` | Drop rain monitor changes | This is a production sensor display change. |
| `src/components/farming/IrrigationZoneCard.tsx` | Port initial expansion and invalidation | The public build opens zone 1 and refreshes its summary after model mutations. Other display changes remain on main. |
| `src/components/farming/Sdi12SettingsModal.tsx` | Drop | The DevEUI lookup change belongs to the production SDI-12 settings candidate. |
| `src/components/farming/SenseCapWeatherCard.tsx` | Drop | Name wrapping is a production display change. |
| `src/components/farming/StregaValveCard.tsx` | Drop | Flow-meter estimation changes affect production agronomy display. |
| `src/components/farming/Uc512DeviceCard.tsx` | Drop the simulator registration path | Main has no visible UC512 card. Public registration now returns a clear unsupported response and creates no record. Production catalog support remains unchanged. |
| `src/components/farming/ZoneConfigModal.tsx` | Drop | Keep production location messages; the public adapter supplies the existing edge-shaped response. |
| `src/components/farming/ZoneDeviceModal.tsx` | Port fictional DevEUI prefill | Uses the simulator-only identity generator. |
| `src/components/farming/environment/AgronomicTab.tsx` | Drop localization changes | Main locale resources are unchanged. |
| `src/components/farming/environment/EnvironmentCard.tsx` | Port invalidation subscription; drop request sequencing | Simulator requests refresh after model writes. No stale-response reproduction justified changing production request sequencing. |
| `src/components/farming/environment/WaterTab.tsx` | Drop | Flow-meter estimate presentation is production behavior. |
| `src/components/farming/environment/WeatherTab.tsx` | Drop localization changes | Main locale resources are unchanged. |
| `src/components/farming/environment/waterChart.ts` | Drop | Flow-meter data interpretation is production behavior. |
| `src/components/history/mobile/HistorySourcePopover.tsx` | Drop localization changes | Main locale resources are unchanged. |
| `src/history/sourceLabels.ts` | Drop localization changes | Main locale resources are unchanged. |
| `src/pages/AccountLink.tsx` | Drop | Authentication and account-link screens stay unchanged. The public simulator model owns demo session responses. |
| `src/pages/FarmingDashboard.tsx` | Port initial zone expansion | The simulator opens its seeded first zone while the production default stays collapsed. |
| `src/pages/Login.tsx` | Drop | Authentication screens stay unchanged. |
| `src/pages/NetworkPage.tsx` | Drop request sequencing | The public build redirects this route; the sequencing change remains a production follow-up. |
| `src/pages/SettingsPage.tsx` | Port simulator-only module-row hiding | Public mode omits gateway-only controls and experimental prediction controls. |
| `src/components/farming/IrrigationOutcomesPanel.tsx` | Port null-zone handling | An outcome without a zone has no zone-specific timezone context. The edge expectation can retain a null zone after unassignment. |
| `src/services/api.ts` | Keep main today-liters mapping; widen actuation `zoneId` to nullable | Edge expectations can outlive zone assignment; their owner zone is nullable in the runtime model. Today-liters source labels follow the edge response. CSV code is unchanged; the independent Firefox native-download check passed. |
| `src/types/farming.ts` | Add `meteoswiss` to online and forecast source unions | The simulator can report its selected deterministic illustrative provider without mislabelling it as Open-Meteo. Production locale resources and runtime behavior are unchanged. |
| `src/utils/publicSimulatorDeviceDefaults.ts` | Port as the build-flag and fictional identity boundary | All consumer branches use this shared compile-time check. |
| `src/utils/publicSimulatorInvalidation.ts` | Port as the public-only event subscription | The subscription returns a no-op when the compile-time flag is false. |

## Source-backed behavior notes

The current edge flow still evaluates the legacy zone schedule once daily at 06:00. Its daily inject, zone selection and decision nodes own the behavior. The model’s daily trigger evaluation remains in scope; conditional policies are a separate API and remain unqualified.

The model’s trigger eligibility, latest-hour aggregation, oldest assigned STREGA selection and same-day debounce are pinned against those flow nodes by the port tests.

Current-main reconciliation: ordinary timed opens are accepted. If the valve is already running, a repeated timed-open is ignored and leaves the original run timer intact; if it was opened externally, the ignored command creates no simulated close timer. Timed-close holds still own the valve. The daily legacy trigger remains enabled at its source 06:00 opportunity; conditional-policy qualification remains false and an enabled conditional schedule is rejected with the source 503 reason. See `demo/tests/irrigation.test.ts`, `demo/tests/triggers.test.ts`, `demo/tests/v1-native-contracts.test.ts`, and the cited flow node IDs in `controller-semantics.md`.

The zone soil tile and Environment card read the edge environment summary. Device cards use their source-specific latest device readings. History uses the selected source/channel and its own range aggregation. This stage has not established one identical value across those surfaces; do not attribute a difference to the simulator without tracing source, depth, aggregation and timestamp.
