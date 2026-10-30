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
