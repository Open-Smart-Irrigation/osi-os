# Installation-bound recovery design

**Status:** Approved for Task 10 local and test infrastructure
**Authority:** OSI OS remains canonical
**External boundary:** No production key provider, upload, or restore is selected
or performed

## 1. Problem

Gateway EUI is an operational address, not a durable installation identity.
The current gateway-migration path can rebind cloud rows from an old EUI to a
new EUI, but account links, offline verifiers, and recovery assets still use
the EUI as their identity root. A replacement concentrator or reinstalled
gateway therefore changes the value used to prove offline login and to locate
recoverable state.

Task 9 now durably mirrors the portable history families, but a mirror is not
a lossless edge backup. Recovery must preserve edge-only state, command and ACK
evidence, local identifiers, and schema state without turning the cloud into a
second canonical writer.

## 2. Verified starting point

- `sync_link_state` is the durable edge link record. It stores the current
  gateway EUI but has no installation identity.
- `LinkedGatewayAccount` is scoped by cloud user and gateway EUI. Its offline
  verifier v1 is bcrypt over `password::gatewayEui`.
- Bootstrap gateway migration accepts structural previous-EUI evidence and
  rebinds operational aggregates to the current EUI.
- Task 9 provides durable batch mirrors for eight history families while
  retaining event and bootstrap delivery.
- OSI OS already owns the database replacement safety boundary:
  `prepare-database-restore`, the stopped-writer and command-activity checks,
  immutable restore receipts, reconciliation completion, and rollback.
- OSI Server has HMAC and JWT key use but no envelope-encryption service or
  recovery-key provider.

## 3. Identity model

Each edge database contains exactly one `installation_identity` row:

| Field | Meaning |
|---|---|
| `installation_uuid` | Stable UUID created once and restored with the database |
| `current_gateway_device_eui` | Current operational gateway identity |
| `previous_gateway_device_euis_json` | Ordered, deduplicated EUI history |
| `recovery_state` | `ACTIVE`, `RESTORING`, `RECONCILING`, or `BLOCKED` |
| `recovery_operation_uuid` | Current recovery operation, when present |
| timestamps | Creation, update, restore start, and reconciliation completion |

`sync_link_state.installation_uuid` repeats the identity for link queries and
must match the singleton row. Operational tables continue to use gateway EUI.
No zone, device, command, heartbeat, MQTT topic, or history key is converted
to installation UUID.

OSI Server stores one `gateway_installations` row per installation UUID. It
keeps the current EUI and an ordered JSON list of previous EUIs. A new EUI
observed for the same installation moves the old current EUI into that list.
An EUI cannot be current for two installations.

Existing linked accounts remain valid with a null installation UUID until an
updated edge links or bootstraps. This is the mixed-version compatibility
path.

## 4. Offline verifier v2

Verifier v2 is bcrypt over:

```text
password::installation_uuid
```

An updated edge sends `installationUuid` and advertises
`installation_recovery_v1` during local link and bootstrap. The server checks
UUID syntax, records the installation/EUI association, returns the same UUID,
and issues verifier version 2. The edge rejects a response containing a
different installation UUID.

An old edge or a request without the capability keeps verifier v1 over
`password::gateway_eui`. Existing v1 verifier rows remain readable. Relinking
an updated edge upgrades the row to v2; there is no blind hash conversion
because the password is required to create a new bcrypt verifier.

## 5. Recovery bundle

The recovery artifact is a verified SQLite backup produced through the
existing backup tooling. Its metadata contains:

- format and schema version;
- installation UUID;
- source gateway EUI;
- creation time;
- database byte length and SHA-256;
- migration head and schema fingerprint;
- sync and command-activity witness references needed by the existing restore
  protocol.

The server receives the bundle over the authenticated HTTPS sync path. It
validates metadata and encrypts the bytes before inserting durable state. No
plaintext bundle column, temporary database row, log field, or audit payload
is permitted.

Network-drive configuration, SMB credentials, imported external readings, and
external files are not added to sync contracts. If a future edge database
contains unrelated edge-local tables, the encrypted database remains opaque
to the cloud; Task 10 adds no interpretation or parity rule for those tables.

## 6. Envelope encryption

For each bundle:

1. Generate a random 256-bit data-encryption key.
2. Encrypt the bundle with AES-256-GCM and bundle metadata as authenticated
   data.
3. Ask `RecoveryKeyProvider` to wrap the data key.
4. Store bundle ciphertext, bundle nonce, wrapped data key, provider ID,
   provider key reference, authenticated metadata, and SHA-256.
5. Zero temporary key byte arrays on best effort after use.

`RecoveryKeyProvider` is a local abstraction. Task 10 includes an in-memory or
configured local AES-GCM provider for tests and local development. It is
disabled unless an explicit test/local property supplies a key. No KMS, Vault,
HSM, cloud account, credential, cost, or production provider is selected.

Changing providers rewraps data keys; it does not decrypt and re-encrypt
bundle ciphertext.

## 7. Restore workflow

Restore is an explicit operation, not a cloud command:

1. An authorized user selects a bundle and an explicit target installation.
2. Preview decrypts into memory, verifies GCM authentication, byte hash,
   SQLite integrity, installation UUID, migration compatibility, age, and
   target identity. It records an immutable preview audit event.
3. Starting restore records a recovery operation and a rollback bundle for the
   target. The target edge remains stopped.
4. The edge adapter passes the validated backup and metadata into the existing
   `prepare-database-restore` protocol. It does not copy over
   `/data/db/farming.db` directly.
5. The restored database enters `RECONCILING`. Node-RED and physical-effect
   polling remain stopped while bootstrap, event, pending-command, history,
   command/ACK, and witness reconciliation run through the existing guarded
   procedure.
6. `complete-database-restore-reconciliation` records the receipt and changes
   the installation to `ACTIVE`. Only then may normal writers start.
7. Failure before completion leaves the operation interrupted and the edge
   blocked. Operator rollback uses the recorded rollback bundle through the
   same restore boundary.

The server records every state change in
`installation_recovery_audit`. Audit rows contain identities, hashes, state,
and bounded errors, never plaintext bundle bytes or unwrapped keys.

## 8. Authorization and stale-data rules

- Cloud account membership for the target installation is required.
- Bundle source installation UUID must equal the explicit target installation
  UUID. A replacement Pi targets the existing installation; it does not mint a
  second installation identity and merge it silently.
- A bundle older than the installation's newest completed recovery or with a
  migration head newer than the target runtime is stale and rejected.
- Only the gateway currently registered to the target installation may obtain
  restore bytes.
- Download uses a short-lived operation token bound to bundle, operation,
  installation, and gateway EUI.
- Recovery never changes edge authority and never deletes server history.

## 9. Required tests

- verifier v1 fallback and password-authorized v1-to-v2 upgrade;
- EUI replacement retaining installation UUID and ordered previous EUIs;
- reinstall targeting the existing installation;
- bundle encrypt/decrypt round trip with no plaintext persistence;
- partial or truncated ciphertext, wrong installation, wrong key, tampered
  metadata, and stale bundle rejection;
- preview without mutation;
- interrupted restore remaining non-active across restart;
- rollback through the same guarded restore boundary;
- reconciliation completion before canonical writers are allowed;
- old gateways retaining v1 link and sync behavior.

## 10. Deferred work

- production recovery-key provider selection and provisioning;
- production bundle upload and retention policy;
- live gateway restore or production database upload;
- automated operator UX beyond the local/test API;
- legacy history-path removal and incremental bootstrap;
- network-drive or external-provider data recovery.
