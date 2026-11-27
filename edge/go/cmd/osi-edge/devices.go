package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jstimezone"
	"osi-edge/internal/jsvalue"
)

func init() {
	register("GET", "/api/devices", (*backend).listDevices)
}

func respondValue(w http.ResponseWriter, status int, value jsvalue.Value) {
	headers := w.Header()
	headers.Set("Access-Control-Allow-Origin", "*")
	headers.Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
	sendJSON(w, status, value)
}

func deviceAuth401(w http.ResponseWriter, text string) {
	respond(w, 401,
		jsvalue.Property("error", jsvalue.Str("Unauthorized")),
		jsvalue.Property("message", jsvalue.Str(text)),
	)
}

func rowsToValues(rows *farmRows) ([]jsvalue.Value, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []jsvalue.Value
	for rows.Next() {
		scans := make([]any, len(cols))
		for i := range scans {
			scans[i] = new(any)
		}
		if err := rows.Scan(scans...); err != nil {
			return nil, err
		}
		fields := make([]jsvalue.Field, len(cols))
		for i := range cols {
			fields[i] = jsvalue.Property(cols[i], sqlValue(scans[i].(*any)))
		}
		out = append(out, jsvalue.Obj(fields...))
	}
	return out, rows.Err()
}

func sqlValue(raw *any) jsvalue.Value {
	switch value := (*raw).(type) {
	case nil:
		return jsvalue.Nil()
	case int64:
		return jsvalue.Num(float64(value))
	case float64:
		return jsvalue.Num(value)
	case bool:
		return jsvalue.Bool(value)
	case string:
		return jsvalue.Str(value)
	case []byte:
		return jsvalue.Str(string(value))
	default:
		return jsvalue.Str("")
	}
}

func queryValues(ctx context.Context, db *farmDB, query string, args ...any) ([]jsvalue.Value, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return rowsToValues(rows)
}

var hex16 = regexp.MustCompile(`^[0-9A-F]{16}$`)

func upperTrim(text string) string {
	return jsvalue.Upper(jsvalue.Trim(text))
}

func parseJSONObject(value jsvalue.Value) jsvalue.Value {
	if value.Kind == jsvalue.Object {
		return value
	}
	if value.Kind != jsvalue.String {
		return jsvalue.Nil()
	}
	text := string(utf16.Decode(value.Text))
	// parseJsonObject: only '' is null without a parse; whitespace goes to
	// JSON.parse, which fails and warns.
	if text == "" {
		return jsvalue.Nil()
	}
	parsed, err := jsvalue.Parse([]byte(text))
	if err != nil {
		log.Print("merge-device-data: invalid stored JSON object")
		return jsvalue.Nil()
	}
	if parsed.Kind != jsvalue.Object {
		return jsvalue.Nil()
	}
	return parsed
}

var zonelessTimestamp = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$`)

func parseRecordedAtMs(value jsvalue.Value) (time.Time, bool) {
	if value.Kind != jsvalue.String {
		return time.Time{}, false
	}
	text := jsvalue.Trim(value.MustString())
	if match := zonelessTimestamp.FindStringSubmatch(text); match != nil {
		text = match[1] + "T" + match[2] + "Z"
	}
	return jsdate.Parse(text, dailyScheduleLocation())
}

type deviceTimezone struct {
	timezone string
	basis    string
}

func resolveTimezone(raw sql.NullString) (deviceTimezone, bool) {
	tz := jsvalue.Trim(raw.String)
	if !raw.Valid || tz == "" {
		return deviceTimezone{"UTC", "unassigned_default"}, false
	}
	if jstimezone.Canonical(tz) == "" {
		return deviceTimezone{"UTC", "invalid"}, true
	}
	upper := jsvalue.Upper(tz)
	if upper == "UTC" || upper == "ETC/UTC" || strings.Contains(tz, "/") {
		return deviceTimezone{tz, "zone"}, true
	}
	return deviceTimezone{tz, "abbreviation"}, true
}

func classifyTimezone(raw sql.NullString) (deviceTimezone, bool) {
	resolved, ok := resolveTimezone(raw)
	if !ok {
		return deviceTimezone{}, false
	}
	if resolved.basis == "zone" {
		return deviceTimezone{timezone: resolved.timezone}, true
	}
	return resolved, true
}

func (b *backend) resolveDeviceTimezones(ctx context.Context, euis []string) (map[string]deviceTimezone, error) {
	out := make(map[string]deviceTimezone, len(euis))
	seen := make(map[string]bool, len(euis))
	var unique []string
	for _, eui := range euis {
		normalized := upperTrim(eui)
		if !hex16.MatchString(normalized) || seen[normalized] {
			continue
		}
		seen[normalized] = true
		unique = append(unique, normalized)
		out[normalized] = deviceTimezone{"UTC", "unassigned_default"}
	}
	if len(unique) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(unique)), ",")
	args := make([]any, len(unique))
	for i, eui := range unique {
		args[i] = eui
	}
	rows, err := b.db.QueryContext(ctx, `
    SELECT d.deveui,
           iz.timezone AS zone_tz,
           (SELECT iz2.timezone
              FROM weather_station_zones w
              JOIN irrigation_zones iz2 ON iz2.id = w.zone_id AND iz2.deleted_at IS NULL
             WHERE w.deveui = d.deveui
             ORDER BY w.zone_id
             LIMIT 1) AS station_tz
      FROM devices d
      LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
     WHERE d.deveui IN (`+placeholders+`) AND d.deleted_at IS NULL`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var eui, zoneTz, stationTz sql.NullString
		if err := rows.Scan(&eui, &zoneTz, &stationTz); err != nil {
			return nil, err
		}
		normalized := upperTrim(eui.String)
		if !hex16.MatchString(normalized) {
			continue
		}
		if fromZone, ok := classifyTimezone(zoneTz); ok {
			basis := fromZone.basis
			if basis == "" {
				basis = "zone"
			}
			out[normalized] = deviceTimezone{fromZone.timezone, basis}
			continue
		}
		if fromStation, ok := classifyTimezone(stationTz); ok {
			basis := fromStation.basis
			if basis == "" {
				basis = "weather_station_zone"
			}
			out[normalized] = deviceTimezone{fromStation.timezone, basis}
		}
	}
	return out, rows.Err()
}

var latestDataKeys = []string{
	"swt_wm1", "swt_wm2", "swt_1", "swt_2", "swt_3",
	"vwc_1", "vwc_2", "vwc_3", "vwc_4", "vwc_5", "vwc_6", "vwc_7", "vwc_8", "vwc_9", "vwc_10",
	"soil_vic_1", "soil_vic_2", "soil_vic_3", "soil_vic_4", "soil_vic_5", "soil_vic_6", "soil_vic_7", "soil_vic_8", "soil_vic_9", "soil_vic_10",
	"soil_temp_1", "soil_temp_2", "soil_temp_3", "soil_temp_4", "soil_temp_5", "soil_temp_6", "soil_temp_7", "soil_temp_8",
	"soil_ec_1", "soil_ec_2", "soil_ec_3", "soil_ec_4", "soil_ec_5", "soil_ec_6", "soil_ec_7", "soil_ec_8",
	"light_lux", "ambient_temperature", "relative_humidity", "ext_temperature_c", "bat_v", "adc_ch0v", "adc_ch1v",
	"dendro_ratio", "dendro_mode_used", "dendro_position_raw_mm", "dendro_position_mm", "dendro_valid", "dendro_delta_mm",
	"dendro_stem_change_um", "dendro_saturated", "dendro_saturation_side",
	"lsn50_mode_code", "lsn50_mode_label", "lsn50_mode_observed_at",
	"rain_count_cumulative", "rain_tips_delta", "rain_mm_delta", "rain_mm_per_hour", "rain_mm_per_10min", "rain_mm_today", "rain_delta_status",
	"flow_count_cumulative", "flow_pulses_delta", "flow_liters_delta", "flow_liters_per_min", "flow_liters_per_10min", "flow_liters_today", "flow_delta_status",
	"counter_interval_seconds", "barometric_pressure_hpa", "wind_speed_mps", "wind_direction_deg", "wind_gust_mps", "uv_index", "rain_gauge_cumulative_mm", "bat_pct",
	"chameleon_reading_id", "chameleon_payload_b64", "chameleon_payload_version", "chameleon_status_flags",
	"chameleon_i2c_missing", "chameleon_timeout", "chameleon_temp_fault", "chameleon_id_fault",
	"chameleon_ch1_open", "chameleon_ch2_open", "chameleon_ch3_open", "chameleon_temp_c",
	"chameleon_r1_ohm_comp", "chameleon_r2_ohm_comp", "chameleon_r3_ohm_comp", "chameleon_r1_ohm_raw", "chameleon_r2_ohm_raw", "chameleon_r3_ohm_raw",
	"chameleon_array_id", "watermark",
}

func jsOrText(value jsvalue.Value) string {
	if value.Kind != jsvalue.String {
		return ""
	}
	return string(utf16.Decode(value.Text))
}

func listDevicesQuery(scoped bool) string {
	where := "d.user_id = ?"
	if scoped {
		where = "(d.user_id IS NOT NULL OR d.irrigation_zone_id IS NOT NULL)"
	}
	return `
    SELECT d.*, iz.zone_uuid AS irrigation_zone_uuid,
      CASE WHEN typeof(iz.zone_uuid) = 'blob' THEN hex(iz.zone_uuid) END AS __irrigation_zone_uuid_blob,
      (SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_expectation_id,
      (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_reconciliation_state,
      (SELECT vae.commanded_at FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_commanded_at,
      (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_expected_close_at,
      rd.desired_version AS sdi12_deployment_desired_version,
      rd.desired_layout_hash AS sdi12_deployment_desired_layout_hash,
      rd.desired_recipe_json AS sdi12_deployment_desired_recipe_json,
      rd.status AS sdi12_deployment_status,
      rd.queued_at AS sdi12_deployment_queued_at,
      rd.queue_drained_at AS sdi12_deployment_queue_drained_at,
      rd.commissioning_deadline_at AS sdi12_deployment_commissioning_deadline_at,
      rd.last_observed_at AS sdi12_deployment_last_observed_at,
      rd.last_error_code AS sdi12_deployment_last_error_code,
      rd.compatible_recipe_json AS sdi12_deployment_compatible_recipe_json,
      rd.compatible_layout_json AS sdi12_deployment_compatible_layout_json,
      rd.compatible_at AS sdi12_deployment_compatible_at,
      rd.updated_at AS sdi12_deployment_updated_at,
      ia.discovered_address AS sdi12_identify_discovered_address
    FROM devices d
    LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
    LEFT JOIN sdi12_recipe_deployments rd ON rd.deveui = d.deveui
    LEFT JOIN sdi12_identify_attempts ia ON ia.deveui = d.deveui
    WHERE ` + where + ` AND d.deleted_at IS NULL
    ORDER BY d.created_at DESC
  `
}

func latestDataQuery(euis string) string {
	return strings.Join([]string{
		"SELECT",
		"  dd.deveui,",
		"  dd.recorded_at AS last_uplink_at,",
		"  dd.swt_wm1,",
		"  dd.swt_wm2,",
		"  COALESCE(dd.swt_1, dd.swt_wm1) AS swt_1,",
		"  COALESCE(dd.swt_2, dd.swt_wm2) AS swt_2,",
		"  dd.swt_3,",
		"  dd.vwc_1,",
		"  dd.vwc_2,",
		"  dd.vwc_3,",
		"  dd.vwc_4,",
		"  dd.vwc_5,",
		"  dd.vwc_6,",
		"  dd.vwc_7,",
		"  dd.vwc_8,",
		"  dd.vwc_9,",
		"  dd.vwc_10,",
		"  dd.soil_vic_1,",
		"  dd.soil_vic_2,",
		"  dd.soil_vic_3,",
		"  dd.soil_vic_4,",
		"  dd.soil_vic_5,",
		"  dd.soil_vic_6,",
		"  dd.soil_vic_7,",
		"  dd.soil_vic_8,",
		"  dd.soil_vic_9,",
		"  dd.soil_vic_10,",
		"  dd.soil_temp_1,",
		"  dd.soil_temp_2,",
		"  dd.soil_temp_3,",
		"  dd.soil_temp_4,",
		"  dd.soil_temp_5,",
		"  dd.soil_temp_6,",
		"  dd.soil_temp_7,",
		"  dd.soil_temp_8,",
		"  dd.soil_ec_1,",
		"  dd.soil_ec_2,",
		"  dd.soil_ec_3,",
		"  dd.soil_ec_4,",
		"  dd.soil_ec_5,",
		"  dd.soil_ec_6,",
		"  dd.soil_ec_7,",
		"  dd.soil_ec_8,",
		"  dd.light_lux,",
		"  dd.ambient_temperature,",
		"  dd.relative_humidity,",
		"  dd.ext_temperature_c,",
		"  dd.bat_v,",
		"  dd.adc_ch0v,",
		"  dd.adc_ch1v,",
		"  dd.dendro_ratio,",
		"  dd.dendro_mode_used,",
		"  dd.dendro_position_raw_mm,",
		"  dd.dendro_position_mm,",
		"  dd.dendro_valid,",
		"  dd.dendro_delta_mm,",
		"  dd.dendro_stem_change_um,",
		"  dd.dendro_saturated,",
		"  dd.dendro_saturation_side,",
		"  dd.lsn50_mode_code,",
		"  dd.lsn50_mode_label,",
		"  dd.lsn50_mode_observed_at,",
		"  dd.rain_count_cumulative,",
		"  dd.rain_tips_delta,",
		"  dd.rain_mm_delta,",
		"  dd.rain_mm_per_hour,",
		"  dd.rain_mm_per_10min,",
		"  dd.rain_mm_today,",
		"  dd.rain_delta_status,",
		"  dd.flow_count_cumulative,",
		"  dd.flow_pulses_delta,",
		"  dd.flow_liters_delta,",
		"  dd.flow_liters_per_min,",
		"  dd.flow_liters_per_10min,",
		"  dd.flow_liters_today,",
		"  dd.flow_delta_status,",
		"  dd.counter_interval_seconds,",
		"  dd.barometric_pressure_hpa,",
		"  dd.wind_speed_mps,",
		"  dd.wind_direction_deg,",
		"  dd.wind_gust_mps,",
		"  dd.uv_index,",
		"  dd.rain_gauge_cumulative_mm,",
		"  dd.bat_pct,",
		"  (SELECT json_object('recorded_at', wr.recorded_at, 'supply_mv', wr.supply_mv, 'soil_temp_c', wr.soil_temp_c,",
		"     'soil_temp_source', wr.soil_temp_source, 'die_temp_c', wr.die_temp_c, 'channels', json_array(",
		"       json_object('status', wr.ch1_status, 'kpa', wr.ch1_kpa, 'kpa_upper_bound', wr.ch1_kpa_upper_bound,",
		"         'r_solved', wr.ch1_r_solved, 'r_upper_bound', wr.ch1_r_upper_bound, 'offset_mv', wr.ch1_offset_mv),",
		"       json_object('status', wr.ch2_status, 'kpa', wr.ch2_kpa, 'kpa_upper_bound', wr.ch2_kpa_upper_bound,",
		"         'r_solved', wr.ch2_r_solved, 'r_upper_bound', wr.ch2_r_upper_bound, 'offset_mv', wr.ch2_offset_mv)))",
		"   FROM watermark_readings wr WHERE wr.device_data_id = dd.id LIMIT 1) AS watermark_latest_json,",
		"  ch.id AS chameleon_reading_id,",
		"  ch.payload_b64 AS chameleon_payload_b64,",
		"  ch.payload_version AS chameleon_payload_version,",
		"  ch.status_flags AS chameleon_status_flags,",
		"  ch.i2c_missing AS chameleon_i2c_missing,",
		"  ch.timeout AS chameleon_timeout,",
		"  ch.temp_fault AS chameleon_temp_fault,",
		"  ch.id_fault AS chameleon_id_fault,",
		"  ch.ch1_open AS chameleon_ch1_open,",
		"  ch.ch2_open AS chameleon_ch2_open,",
		"  ch.ch3_open AS chameleon_ch3_open,",
		"  ch.temp_c AS chameleon_temp_c,",
		"  ch.r1_ohm_comp AS chameleon_r1_ohm_comp,",
		"  ch.r2_ohm_comp AS chameleon_r2_ohm_comp,",
		"  ch.r3_ohm_comp AS chameleon_r3_ohm_comp,",
		"  ch.r1_ohm_raw AS chameleon_r1_ohm_raw,",
		"  ch.r2_ohm_raw AS chameleon_r2_ohm_raw,",
		"  ch.r3_ohm_raw AS chameleon_r3_ohm_raw,",
		"  ch.array_id AS chameleon_array_id,",
		"  ch.calibration_status AS calibration_status",
		"FROM device_data dd",
		"INNER JOIN (",
		"  SELECT deveui, MAX(recorded_at) as max_time",
		"  FROM device_data",
		"  WHERE deveui IN (" + euis + ")",
		"  GROUP BY deveui",
		") latest ON dd.deveui = latest.deveui AND dd.recorded_at = latest.max_time",
		"LEFT JOIN (",
		"  SELECT cr.*",
		"  FROM chameleon_readings cr",
		"  WHERE cr.recorded_at IS NOT NULL",
		"    AND cr.deveui IN (" + euis + ")",
		"    AND NOT EXISTS (",
		"      SELECT 1",
		"      FROM chameleon_readings newer",
		"      WHERE newer.deveui = cr.deveui",
		"        AND newer.recorded_at IS NOT NULL",
		"        AND (",
		"          newer.recorded_at > cr.recorded_at",
		"          OR (newer.recorded_at = cr.recorded_at AND newer.id > cr.id)",
		"        )",
		"    )",
		") ch ON ch.deveui = dd.deveui",
	}, "\n")
}

func (b *backend) listDevices(w http.ResponseWriter, r *http.Request, _ params, _ httpbody.Body) {
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		deviceAPIFailure(w, failure)
		return
	}
	// get-devices-auth splices the username, in both modes.
	if err := legacyUserLookupError(session); err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	ctx := r.Context()
	var userID int64
	err := b.db.QueryRowContext(ctx, "SELECT id FROM users WHERE id = ? AND username = ?",
		legacyUserLookupID(session), session.Username.MustString()).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		message(w, 401, "User not found")
		return
	}
	if err != nil {
		log.Printf("devices-list: %v", err)
		message(w, 500, "device-api failed")
		return
	}
	scoped := scopedAccess()
	var args []any
	if !scoped {
		args = append(args, session.UserID)
	} else {
		// assertEnabledAccount(db, user && user.user_uuid): the value keeps
		// its storage class, and loadUser refuses a falsy one with 500.
		// get-devices-query binds Number(msg.payload[0].id), a double: user
		// 123456789012345700 passes the spelled gate and misses here.
		var userUUID storedValue
		err := b.db.QueryRowContext(ctx, "SELECT user_uuid FROM users WHERE id = ?", float64(userID)).Scan(&userUUID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			message(w, 500, err.Error())
			return
		}
		if !userUUID.truthy() {
			message(w, 500, "resolveScope called without user_uuid")
			return
		}
		if problem := b.assertEnabledAccount(ctx, userUUID); problem != nil {
			scopeRespond(w, problem)
			return
		}
	}
	b.writes.RLock()
	defer b.writes.RUnlock()
	devices, err := queryValues(ctx, b.db, listDevicesQuery(scoped), args...)
	if err != nil {
		log.Printf("devices-list: %v", err)
		message(w, 500, "device-api failed")
		return
	}
	if len(devices) == 0 {
		respondValue(w, 200, jsvalue.Arr())
		return
	}
	seen := make(map[string]bool)
	var validEuis []string
	for _, d := range devices {
		eui := upperTrim(jsOrText(d.Get("deveui")))
		if hex16.MatchString(eui) && !seen[eui] {
			seen[eui] = true
			validEuis = append(validEuis, eui)
		}
	}
	// With no canonical EUI, format-devices swaps the latest-data query for
	// `SELECT NULL AS deveui WHERE 0`; merge-device-data still formats every
	// device it kept in msg.devices_to_format.
	var sensorRows []jsvalue.Value
	if len(validEuis) > 0 {
		quoted := make([]string, len(validEuis))
		for i, eui := range validEuis {
			quoted[i] = "'" + eui + "'"
		}
		sensorRows, err = queryValues(ctx, b.db, latestDataQuery(strings.Join(quoted, ",")))
		if err != nil {
			log.Printf("merge-device-data: %v", err)
			message(w, 500, "device-api failed")
			return
		}
	}
	dataMap := make(map[string]jsvalue.Value, len(sensorRows))
	for _, row := range sensorRows {
		dataMap[upperTrim(jsOrText(row.Get("deveui")))] = row
	}
	result := make([]jsvalue.Value, 0, len(devices))
	for _, d := range devices {
		result = append(result, b.deviceWireObject(d, dataMap[upperTrim(jsOrText(d.Get("deveui")))]))
	}
	b.enrichWeatherStationZones(ctx, result)
	b.enrichRainDays(ctx, result)
	respondValue(w, 200, jsvalue.Arr(result...))
}

func jsText(value jsvalue.Value) jsvalue.Value {
	if value.Kind == jsvalue.String && len(value.Text) > 0 {
		return value
	}
	return jsvalue.Nil()
}

func nullish(value jsvalue.Value) jsvalue.Value {
	if value.Kind == jsvalue.Null || value.Kind == jsvalue.Undefined {
		return jsvalue.Nil()
	}
	return value
}

// irrigationZoneUUID is `d.irrigation_zone_uuid || null`; a BLOB zone_uuid is
// a Buffer, which is truthy and serializes as {"type":"Buffer","data":[...]}.
func irrigationZoneUUID(d jsvalue.Value) jsvalue.Value {
	if blob := d.Get("__irrigation_zone_uuid_blob"); blob.Kind == jsvalue.String {
		if raw, err := hex.DecodeString(blob.MustString()); err == nil {
			return storedOf(raw).json()
		}
	}
	return orNil(d.Get("irrigation_zone_uuid"))
}

func orNil(value jsvalue.Value) jsvalue.Value {
	if value.Truthy() {
		return value
	}
	return jsvalue.Nil()
}

func intFlag(d jsvalue.Value, key string, fallback float64) jsvalue.Field {
	value := d.Get(key)
	if value.Kind != jsvalue.Number {
		value = jsvalue.Num(fallback)
	}
	return jsvalue.Property(key, value)
}

func numberOrZero(value jsvalue.Value) jsvalue.Value {
	if value.Kind != jsvalue.Number {
		return jsvalue.Num(0)
	}
	return value
}

func (b *backend) deviceWireObject(d, latest jsvalue.Value) jsvalue.Value {
	eui := upperTrim(jsOrText(d.Get("deveui")))
	hasData := latest.Kind == jsvalue.Object
	var latestFields []jsvalue.Field
	if hasData {
		latestFields = make([]jsvalue.Field, 0, len(latestDataKeys))
		for _, key := range latestDataKeys {
			if key == "watermark" {
				latestFields = append(latestFields, jsvalue.Property(key, parseJSONObject(latest.Get("watermark_latest_json"))))
				continue
			}
			latestFields = append(latestFields, jsvalue.Property(key, nullish(latest.Get(key))))
		}
	} else {
		latestFields = append(latestFields, jsvalue.Property("watermark", jsvalue.Nil()))
	}
	lastSeen := jsvalue.Nil()
	if hasData {
		lastSeen = jsText(latest.Get("last_uplink_at"))
	}
	calibration := jsvalue.Nil()
	if hasData {
		calibration = nullish(latest.Get("calibration_status"))
	}
	layoutRaw := d.Get("sdi12_channel_layout_json")
	parsedLayout := parseJSONObject(layoutRaw)
	layoutStatus := jsvalue.Nil()
	if layoutRaw.Truthy() && parsedLayout.Kind != jsvalue.Object {
		layoutStatus = jsvalue.Str("invalid")
	} else if parsedLayout.Kind == jsvalue.Object {
		layoutStatus = jsvalue.Str("configured")
	} else if jsOrText(d.Get("sdi12_probe_profile")) == "SENTEK_ENVIROSCAN" {
		layoutStatus = jsvalue.Str("legacy_count")
	}
	expectationID := d.Get("active_valve_expectation_id")
	actuation := jsvalue.Nil()
	camelActuation := jsvalue.Nil()
	if expectationID.Truthy() {
		actuation = jsvalue.Obj(
			jsvalue.Property("expectation_id", expectationID),
			jsvalue.Property("reconciliation_state", orNil(d.Get("active_valve_reconciliation_state"))),
			jsvalue.Property("commanded_at", orNil(d.Get("active_valve_commanded_at"))),
			jsvalue.Property("expected_close_at", orNil(d.Get("active_valve_expected_close_at"))),
		)
		camelActuation = jsvalue.Obj(
			jsvalue.Property("expectationId", expectationID),
			jsvalue.Property("reconciliationState", orNil(d.Get("active_valve_reconciliation_state"))),
			jsvalue.Property("commandedAt", orNil(d.Get("active_valve_commanded_at"))),
			jsvalue.Property("expectedCloseAt", orNil(d.Get("active_valve_expected_close_at"))),
		)
	}
	device := jsvalue.Obj(
		jsvalue.Property("deveui", jsvalue.Str(eui)),
		jsvalue.Property("name", nullish(d.Get("name"))),
		jsvalue.Property("type_id", nullish(d.Get("type_id"))),
		jsvalue.Property("last_seen", lastSeen),
		jsvalue.Property("latest_data", jsvalue.Obj(latestFields...)),
		jsvalue.Property("calibration_status", calibration),
		jsvalue.Property("current_state", nullish(d.Get("current_state"))),
		jsvalue.Property("target_state", nullish(d.Get("target_state"))),
		intFlag(d, "dendro_enabled", 0),
		intFlag(d, "temp_enabled", 0),
		intFlag(d, "rain_gauge_enabled", 0),
		intFlag(d, "flow_meter_enabled", 0),
		intFlag(d, "is_reference_tree", 0),
		intFlag(d, "device_mode", 1),
		intFlag(d, "dendro_force_legacy", 0),
		jsvalue.Property("dendro_stroke_mm", nullish(d.Get("dendro_stroke_mm"))),
		jsvalue.Property("dendro_ratio_at_retracted", nullish(d.Get("dendro_ratio_at_retracted"))),
		jsvalue.Property("dendro_ratio_at_extended", nullish(d.Get("dendro_ratio_at_extended"))),
		jsvalue.Property("dendro_ratio_zero", nullish(d.Get("dendro_ratio_zero"))),
		jsvalue.Property("dendro_ratio_span", nullish(d.Get("dendro_ratio_span"))),
		intFlag(d, "dendro_invert_direction", 0),
		intFlag(d, "dendro_baseline_pending", 0),
		intFlag(d, "chameleon_enabled", 0),
		jsvalue.Property("chameleon_swt1_depth_cm", nullish(d.Get("chameleon_swt1_depth_cm"))),
		jsvalue.Property("chameleon_swt2_depth_cm", nullish(d.Get("chameleon_swt2_depth_cm"))),
		jsvalue.Property("chameleon_swt3_depth_cm", nullish(d.Get("chameleon_swt3_depth_cm"))),
		jsvalue.Property("sdi12_probe_profile", nullish(d.Get("sdi12_probe_profile"))),
		jsvalue.Property("sdi12_probe_status", nullish(d.Get("sdi12_probe_status"))),
		jsvalue.Property("sdi12_identity", nullish(d.Get("sdi12_identity"))),
		jsvalue.Property("sdi12_value_count", nullish(d.Get("sdi12_value_count"))),
		jsvalue.Property("sdi12_channel_layout_json", parsedLayout),
		jsvalue.Property("sdi12_layout_status", layoutStatus),
		jsvalue.Property("updated_at", nullish(d.Get("updated_at"))),
		jsvalue.Property("irrigation_zone_id", nullish(d.Get("irrigation_zone_id"))),
		jsvalue.Property("irrigation_zone_uuid", irrigationZoneUUID(d)),
		jsvalue.Property("strega_model", orNil(d.Get("strega_model"))),
		jsvalue.Property("active_valve_actuation", actuation),
		jsvalue.Property("activeValveActuation", camelActuation),
		jsvalue.Property("soil_moisture_probe_depths_json", parseJSONObject(d.Get("soil_moisture_probe_depths_json"))),
		jsvalue.Property("soil_moisture_probe_depths_configured", numberOrZero(d.Get("soil_moisture_probe_depths_configured"))),
		jsvalue.Property("gateway_device_eui", orNil(d.Get("gateway_device_eui"))),
		jsvalue.Property("sync_version", numberOrZero(d.Get("sync_version"))),
		jsvalue.Property("deleted_at", orNil(d.Get("deleted_at"))),
	)
	if jsOrText(d.Get("type_id")) == "DRAGINO_SDI12" {
		device.Set(jsvalue.Property("sdi12_recipe_deployment", sdi12Deployment(d)))
		device.Set(jsvalue.Property("sdi12_discovered_address", sdi12DiscoveredAddress(d.Get("sdi12_identify_discovered_address"))))
	}
	return device
}

func (b *backend) enrichRainDays(ctx context.Context, result []jsvalue.Value) {
	var rainIndices []int
	var rainEuis []string
	for i := range result {
		typeID := jsOrText(result[i].Get("type_id"))
		rainEnabled := result[i].Get("rain_gauge_enabled")
		if typeID == "AQUASCOPE_LORAIN" || typeID == "SENSECAP_S2120" ||
			(rainEnabled.Kind == jsvalue.Number && rainEnabled.Num == 1) {
			rainIndices = append(rainIndices, i)
			rainEuis = append(rainEuis, jsOrText(result[i].Get("deveui")))
		}
	}
	if len(rainIndices) == 0 {
		return
	}
	tzMap, err := b.resolveDeviceTimezones(ctx, rainEuis)
	if err != nil {
		log.Printf("merge-device-data: rain_day omitted: %v", err)
		return
	}
	for _, i := range rainIndices {
		stamp, ok := parseRecordedAtMs(result[i].Get("last_seen"))
		tz, found := tzMap[upperTrim(jsOrText(result[i].Get("deveui")))]
		if !ok || !found {
			continue
		}
		loc := jstimezone.Location(tz.timezone)
		for j := range result[i].Fields {
			if string(utf16.Decode(result[i].Fields[j].Key)) != "latest_data" {
				continue
			}
			latest := &result[i].Fields[j].Value
			if latest.Kind != jsvalue.Object {
				break
			}
			latest.Set(jsvalue.Property("rain_day", jsvalue.Str(intlRainDay(stamp.In(loc)))))
			latest.Set(jsvalue.Property("rain_day_timezone", jsvalue.Str(tz.timezone)))
			latest.Set(jsvalue.Property("rain_day_timezone_basis", jsvalue.Str(tz.basis)))
			break
		}
	}
}

// intlRainDay is merge-device-data's p.year + '-' + p.month + '-' + p.day
// over Intl.DateTimeFormat('en-CA', {year: 'numeric', month: '2-digit',
// day: '2-digit'}).formatToParts. The gateway has no en_CA data and resolves
// en (MM/DD/YYYY order), but the parts, and so this string, are the same.
func intlRainDay(local time.Time) string {
	year := local.Year()
	if year <= 0 {
		year = 1 - year // Intl's Gregorian year-of-era, with no era field requested.
	}
	return strconv.Itoa(year) + local.Format("-01-02")
}
