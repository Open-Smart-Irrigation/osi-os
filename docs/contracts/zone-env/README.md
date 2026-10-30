# Zone Environment Golden Vectors

These fixtures are owned by `osi-os`.

They pin the behavior of the `Get Zone Environment Summary` request handler
while its pure compute and assembly helpers move into `osi-zone-env`.

- `MANIFEST.json` lists every captured case.
- `cases/*.input.json` describes the fixture request, database rows, fixed clock,
  and stubbed provider responses.
- `cases/*.expected.json` is the response bundle captured from the pre-extraction
  flow node.

These fixtures are behavior-preservation artifacts for the edge extraction only.
They do not define an osi-server mirror or cross-repo contract.

## Drift reason codes

Every non-null `drift` object in these responses also carries
`reasonCodes: string[]`, one stable machine-readable code per difference that
fired. Codes carry no numbers; the mm magnitudes stay in the typed delta
fields, which keep reporting sub-threshold values (in `shared-server-stale`,
`waterNeededDeltaMm` is 1.4 and emits no code).

| Code | Fires when |
|---|---|
| `irrigation_action_conflict` | the action codes cross the irrigate-like / suppress-like line (`severity: "high"`) |
| `recommendation_action_difference` | the action codes differ without that crossing (`severity: "medium"`) |
| `water_need_difference` | `waterNeededDeltaMm` is non-null and `>= 2` |
| `forecast_rain_difference` | `next24hRainDeltaMm` is non-null and `>= 2` |
| `water_balance_difference` | `balanceDeltaMm` is non-null and `>= 2` |

At most one action code comes first, then the delta codes in the table's
order — the order the legacy `reason` prose assembles. A `drift: null`
response gains nothing.

The vocabulary is open. Newer gateways may emit codes not listed here, and a
consumer must ignore unrecognized codes rather than reject the payload or
render a raw identifier. When the array is absent or holds no known code, a
consumer shows its own translated generic "recommendations differ" wording;
it must not fall back to the legacy English `reason` sentence. `reason` is
preserved byte-for-byte for older clients that still read it; retiring it is
a separate change.

`reasonCodes` exists only in this local REST response. Nothing stores it,
syncs it, or mirrors it to osi-server, and no contract schema or gateway
capability reports it.

## Display fallback reason codes

The `display` object carries a stable `fallbackReasonCode` next to the legacy
`fallbackReason` English sentence (#310). The sentence stays byte-for-byte for
older clients; retiring it is a separate change. Codes:

| Code | Fires when |
|---|---|
| `using_last_synced` | the bundle fetch failed and the cached bundle is at most 180 minutes old (`mode: "shared_server_stale"`) |
| `bundle_unavailable` | the bundle fetch failed and the cache had expired, so the zone answers from local data (`mode: "local_fallback"`) |

The code is set only where the edge itself knows the reason. It is derived
from the pairing of display mode and the exact sentence, because each catch
path in the flow node is the sole producer of its sentence under its mode. A
sentence a linked cloud bundle authored can land in `display.fallbackReason`
too (mode `shared_server`); it never satisfies either pairing and keeps
`fallbackReasonCode: null`, so a consumer must not guess a code from prose it
did not write. No fallback reason at all means both fields are null.

The vocabulary is open. Newer gateways may emit codes not listed here. A
consumer prefers the code, translates recognized codes, and shows its own
generic fallback wording for unrecognized codes, for prose without a code it
does not recognize, and for a null code with prose — never a raw identifier
and never the raw sentence. Responses without the field (older gateways) keep
the legacy sentence matching: the two sentences above translate, anything
else gets the generic wording. With neither sentence nor code, no banner
renders.

Like the drift codes, `fallbackReasonCode` exists only in this local REST
response. Nothing stores it, syncs it, or mirrors it to osi-server, and no
contract schema or gateway capability reports it.
