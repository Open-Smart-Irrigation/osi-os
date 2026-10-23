# Root review of the history cursor plan

Approved for local Task 1 implementation after these revisions:

1. Defer scheduling changes. The measured cursor rewind is sufficient to justify an isolated fix; the finite queue and matching current manifests do not prove a persistent scheduling fault.
2. Dirty ACKs must neither rewind nor advance the ordered cursor. A newer correction can otherwise skip unsent rows.
3. Make sequential cursor advancement monotonic in SQL, not only against a JavaScript snapshot. Preserve the existing numeric/key representation and partial ACK behavior.
4. Do not regenerate flows from the historical migration script; it predates current radio and rejection handling. Use guarded JSON mutation on the two maintained profiles.
5. Test the actual shipped nodes for numeric and key cursors, older/newer dirty ACKs, subsequent tail progress, delayed older stream ACKs, and existing rejection/backoff behavior.
6. Keep retention and backfill separate. Existing cloud indexes can outlive raw rows; a matched manifest is not proof that raw history is recoverable through ordinary duplicate replay.

No live gateway rollout, cursor rewrite, account retention change, or cloud backfill is part of this patch.
