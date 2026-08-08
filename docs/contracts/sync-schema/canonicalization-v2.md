# Field Journal V2 canonicalization

V2 is a separate contract. It does not alter the V1 sync-event or command
canonicalization rules and does not authorize a V2 producer or issuer.

Canonical bytes are compact UTF-8 JSON. Object property names are sorted in
ascending Unicode code-point order recursively; array order is preserved. JSON
numbers use their shortest non-exponent decimal representation, `-0` becomes
`0`, and non-finite values are invalid.

`mutation_uuid`, `workspace_uuid`, resource UUIDs, result UUIDs, and UUIDs in
the V2 entry payload are lowercase hyphenated UUIDs. `recorded_at` and
`deleted_at` are UTC timestamps in exactly `YYYY-MM-DDTHH:mm:ss.SSSZ` form.
`gateway_device_eui` is uppercase 16-hex EUI. SHA-256 values are 64 lowercase
hex characters.

For a mutation, `payload_sha256` is SHA-256 of the canonical bytes of the
envelope with `payload_sha256` omitted. For replication, it is SHA-256 of the
canonical bytes of the envelope with `payload_sha256` omitted. The hash input
never contains blob bytes or an object-store URL. The digest is lower-hex.
