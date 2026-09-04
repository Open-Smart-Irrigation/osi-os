- Battery is expected to surface as bat_pct for Gen1 STREGA when Battery is numeric.
- The raw env signature ffff/ffff is treated as unavailable telemetry, not as valid 125 C / 100 % data.
- STREGA offline in the local GUI is defined by missing device_data rows, not by ChirpStack visibility.
- The shared STREGA ingest path must stay application/+/device/+/event/up after bootstrap.
- `scheduler-ack-schlport16-fport2-sample.json` / `clock-sync-ack-rtcport12-fport2-sample.json`:
  synthetic ACK frames built directly from the vendor decoder's ACK byte layout (battery ASCII
  digits + a status byte + `@` (0x40) + 2 ASCII-hex chars for the echoed port + 2 ASCII-hex chars
  for the status). They exercise the `Schl_Port`/`Schl_status` and `RTC_Port`/`RTC_status` fields
  that `osi-valve-control/ack.js`'s `interpretUplink()` consumes.
