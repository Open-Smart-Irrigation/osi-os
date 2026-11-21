-- risk: additive
-- Bound oldest-first expiry and pressure pruning across all SDI-12 devices.
CREATE INDEX IF NOT EXISTS idx_sdi12_transmissions_receipt_time
  ON sdi12_transmissions(received_at, id);
