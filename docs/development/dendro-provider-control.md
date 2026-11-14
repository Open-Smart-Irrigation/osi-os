# Dendrometer provider observations and irrigation

Provider rain and VPD collection has failed in every released gateway since v0.6.0: the function node used a bare `require` that its sandbox does not expose. The transport repair makes collection work. Its irrigation effect ships off by default; enabling it for a gateway remains the owner's product decision.

## Gateway setting

The existing SQLite `app_settings` table stores `dendro_provider_irrigation_enabled`. No row is required and no schema change is made. The analytics module reads it once per run, using the existing operator-gate storage. Only the exact string `1` enables it; `on`, `true`, `ON` and ` 1 ` remain off. Absent, invalid and unreadable values mean off; a read failure warns. No screen or route exposes a new switch.

With the setting off, provider VPD cannot adjust tree stress. Provider rain cannot start suppression or enter the control rolling sum, including observations stored on prior days. Local sensor VPD, certified local gauge rain and local received lower bounds keep their existing behavior. The stored action and raw conditional evidence use these control inputs. The legacy scheduler still applies its existing multiplier to that action.

## Stored observations and decision inputs

The existing local-source precedence is preserved. These fields describe the selected observation, which can come from a provider when a local source is unavailable:

- `zone_daily_recommendations.rainfall_mm` and `recommendation_json.rain`: selected rain and its source/coverage. With the setting off, `rain.daily_status` keeps main's decision-rain status, so a provider-only day remains `unknown` for the cloud's rolling decision sum; the provider amount remains stored. The displayed rolling sum can include provider observations while the control rolling sum excludes them.
- `zone_daily_recommendations.vpd_max_kpa`, `vpd_source` and `recommendation_json.vpd`: selected VPD and its source.

`recommendation_json.weather_control` records `setting_key`, `provider_irrigation_enabled`, `decision_rain`, `decision_vpd`, `observed_rain` and `observed_vpd`. The observation objects retain their own status/source, including provider rain marked observed. The decision objects are the exact inputs used by stress/action calculation. A provider value being present in an observation column does not imply it was used for irrigation. The existing cloud mirror carries this JSON with the row; no new column or contract version is introduced. `irrigation_action`, suppression state and `raw_decision`/`raw_evidence` describe the control calculation, including what conditional irrigation reads.

A restart runs analytics again after 30 seconds. If a repeated fetch for the same zone and completed day fails, the module retains that day's already stored provider rain/VPD before computing control inputs. It does not reuse another day's observation. If the recommendation content changes, `weather_control.provider_reused_from_computed_at` identifies the earlier row's computation time. A rerun with identical content keeps its original JSON, `computed_at` and `sync_version`; computation timestamps and reuse diagnostics alone do not cause an update. Actual changes, including a changed explanation, still advance the version. A failed fetch no longer erases these displayed values or the corresponding control inputs when opted in.

## Conditions before enabling provider control

Default-off comparison tests execute the shipped node and module against an unreachable provider and the pinned main node at `27459db81`, covering stored action, the shipped scheduler multiplier, suppression state and the real conditional reader. Explicit opt-in cases exercise the weather-informed behavior. Same-day reuse addresses the restart overwrite identified by the council; it does not qualify provider control for a farm.

The following remain unverified or deferred: whether the default archive serves the previous completed day; incomplete provider hours treated as a usable day; OpenAgri timestamps without a timezone; overlapping analytics runs around 08:00; physical-range validation of provider temperature/humidity; and warnings for an unusable HTTP 200 response. No real provider request, physical valve or gateway qualification was performed. Enabling the switch requires the owner's decision after the outstanding provider and operational qualifications.

Additional conditions from round 2, to accept or resolve before enabling:

- W2: provider VPD stored while the setting is off can form a permanent SD-VPD diagnostic baseline on the edge and server.
- W3: unchanged recommendation content keeps its original freshness timestamp; after a missed daily run it can reach the 36-hour guard earlier than main, which refreshed it on restart.
- W4: the GUI shows provider rain/VPD beside advice that ignores them, without a control marker, and displayed rolling rain can exceed the control sum.
- W5: only an authorized operator sets the exact value `1` and checks the stored key; the next day's `weather_control.provider_irrigation_enabled` records what the run used.
- W6: a database older than `app_settings` warns on every daily run and leaves provider control off.
- C1: switching off does not clear suppression already started by provider rain; the stored suppression ends under the existing 48/72-hour or TWD-response rules.
- C2: `server_preferred` can use the server's own provider-informed action independently of this edge setting; default-off mirrored provider-only rain is marked unknown for its stored-row sum.
- C3: a diagnostic baseline formed from provider VPD while off is later read alongside control VPD after opt-in.
- C4: provider VPD above 2 kPa can lower stress one level; the council fixture changed a 20-minute scheduled open to 18 minutes.

`dendrometer_daily` still updates its computation timestamp and version on every restart, as on main; this repair does not change that write.

## Rain suppression has different consumers

With provider control enabled, 5.4 mm of provider rain can select `maintain_rain_suppression`. The legacy node “Decide + build actuator cmd + build DB logs” does not skip on that action: `applyDurationMultiplier` (body lines 58–67) has no matching case and uses factor 1.0. Its DENDRO branch passes the action to that function at body line 240 and returns the open at line 299. A 20-minute base duration therefore remains 20 minutes. In the council's fixture, sensor-only v0.8.1 advice was `decrease_20` and 16 minutes. There is no other rain-suppression-specific skip in the legacy path; the ordinary freshness, valve, access and same-day debounce guards still apply.

Conditional irrigation reads the stored `raw_evidence`/`raw_decision` through `osi-irrigation-policy/observations.js`. With otherwise valid, fresh, usable and known-stress evidence, `evaluate.js` returns `NOT_MET` for `maintain_rain_suppression`; `worker.js` records a skipped occurrence with reason `dendro_hold` before dispatch. Missing, stale, unusable or `none`/unknown stress evidence returns `UNKNOWN` earlier and also skips. This is separate from the legacy multiplier behavior. The owner must understand that difference before enabling provider control; this repair does not change either consumer.
