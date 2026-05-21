#!/usr/bin/env bash
# verify-chameleon-v1.5.sh — post-flash check for the V1.5 firmware on kaba100.
#
# Usage:
#   scripts/verify-chameleon-v1.5.sh /path/to/farming.db [hours]
#
# Defaults: hours = 13 (matches the pre-flash baseline window).
#
# Pre-flash baseline (kaba100, 13 h window before flashing V1.5):
#   - 12 of 158 uplinks (~7.6 %) had r2_comp != r2_raw and r3_comp != r3_raw.
#
# Post-flash success criteria (over the same DEUI, comparable window):
#   - >= 99 % of uplinks have r2_comp != r2_raw and r3_comp != r3_raw.
#   - < 1 % of uplinks have comp_pending = 1.
#   - i2c_missing / timeout / temp_fault / id_fault counts stay at pre-flash
#     levels (essentially zero on kaba100).

set -euo pipefail

DB="${1:?path to farming.db required}"
HOURS="${2:-13}"
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "HOURS must be a non-negative integer, got: $HOURS" >&2; exit 1; }
DEUI="A84041A75D5E7CFB"

[ -f "$DB" ] || { echo "DB not found: $DB" >&2; exit 1; }

sqlite3 -header -column "$DB" <<SQL
.print '== Window: last $HOURS h for $DEUI =='
WITH win AS (
  SELECT * FROM chameleon_readings
  WHERE deveui = '$DEUI'
    AND recorded_at >= datetime('now', '-$HOURS hours')
)
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN r1_ohm_comp != r1_ohm_raw THEN 1 ELSE 0 END) AS r1_ok,
  SUM(CASE WHEN r2_ohm_comp != r2_ohm_raw THEN 1 ELSE 0 END) AS r2_ok,
  SUM(CASE WHEN r3_ohm_comp != r3_ohm_raw THEN 1 ELSE 0 END) AS r3_ok,
  SUM(CASE WHEN comp_pending = 1 THEN 1 ELSE 0 END) AS pending,
  SUM(i2c_missing) AS i2c_missing,
  SUM(timeout)     AS timeout,
  SUM(temp_fault)  AS temp_fault,
  SUM(id_fault)    AS id_fault
FROM win;

.print ''
.print '== Sample of any comp_pending rows =='
SELECT recorded_at, temp_c,
       r1_ohm_raw AS r1raw, r1_ohm_comp AS r1c,
       r2_ohm_raw AS r2raw, r2_ohm_comp AS r2c,
       r3_ohm_raw AS r3raw, r3_ohm_comp AS r3c
FROM chameleon_readings
WHERE deveui='$DEUI'
  AND recorded_at >= datetime('now', '-$HOURS hours')
  AND comp_pending = 1
ORDER BY recorded_at DESC
LIMIT 5;
SQL
