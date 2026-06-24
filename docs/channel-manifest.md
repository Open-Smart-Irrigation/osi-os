# Canonical Channel Manifest

`web/react-gui/src/channels/channels.json` is the canonical channel manifest for OSI channel metadata. The osi-os copy is the source of truth. Downstream osi-server frontend and backend copies must be synchronized from this file, not edited independently.

## Entry Schema

Each manifest entry is an object with these fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `key` | string | Canonical channel identifier used by UI and sync contracts. |
| `unit` | string or null | Display/export unit. Use `null` for dimensionless channels. |
| `label` | string | Short UI label. |
| `displayName` | string | Human-readable channel name for detailed surfaces. |
| `cardType` | string | UI grouping. Valid values are `soil`, `environment`, `dendro`, `irrigation`, and `gateway`. |
| `category` | string | Functional category such as `soil`, `weather`, `dendro`, or `diagnostic`. |
| `edgeField` | string or null | Field name in edge telemetry, or `null` when the edge has no local field for the canonical channel. |
| `serverField` | string | Field name in mirrored server telemetry. |
| `exportable` | boolean | Whether the channel is included in normal data export surfaces. |
| `deprecated` | false | Canonical entries must not be deprecated. Deprecated names belong in `legacyAliases`. |
| `legacyAliases` | string[] | Non-canonical names accepted for compatibility. |

## Alias Semantics

`legacyAliases` lists historical field names that map to the canonical `key`. Aliases are compatibility inputs only; they must not duplicate any canonical key and should not be used as new storage, API, or export names. For example, `swt_wm1` maps to canonical `swt_1`, and `temperature` maps to canonical `ambient_temperature`.

## Export Behavior

Battery diagnostics are intentionally present in the manifest but excluded from normal data exports:

- `bat_v` has `exportable: false`
- `bat_pct` has `exportable: false`

These channels use `cardType: "gateway"` and `category: "diagnostic"` so UI surfaces can still display gateway health without treating battery diagnostics as farmer-facing measurement exports.

## VWC Edge Field

The canonical `vwc` entry uses `edgeField: null` and `serverField: "vwc"`. This records that VWC is a canonical server-facing channel even though there is no local edge telemetry field to bind directly in the current osi-os manifest.

## Sync Procedure

1. Update `web/react-gui/src/channels/channels.json` in osi-os first.
2. Run the osi-os manifest validity test:

   ```bash
   cd web/react-gui
   npx vitest run src/channels/__tests__/channels.test.ts
   ```

3. Compute the source manifest checksum from the osi-os repo root:

   ```bash
   sha256sum web/react-gui/src/channels/channels.json
   ```

4. Copy the osi-os manifest to the osi-server frontend and backend manifest locations required by that repo.
5. Verify the copied osi-server files against the osi-os SHA-256 before making osi-server behavior changes.
6. Commit osi-os and osi-server changes separately, preserving osi-os as the canonical source.

## Recorded SHA-256

`abd6f1b99cf85e7e37568e97e35cc527dbb71cbaee53b005acbc3f77db449ef2  web/react-gui/src/channels/channels.json`
