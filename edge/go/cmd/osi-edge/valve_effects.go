package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"math"
	"regexp"
	"time"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

// conditionalValveHold is dispatch.js findConflict for an ordinary candidate,
// in its order: the device's expectations ORDER BY rowid DESC, each with its
// occurrence, then the active occurrences without an expectation in the order
// the gateway's SQLite returns findConflict's occurrence read (it scans
// idx_irrigation_occurrences_command, so by command_id). The first owner that
// holds, or the first malformed one, decides.
func (b *backend) conditionalValveHold(ctx context.Context, valve valveDevice, id string, now time.Time) (bool, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT o.expires_at,o.reservation_end_at,o.decision_evidence_json,
		e.expectation_id,e.transport_json,e.observed_open_at,e.observed_close_at
		FROM irrigation_occurrences o LEFT JOIN valve_actuation_expectations e
		ON e.command_id=o.command_id AND UPPER(e.device_eui)=UPPER(o.device_eui)
		WHERE UPPER(o.device_eui)=? AND o.command_id<>? AND o.state IN ('RESERVED','ATTEMPTED','SENT','UNKNOWN')
		ORDER BY e.rowid IS NULL, e.rowid DESC, o.command_id`,
		valve.eui, id)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var expires, reservation, evidence, expectation, raw, open, close sql.NullString
		if err := rows.Scan(&expires, &reservation, &evidence, &expectation, &raw, &open, &close); err != nil {
			return false, err
		}
		if !expectation.Valid {
			return true, nil
		}
		transport, err := valveStoredJSON(raw.String)
		if err != nil {
			return false, valveSafetyJSONError("transport_state_malformed")
		}
		opened, closed := valveInstant(open.String), valveInstant(close.String)
		if snapshot := transport.Get("effect_snapshot"); snapshot.Truthy() {
			if valveEffectHolds(snapshot, transport, valve, opened, closed, open.Valid, close.Valid) {
				return true, nil
			}
			continue
		}
		if expires.String == "" || reservation.String == "" {
			return true, nil
		}
		decision, err := valveStoredJSON(evidence.String)
		if err != nil {
			return false, valveSafetyJSONError("decision_evidence_malformed")
		}
		gap := decision.Get("minimum_gap_minutes")
		end, exclusion := valveInstant(reservation.String), valveInstant(decision.Get("exclusion_end_at").MustString())
		if !valveWhole(gap, 0, 1440) || end.IsZero() || exclusion.IsZero() ||
			!exclusion.Equal(end.Add(time.Duration(gap.Num)*time.Minute)) {
			return true, nil
		}
		if open.Valid || close.Valid {
			if opened.IsZero() || closed.IsZero() || closed.Before(opened) {
				return true, nil
			}
			exclusion = closed.Add(time.Duration(gap.Num) * time.Minute)
		}
		if now.Before(exclusion) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// valveCodedError is dispatch.js errorWithCode(code, message): the encoder's
// catch answers error.code as the transport phase and keeps error.message as
// the detail.
type valveCodedError struct{ code, message string }

func (e valveCodedError) Error() string { return e.message }

// valveSafetyJSONError is parsePersistedJson's refusal of stored JSON that is
// not an object.
func valveSafetyJSONError(code string) error {
	return valveCodedError{code, "persisted safety JSON is malformed"}
}

func valveInstant(s string) time.Time {
	at, _ := jsdate.Parse(s, dailyScheduleLocation())
	return at
}

// The current qualification provider is unavailable on the gateway. A stored
// horizon therefore cannot release an effect on its own.
func valveEffectHolds(snapshot, transport jsvalue.Value, valve valveDevice, open, close time.Time, hasOpen, hasClose bool) bool {
	class := snapshot.Get("effect_class").MustString()
	if !validReleasableValveEffect(snapshot, class) {
		return true
	}
	if class == "NON_ACTUATING" {
		return false
	}
	attempt := transport.Get("attempted_at").OrEmpty().MustString()
	if attempt == "" {
		attempt = transport.Get("intent_at").OrEmpty().MustString()
	}
	if attempt == "" {
		attempt = snapshot.Get("anchor_at").MustString()
	}
	at := valveInstant(attempt)
	validClose := !close.IsZero() && (!hasOpen || !open.IsZero() && !close.Before(open))
	if jsvalue.Upper(valve.state.String) == "OPEN" || hasOpen && !validClose {
		return true
	}
	if class == "CLOSE_ONLY" {
		updated := valveInstant(valve.updated.String)
		freshClosed := jsvalue.Upper(valve.state.String) == "CLOSED" && !updated.IsZero() && !updated.Before(at)
		return at.IsZero() || !(freshClosed || validClose && !hasOpen) || hasClose && (close.IsZero() || close.Before(at))
	}
	return !(hasOpen && validClose && !at.IsZero() && !open.Before(at))
}

func valveWhole(v jsvalue.Value, low, high float64) bool {
	return v.Kind == jsvalue.Number && math.Trunc(v.Num) == v.Num && v.Num >= low && v.Num <= high
}

func validReleasableValveEffect(s jsvalue.Value, class string) bool {
	if s.Get("version").Num != 1 || s.Get("snapshot_version").Num != 1 ||
		s.Get("confirmed").Kind != jsvalue.Boolean || s.Get("confirmed").Bool ||
		s.Get("encrypted").Kind != jsvalue.Boolean || s.Get("encrypted").Bool ||
		s.Get("provenance").Kind != jsvalue.Object ||
		s.Get("provenance").Get("source").Kind != jsvalue.String ||
		s.Get("provenance").Get("source").MustString() != "local_encoder" {
		return false
	}
	port := s.Get("fPort")
	data, frameHex := s.Get("data"), s.Get("bytes_hex")
	frame, err := base64.StdEncoding.DecodeString(data.MustString())
	if data.Kind != jsvalue.String || frameHex.Kind != jsvalue.String ||
		err != nil || len(frame) == 0 || base64.StdEncoding.EncodeToString(frame) != data.MustString() ||
		jsvalue.Upper(hex.EncodeToString(frame)) != frameHex.MustString() ||
		!valveWhole(port, 1, 255) {
		return false
	}
	seconds := s.Get("encoded_duration_seconds")
	duration := 0.0
	switch class {
	case "SELF_CLOSING_OPEN":
		if port.Num != 2 || len(frame) != 2 || frame[1] == 0 {
			return false
		}
		factor := map[byte]int{0x21: 1, 0x41: 60, 0x81: 3600}[frame[0]]
		duration = float64(factor * int(frame[1]))
		if factor == 0 || seconds.Kind != jsvalue.Number || seconds.Num != duration {
			return false
		}
	case "CLOSE_ONLY":
		if port.Num != 1 || len(frame) != 1 || frame[0] != 0x30 || seconds.OrEmpty().MustNumber() != 0 {
			return false
		}
	case "NON_ACTUATING":
		if seconds.Kind != jsvalue.Null || !nonActuatingValveFrame(port.Num, frame) {
			return false
		}
	default:
		return false
	}
	q, qctx := s.Get("qualification"), s.Get("qualification_context")
	device := s.Get("device_eui")
	if q.Kind != jsvalue.Object || qctx.Kind != jsvalue.Object || device.Kind != jsvalue.String ||
		!hex16.MatchString(device.MustString()) || qctx.Get("device_eui").Kind != jsvalue.String ||
		qctx.Get("device_eui").MustString() != device.MustString() || qctx.Get("identity").Kind != q.Get("identity").Kind ||
		qctx.Get("identity").MustString() != q.Get("identity").MustString() {
		return false
	}
	if s.Get("timing_contract").MustString() == "UNBOUNDED_SAFE_CLOSE_V1" {
		return class == "CLOSE_ONLY" && seconds.Kind == jsvalue.Number && !s.Get("finite_release").Bool &&
			s.Get("anchor_at").Kind == jsvalue.Null && s.Get("reservation_receipt").Get("boot_id").Truthy()
	}
	interval, allowance, gap := s.Get("interval_minutes"), s.Get("allowance_minutes"), s.Get("minimum_gap_minutes")
	source := s.Get("interval_source")
	if !valveWhole(interval, 1, 60) || allowance.Num != 11+2*interval.Num || source.Kind != jsvalue.String ||
		(source.MustString() != "policy" && source.MustString() != "documented_default") || !valveWhole(gap, 0, float64(math.MaxInt32)) ||
		class == "CLOSE_ONLY" && gap.Num != 0 {
		return false
	}
	times := make(map[string]time.Time, 6)
	for _, field := range []string{"anchor_at", "latest_physical_start_at", "calculated_queue_expires_at",
		"queue_expires_at", "future_effect_end", "exclusion_end_at"} {
		value := s.Get(field)
		at := valveEffectInstant(value)
		if at.IsZero() || (field == "calculated_queue_expires_at" &&
			(value.Kind != jsvalue.String || valveISO(at) != value.MustString())) {
			return false
		}
		times[field] = at
	}
	margin := 0.0
	p := jsvalue.Property
	var normalized jsvalue.Value
	identity, value := q.Get("identity"), q.Get("margin_seconds")
	if q.Get("qualified").Bool && identity.Kind == jsvalue.String && jsvalue.Trim(identity.MustString()) != "" &&
		valveWhole(value, 0, float64(math.MaxInt32)) {
		margin = value.Num
		normalized = jsvalue.Obj(p("qualified", jsvalue.Bool(true)), p("identity", identity.TrimmedString()), p("margin_seconds", value))
	} else {
		normalized = jsvalue.Obj(p("qualified", jsvalue.Bool(false)), p("identity", jsvalue.Nil()),
			p("margin_seconds", jsvalue.Nil()), p("reason", zoneFallback(q.Get("reason"), jsvalue.Str("qualification_unavailable"))))
	}
	if valveJSON(normalized) != valveJSON(q) {
		return false
	}
	latest := times["anchor_at"].Add(time.Duration(allowance.Num) * time.Minute)
	end := latest.Add(time.Duration(duration) * time.Second)
	calculated := latest.Add(-time.Duration(margin) * time.Second)
	queue := calculated
	if expiry := s.Get("explicit_expiry_at"); expiry.Kind != jsvalue.Null {
		explicit := valveEffectInstant(expiry)
		if expiry.Kind != jsvalue.String || explicit.IsZero() || valveISO(explicit) != expiry.MustString() {
			return false
		}
		if explicit.Before(queue) {
			queue = explicit
		}
	}
	return times["latest_physical_start_at"].Equal(latest) && times["calculated_queue_expires_at"].Equal(calculated) &&
		times["queue_expires_at"].Equal(queue) &&
		times["future_effect_end"].Equal(end) && times["exclusion_end_at"].Equal(end.Add(time.Duration(gap.Num)*time.Minute)) &&
		valveEffectValuesEqual(s.Get("reservation_end_at"), s.Get("future_effect_end")) &&
		valveEffectValuesEqual(s.Get("expires_at"), s.Get("queue_expires_at"))
}

var effectCalendar = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)
var effectSQLite = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$`)

func valveEffectInstant(value jsvalue.Value) time.Time {
	if value.Kind == jsvalue.Number {
		at, _ := jsdate.FromMilliseconds(value.Num)
		return at
	}
	if value.Kind != jsvalue.String {
		return time.Time{}
	}
	stamp := jsvalue.Trim(value.MustString())
	calendar := effectCalendar.FindString(stamp)
	if calendar == "" || calendar[:4] < "0100" {
		return time.Time{}
	}
	day, ok := jsdate.Parse(calendar, time.UTC)
	if !ok || jsdate.ISOString(day)[:10] != calendar {
		return time.Time{}
	}
	if effectSQLite.MatchString(stamp) {
		clock := calendar + "T" + stamp[11:19] + "Z"
		at, ok := jsdate.Parse(clock, time.UTC)
		if !ok || jsdate.ISOString(at)[:19] != clock[:19] {
			return time.Time{}
		}
		return at
	}
	if len(stamp) <= 10 || stamp[10] != 'T' {
		return time.Time{}
	}
	return valveInstant(stamp)
}

func valveEffectValuesEqual(a, b jsvalue.Value) bool {
	return a.Kind == b.Kind && (a.Kind == jsvalue.String || a.Kind == jsvalue.Number) && a.MustString() == b.MustString()
}

func nonActuatingValveFrame(port float64, frame []byte) bool {
	switch port {
	case 9:
		return len(frame) == 1 && frame[0] <= 3
	case 10:
		return len(frame) == 1
	case 11:
		return len(frame) == 2 && (frame[0] == 0 || frame[0] == 0x80) && frame[1] > 0 ||
			len(frame) == 4 && frame[0] <= 1 && frame[1] > 0 && frame[2] == 0 && frame[3] > 0
	case 12:
		if len(frame) != 14 {
			return false
		}
		for _, digit := range frame {
			if digit > 9 {
				return false
			}
		}
		return true
	case 13:
		return len(frame) == 1 && frame[0] == 1
	case 21, 22:
		return len(frame) == 1 && (frame[0] == 0x30 || frame[0] == 0x31)
	}
	return false
}
