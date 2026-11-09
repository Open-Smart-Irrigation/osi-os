-- risk: data
-- 0078: clear the LoRain legacy rain-rate estimates.
--
-- Before the LoRain rain contract (docs/contracts/rainfall/lorain.md) the
-- gateway divided each report's amount by the time since the previous
-- received report and stored it as rain_mm_per_hour and rain_mm_per_10min,
-- with that elapsed time in counter_interval_seconds. That time is not the
-- measurement window, so the values are not rates. The amount (rain_mm_delta)
-- is the measurement and stays.
--
-- The old writer set rain_mm_per_10min whenever it set a rate; the contract
-- writer never sets it. A LoRain row with rain_mm_per_10min is therefore a
-- legacy row, and a protocol-verified rate is left alone. Re-running is a
-- no-op. The cloud clears the same rows in its own migration.

UPDATE device_data
SET rain_mm_per_hour = NULL,
    rain_mm_per_10min = NULL,
    counter_interval_seconds = NULL
WHERE rain_mm_per_10min IS NOT NULL
  AND deveui IN (SELECT deveui FROM devices WHERE type_id = 'AQUASCOPE_LORAIN');
