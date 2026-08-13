# Field Journal V2 canonicalization

V2 is a separate contract. It does not alter the V1 sync-event or command
canonicalization rules. Canonicalization itself does not authorize a producer
or issuer, but the shipped edge has an authorized V2 replication path: the
`journal-v2-replication-tick` inject runs once at startup and every 30 seconds,
and its worker reads, validates, and publishes the edge's pending replication
state. Authentication, authorization, and producer eligibility remain outside
the canonical byte and digest rules.

Canonical bytes are compact UTF-8 JSON. Object property names are sorted in
ascending UTF-16 code-unit order recursively, matching ECMAScript default sort
and Java `String.compareTo`; array order is preserved. Numbers use fixed-point
decimal notation with no exponent, `-0` becomes `0`, and non-finite values are
invalid. JSON integer fields are bounded to the interoperable safe range
`-9007199254740991` through `9007199254740991`; fields with stricter
nonnegative or positive bounds retain those bounds. Replication sequence is the
existing decimal string bounded by signed `BIGINT`.

`mutation_uuid`, `workspace_uuid`, resource UUIDs, result UUIDs, and UUIDs in
the V2 entry payload are lowercase hyphenated UUIDs. `recorded_at` and
`deleted_at` are UTC timestamps in exactly `YYYY-MM-DDTHH:mm:ss.SSSZ` form.
`gateway_device_eui` is uppercase 16-hex EUI. SHA-256 values are 64 lowercase
hex characters.

For a mutation, `payload_sha256` is SHA-256 of the canonical bytes of the
envelope with `payload_sha256` omitted. For replication, it is SHA-256 of the
canonical bytes of `envelope.payload` only. Sequence, workspace, kind, and
delivery timestamps are not part of a replication digest. The hash input never
contains blob bytes, credentials, local paths, object-store keys, or transport
URLs. Domain URI strings such as `scheme_uri` remain metadata, not a transfer
mechanism. The digest is lower-hex.

Schema validation and semantic validation are both required before a V2
envelope is accepted. After structural and cross-field validation, the
companion validator recomputes the declared digest and rejects a mismatch.
Other semantic checks enforce identity equality, next-version arithmetic,
entry and mapping order, value-status consistency, barrier-set ordering and
hashing, plot projection equality, signed `BIGINT` sequence bounds, and
numerically ascending replication batches. Draft-07 cannot express those
relationships without duplicating values outside their canonical fields.

`journal-v2-golden.json` contains four vector groups. `vectors` fixes generic
canonical JSON behavior. `mutation_vectors` and `replication_vectors` contain
complete envelopes plus their canonical hash input and digest.
`rejection_vectors` is shared by Node, Java, and TypeScript and exercises both
structural and cross-field rejection. A runtime must pass every group before a
V2 producer or consumer can use it.
