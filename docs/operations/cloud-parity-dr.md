# Cloud parity as the edge DR strategy

The edge `farming.db` is the source of truth, but our disaster-recovery posture is
**cloud parity**: canonical changes are mirrored to OSI Server (which is backed up).
That is only a safety net while parity is *current*.

`check-sync-parity.js` is fail-SAFE: it reports UNHEALTHY when the gateway is not
`linked` to the cloud (nothing is being enqueued), when there are rejected events,
when history dirty-keys are pending, or when the oldest un-delivered event exceeds the
age threshold. Green means the DR net is actually current.

**Verify before any risky edge change** (schema migration, boot-node change, Option B):

    node scripts/check-sync-parity.js /data/db/farming.db   # exit 0 = safe to proceed

On-device note: this uses the `sqlite3` CLI. If a gateway lacks it (per project memory,
only some Pis have it installed), run the check from a workstation against a pulled copy,
or port it to the on-device node-sqlite3 binding.

## Cloud sync token expiry

An expired cloud sync token can appear as `401` from `/auth/refresh-sync` and
`403` from pending-commands. Check `GET /api/sync/state` on the gateway for
`lastError`; a pending-commands `403` there means cloud sync has not recovered.

After the cloud receives its upgrade, leave the gateway linked and allow its
hourly refresh retry to run. The edge keeps the stored token after a failed
refresh, so no edge update or local unlink is needed. If refresh still fails
(`401` or `403`) after the cloud upgrade, re-link with the cloud account
password when the token is more than 365 days past expiry, the gateway was
unlinked in the cloud, or `farming.db` was restored from an older backup and its
token is both expired and superseded. A local `DELETE /api/account-link` only
unlinks the gateway locally; it does not revoke a token in the cloud.
