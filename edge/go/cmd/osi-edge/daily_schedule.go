package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"os"
	"slices"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsnum"
	"osi-edge/internal/jsvalue"
)

func init() {
	registerCalendarTimer("daily-schedule-0600", nextDailySchedule, (*backend).dailyScheduleTick)
}

type dailyDecision struct {
	action, reason string
	aggregate      any
	minutes        float64
	payload        jsvalue.Value
}

func (b *backend) dailyScheduleTick(ctx context.Context) error {
	zones, err := queryZones(ctx, b.db, dailyZonesQuery)
	if err != nil {
		log.Printf("daily schedule zone query: %v", err)
		return nil
	}
	for _, zone := range zones {
		if err := b.evaluateDailyZone(ctx, zone, time.Now()); err != nil {
			log.Printf("daily schedule zone %g: %v", zone.Get("zone_id").Num, err)
		}
	}
	return nil
}

// dailyZoneStoredText gives the zone row's columns that decision.js coerces
// with String() or Number() their JavaScript value when SQLite stored them as
// a BLOB: node-sqlite3 hands over a Buffer, and String(buffer) and
// Number(buffer) read its bytes as UTF-8 text, where the Buffer-shaped object
// queryZones builds would read "[object Object]" and NaN. A BLOB
// last_triggered_at of today then debounces, a BLOB scheduling_mode
// 'server_preferred' selects the server recommendation, and a BLOB
// threshold or duration counts as its number. shared_environment_json stays
// a Buffer (decision.js takes it only when typeof is 'string').
func dailyZoneStoredText(zone jsvalue.Value) jsvalue.Value {
	if zone.Kind != jsvalue.Object {
		return zone
	}
	out := zone
	out.Fields = slices.Clone(zone.Fields)
	for _, name := range []string{"scheduling_mode", "last_triggered_at", "trigger_metric", "threshold_kpa", "duration_minutes"} {
		if raw, ok := storedBufferBytes(zone.Get(name)); ok {
			out.Set(jsvalue.Property(name, jsvalue.Str(jsvalue.DecodeUTF8(string(raw)))))
		}
	}
	return out
}

func (b *backend) evaluateDailyZone(ctx context.Context, zone jsvalue.Value, now time.Time) (err error) {
	defer jsvalue.CatchConversion(&err)
	zone = dailyZoneStoredText(zone)
	id := zone.Get("zone_id").MustNumber()
	user := zone.Get("user_id").MustNumber()
	if math.IsNaN(id) || math.IsNaN(user) || math.IsInf(id, 0) || math.IsInf(user, 0) {
		return nil
	}
	metric := jsvalue.Upper(zone.Get("trigger_metric").OrEmpty().MustString())
	var rows []jsvalue.Value
	if metric == "DENDRO" {
		rows, err = queryZones(ctx, b.db, `SELECT zone_stress_summary,irrigation_action,action_reasoning,
			date AS analytics_date,computed_at AS analytics_computed_at
			FROM zone_daily_recommendations WHERE zone_id=? ORDER BY date DESC,computed_at DESC LIMIT 1`, sqliteNumberLiteral(id))
	} else {
		rows, err = queryZones(ctx, b.db, dailySWTQuery(metric), sqliteNumberLiteral(id), valveISO(now.Add(-time.Hour)))
	}
	if err != nil {
		return err
	}
	if scopedAccess() && zone.Get("enabled_scope_holders").MustNumber() < 1 {
		log.Printf("daily schedule zone %g disabled after scope loss", id)
		_, err := b.db.ExecContext(ctx, `UPDATE irrigation_schedules SET enabled=0, sync_version=COALESCE(sync_version,0)+1,
			updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE irrigation_zone_id=?`, sqliteNumberLiteral(id))
		return err
	}
	var measurement jsvalue.Value
	if len(rows) > 0 {
		measurement = rows[0]
	}
	d := decideDailyZone(zone, measurement, metric, now)
	valve := dailyValveEUI(zone)
	threshold := zone.Get("threshold_kpa").MustNumber()
	// The flow interpolates NaN or Infinity as a bare SQL token, so the event
	// insert fails independently of the decision, stamp and dispatch paths.
	if math.IsNaN(threshold) || math.IsInf(threshold, 0) {
		log.Printf("daily schedule zone %g event: non-finite threshold", id)
	} else if spliceErr := dailyEventSpliceError(valve); spliceErr != nil {
		// decision.js splices '${escapeSqlString(valveDevEui)}' into every
		// event INSERT that names a valve (lines 172, 199, 238, 293, 324,
		// 367, 390, 432); quote doubling leaves a NUL, which ends the
		// statement inside the literal. Only that statement fails: the
		// schedule stamp and the dispatch below are separate messages.
		log.Printf("daily schedule zone %g event: %v", id, spliceErr)
	} else {
		_, insertErr := b.db.ExecContext(ctx, `INSERT INTO irrigation_events
			(user_id,irrigation_zone_id,action,reason,aggregate_kpa,threshold_kpa,duration_minutes,valve_deveui,payload_json)
			VALUES (?,?,?,?,?,?,?,?,?)`, sqliteNumberLiteral(user), sqliteNumberLiteral(id), d.action, d.reason, sqliteNumberLiteral(d.aggregate),
			sqliteNumberLiteral(threshold), sqliteNumberLiteral(d.minutes), scheduleSQLValue(valve), valveJSON(d.payload))
		if insertErr != nil {
			log.Printf("daily schedule zone %g event: %v", id, insertErr)
		}
	}
	if d.action != "IRRIGATE" {
		return nil
	}
	// The flow sends the decision and schedule stamp independently of dispatch.
	at := valveISO(now)
	if _, err := b.db.ExecContext(ctx, "UPDATE irrigation_schedules SET last_triggered_at=?,updated_at=? WHERE irrigation_zone_id=?",
		at, at, sqliteNumberLiteral(id)); err != nil {
		log.Printf("daily schedule zone %g stamp: %v", id, err)
	}
	if jsvalue.Trim(os.Getenv("CHIRPSTACK_APP_ACTUATORS")) == "" {
		return errors.New("missing CHIRPSTACK_APP_ACTUATORS")
	}
	// A fractional legacy duration fails the encoder's frame/authorization comparison.
	if math.Trunc(d.minutes) != d.minutes {
		return errors.New("authorized STREGA duration no longer matches the encoded frame")
	}
	eui := jsvalue.Upper(jsvalue.Trim(valve.MustString()))
	// dispatch.js reads current_state inside the reservation under
	// withValveWriter: the state the hold decision uses is read under the lock.
	valveWriter.Lock()
	defer valveWriter.Unlock()
	found, err := b.findValve(ctx, eui, true)
	if err != nil {
		return err
	}
	found.zone = sql.NullInt64{Int64: int64(id), Valid: true}
	_, _, err = b.dispatchValve(ctx, found, uuid.NewString(), valveOpen, int(d.minutes),
		valveDispatchOptions{schedulerReason: d.reason})
	return err
}

// dailyEventSpliceError is the SQLite error of decision.js's event INSERT for
// the valve it embeds, or nil. dailyValveEUI is the flow's valveOk value:
// a non-empty string is spliced, anything else is NULL (the missing_valve
// rows) and cannot fail. JSON.stringify escapes a NUL in payload_json, and
// every other value in the statement is a number.
func dailyEventSpliceError(valve jsvalue.Value) error {
	if valve.Kind != jsvalue.String {
		return nil
	}
	return splicedLiteralError(valve.MustString())
}

func dailyValveEUI(zone jsvalue.Value) jsvalue.Value {
	valve := zone.Get("valve_deveui")
	if valve.Kind != jsvalue.String || !valve.Truthy() {
		return jsvalue.Nil()
	}
	return valve
}

func decideDailyZone(zone, reading jsvalue.Value, metric string, now time.Time) dailyDecision {
	raw := zone.Get("duration_minutes")
	minutes := 20.0
	if raw.Kind != jsvalue.Null && raw.Kind != jsvalue.Undefined {
		minutes = raw.MustNumber()
	}
	if minutes <= 0 || math.IsNaN(minutes) || math.IsInf(minutes, 0) {
		minutes = 10
	}
	minutes = min(240, minutes)
	last, valid := jsdate.Parse(zone.Get("last_triggered_at").OrEmpty().MustString(), dailyScheduleLocation())
	alreadyFired := valid && last.UTC().Format(time.DateOnly) == now.UTC().Format(time.DateOnly)
	if metric == "DENDRO" {
		return decideDailyDendro(zone, reading, minutes, alreadyFired, now)
	}
	return decideDailySWT(zone, reading, minutes, alreadyFired, now)
}

func dailyPayload(zone jsvalue.Value, action, reason string, tail ...jsvalue.Field) jsvalue.Value {
	p := jsvalue.Property
	fields := []jsvalue.Field{p("zone_id", zone.Get("zone_id")), p("action", jsvalue.Str(action)), p("reason", jsvalue.Str(reason))}
	return jsvalue.Obj(append(fields, tail...)...)
}

func decideDailySWT(zone, reading jsvalue.Value, minutes float64, alreadyFired bool, now time.Time) dailyDecision {
	p := jsvalue.Property
	mean, points := reading.Get("mean_kpa").MustNumber(), reading.Get("n_points").MustNumber()
	threshold := jsvalue.Num(zone.Get("threshold_kpa").MustNumber())
	valve := dailyValveEUI(zone)
	window := jsvalue.Obj(
		p("min_recorded_at", zoneFallback(reading.Get("min_recorded_at"), jsvalue.Nil())),
		p("max_recorded_at", zoneFallback(reading.Get("max_recorded_at"), jsvalue.Nil())))
	timestamp := jsvalue.Str(valveISO(now))
	metric := zone.Get("trigger_metric")
	action, reason := "SKIP", "below_threshold"
	meanValue := jsvalue.Num(mean)
	var aggregate any = mean
	var fields []jsvalue.Field
	switch {
	case math.IsNaN(mean) || math.IsInf(mean, 0) || math.IsNaN(points) || math.IsInf(points, 0) || points <= 0:
		reason, meanValue, aggregate = "no_data_last_hour", jsvalue.Nil(), nil
		points = zoneFallback(jsvalue.Num(points), jsvalue.Num(0)).Num
	case !valve.Truthy():
		reason = "missing_valve"
	case mean >= threshold.Num && alreadyFired:
		reason = "clock_jump_backward_suppressed"
		fields = []jsvalue.Field{p("trigger_metric", metric), p("threshold_kpa", threshold),
			p("mean_kpa", meanValue), p("n_points", jsvalue.Num(points)), p("valve_deveui", valve)}
	case mean >= threshold.Num:
		action, reason = "IRRIGATE", "scheduler_threshold"
		fields = []jsvalue.Field{p("mean_kpa_last_hour", meanValue), p("threshold_kpa", threshold), p("trigger_metric", metric),
			p("n_points_last_hour", jsvalue.Num(points)), p("valve_deveui", valve), p("duration_minutes", jsvalue.Num(minutes)),
			p("window", window)}
	}
	if fields == nil {
		fields = []jsvalue.Field{p("mean_kpa", meanValue), p("threshold_kpa", threshold), p("n_points", jsvalue.Num(points)),
			p("valve_deveui", valve), p("window", window)}
	}
	payload := dailyPayload(zone, action, reason, append(fields, p("timestamp", timestamp))...)
	return dailyDecision{action: action, reason: reason, aggregate: aggregate, minutes: minutes, payload: payload}
}

func decideDailyDendro(zone, rec jsvalue.Value, minutes float64, alreadyFired bool, now time.Time) dailyDecision {
	p := jsvalue.Property
	text := func(v jsvalue.Value) string { return jsvalue.Trim(v.OrEmpty().MustString()) }
	threshold := jsvalue.Num(zone.Get("threshold_kpa").MustNumber())
	valve := dailyValveEUI(zone)
	mode := "local"
	if jsvalue.Lower(text(zone.Get("scheduling_mode"))) == "server_preferred" {
		mode = "server_preferred"
	}
	source := "local_dendro"
	action := text(rec.Get("irrigation_action"))
	reasoning := text(rec.Get("action_reasoning"))
	stress := jsvalue.Lower(text(zoneFallback(rec.Get("zone_stress_summary"), jsvalue.Str("unknown"))))
	date := zoneFallback(rec.Get("analytics_date"), jsvalue.Nil())
	computed := zoneFallback(rec.Get("analytics_computed_at"), jsvalue.Nil())
	// decision.js normalizes the server action even in local mode.
	bundle, _ := jsvalue.Parse([]byte(zone.Get("shared_environment_json").OrEmpty().MustString()))
	water := bundle.Get("water").Get("action")
	actionCode := text(water.Get("code"))
	if mode == "server_preferred" {
		display := bundle.Get("display")
		received := zoneFallback(zone.Get("shared_environment_received_at"),
			zoneFallback(display.Get("lastReceivedAt"), bundle.Get("generatedAt")))
		// decision.js:82 isFreshServerBundle runs new Date(receivedAt) once the
		// bundle parsed; ToPrimitive throws on an own non-callable toString.
		receivedAt := dailyDateValue(received)
		age := now.Sub(receivedAt)
		fresh := !receivedAt.IsZero() && age >= 0 && age <= 6*time.Hour && serverDendroAction(actionCode)
		if fresh && jsvalue.Lower(text(water.Get("source"))) == "dendro" {
			source, action, reasoning = "server_shared_bundle", actionCode, text(water.Get("reasoning"))
			if bundle.Get("drift").Get("serverActionCode").Truthy() {
				stress = "server_preferred"
			}
			date = zoneFallback(water.Get("recommendationDate"), zoneFallback(water.Get("date"), jsvalue.Nil()))
			computed = zoneFallback(display.Get("sharedGeneratedAt"), zoneFallback(zone.Get("shared_environment_received_at"), jsvalue.Nil()))
		}
	}
	metric := jsvalue.Str("DENDRO")
	timestamp := jsvalue.Str(valveISO(now))
	base := []jsvalue.Field{p("trigger_metric", metric), p("threshold_kpa", threshold), p("scheduling_mode", jsvalue.Str(mode))}
	recommendation := []jsvalue.Field{p("recommendation_source", jsvalue.Str(source)), p("recommendation_action", jsvalue.Str(action))}
	recommendation = append(recommendation, p("zone_stress", jsvalue.Str(stress)), p("analytics_date", date))
	result := func(decisionAction, reason string, duration float64, fields ...jsvalue.Field) dailyDecision {
		return dailyDecision{action: decisionAction, reason: reason, minutes: duration,
			payload: dailyPayload(zone, decisionAction, reason, fields...)}
	}
	if action == "" {
		return result("SKIP", "no_dendro_recommendation", minutes, append(base, p("valve_deveui", valve), p("timestamp", timestamp))...)
	}

	computedAt := dailyDateValue(computed)
	age := float64(now.UnixMilli()-computedAt.UnixMilli()) / 3600000
	if computedAt.IsZero() || age > 36 {
		ageHours := jsvalue.Nil()
		if !computedAt.IsZero() {
			ageHours = jsvalue.Num(jsnum.Round(age*10) / 10)
		}
		fields := append(base, recommendation...)
		fields = append(fields, p("analytics_computed_at", computed), p("analytics_age_hours", ageHours),
			p("valve_deveui", valve), p("timestamp", timestamp))
		return result("SKIP", "stale_dendro_recommendation", minutes, fields...)
	}
	if !valve.Truthy() {
		fields := append(base, recommendation...)
		return result("SKIP", "missing_valve", minutes, append(fields, p("timestamp", timestamp))...)
	}
	if alreadyFired {
		return result("SKIP", "clock_jump_backward_suppressed", minutes, base[:2]...)
	}
	factor := 1.0
	switch action {
	case "decrease_20":
		factor = 0.8
	case "decrease_10":
		factor = 0.9
	case "increase_10":
		factor = 1.1
	case "increase_20":
		factor = 1.2
	case "emergency_irrigate":
		factor = 1.5
	}
	scaled := jsnum.Round(minutes * factor)
	if scaled <= 0 {
		scaled = 10
	}
	scaled = min(240, scaled)
	return result("IRRIGATE", "scheduler_dendro", scaled,
		p("scheduling_mode", jsvalue.Str(mode)), p("recommendation_source", jsvalue.Str(source)),
		p("trigger_metric", metric), p("threshold_kpa", threshold), p("recommendation_action", jsvalue.Str(action)),
		p("effective_action", jsvalue.Str(action)), p("recommendation_reasoning", jsvalue.Str(reasoning)),
		p("effective_reasoning", zoneFallback(jsvalue.Str(reasoning), jsvalue.Str("Dendrometer recommendation"))),
		p("zone_stress_summary", jsvalue.Str(stress)), p("analytics_date", date), p("analytics_computed_at", computed),
		p("valve_deveui", valve), p("base_duration_minutes", jsvalue.Num(minutes)),
		p("duration_minutes", jsvalue.Num(scaled)), p("timestamp", timestamp))
}

func serverDendroAction(action string) bool {
	switch action {
	case "decrease_20", "decrease_10", "maintain", "maintain_rain_suppression", "maintain_recovery_hold",
		"increase_10", "increase_20", "emergency_irrigate":
		return true
	default:
		return false
	}
}

func (b *backend) recordDailyValveAcceptance(ctx context.Context, valve valveDevice, minutes int, reason string) error {
	_, targetErr := b.db.ExecContext(ctx, "UPDATE devices SET target_state='OPEN' WHERE UPPER(deveui)=?", valve.eui)
	_, auditErr := b.db.ExecContext(ctx, `INSERT INTO actuator_log(deveui,action,duration_minutes,reason,created_at,irrigation_zone_id)
		VALUES (?,'OPEN_FOR_DURATION',?,?,?,?)`, valve.eui, minutes, reason, valveISO(time.Now()), actuatorLogZone(valve.zone))
	if auditErr != nil {
		return errors.Join(targetErr, auditErr)
	}
	gateway := valveGatewayTopicEUI()
	p := jsvalue.Property
	payload := jsvalue.Obj(p("deviceEui", jsvalue.Str(valve.eui)), p("gatewayDeviceEui", jsvalue.Str(gateway)),
		p("state", jsvalue.Str("OPEN")), p("timestamp", jsvalue.Str(valveISO(time.Now()))))
	publishErr := b.cloud.Publish("devices/"+gateway+"/status", []byte(valveJSON(payload)))
	return errors.Join(targetErr, publishErr)
}

func dailyDateValue(v jsvalue.Value) time.Time {
	if !v.Truthy() {
		return time.Time{}
	}
	at, _ := v.MustDate(dailyScheduleLocation())
	return at
}
