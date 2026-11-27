package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

func init() {
	registerWithCatch("GET", "/api/valves/:deveui/schedules", (*backend).valveSchedules, valveAPICoercionCatch)
	registerWithCatch("POST", "/api/valves/:deveui/schedules", (*backend).valveSchedules, valveAPICoercionCatch)
	registerWithCatch("POST", "/api/valves/:deveui/plan/resend", (*backend).valveSchedules, valveAPICoercionCatch)
}

var valveSchedulesPath = regexp.MustCompile(`^/api/valves/([0-9a-fA-F]{16})/(schedules|plan/resend)$`)

type scheduleError struct {
	status  int
	code    string
	message string
	details jsvalue.Value
}

func (e *scheduleError) Error() string { return e.message }

func scheduleRefusal(status int, code, text string) *scheduleError {
	return &scheduleError{status: status, code: code, message: text}
}

func replyScheduleError(w http.ResponseWriter, err error) {
	var refusal *scheduleError
	if !errors.As(err, &refusal) {
		log.Printf("valve schedules: %v", err)
		refusal = scheduleRefusal(500, "internal_error", "Valve request failed")
	}
	p := jsvalue.Property
	fields := []jsvalue.Field{p("error", jsvalue.Str(refusal.code))}
	if refusal.message != "" {
		fields = append(fields, p("message", jsvalue.Str(refusal.message)))
	}
	respond(w, refusal.status, append(fields, p("details", refusal.details))...)
}

type scheduleQueryer interface {
	QueryContext(context.Context, string, ...any) (*farmRows, error)
	QueryRowContext(context.Context, string, ...any) *farmRow
}

func scheduleAuthSecret() (string, error) {
	if secret := configuredAuthSecret(); secret != "" {
		return secret, nil
	}
	if _, secret := existingAuthSecret(authSecretPaths()); secret != "" {
		return secret, nil
	}
	return "", scheduleRefusal(503, "auth_unavailable", "Valve authentication is unavailable")
}

func valveAPISession(w http.ResponseWriter, r *http.Request, now time.Time) (auth.Session, bool) {
	secret, err := scheduleAuthSecret()
	if err != nil {
		replyScheduleError(w, err)
		return auth.Session{}, false
	}
	header := r.Header.Get("Authorization")
	session, failure := auth.VerifyBearer(header, now.UnixMilli(), func() (string, error) { return secret, nil })
	if failure != nil || session.Expiration <= 0 || math.IsNaN(session.Expiration) || math.IsInf(session.Expiration, 0) ||
		session.UserID <= 0 || math.Trunc(session.UserID) != session.UserID || len(session.Username.Text) > 120 {
		replyScheduleError(w, scheduleRefusal(401, "unauthorized", "Unauthorized"))
		return auth.Session{}, false
	}
	return session, true
}

func (b *backend) valveSchedules(w http.ResponseWriter, r *http.Request, _ params, body httpbody.Body) {
	now := time.Now()
	session, ok := valveAPISession(w, r, now)
	if !ok {
		return
	}
	path := valveSchedulesPath.FindStringSubmatch(r.URL.EscapedPath())
	if path == nil || r.Method == http.MethodHead {
		replyScheduleError(w, scheduleRefusal(404, "not_found", "Unknown valve-control route"))
		return
	}
	ctx := context.WithoutCancel(r.Context())
	eui := jsvalue.Upper(path[1])
	scoped := scopedAccess()
	tz, err := authorizeValveSchedule(ctx, b.db, eui, session, scoped)
	if err != nil {
		replyScheduleError(w, err)
		return
	}
	if path[2] == "plan/resend" {
		b.resendValvePlan(w, ctx, eui, session, scoped, now)
		return
	}

	if r.Method == http.MethodGet {
		result, err := b.readValveSchedule(ctx, eui, now)
		if err != nil {
			replyScheduleError(w, err)
		} else {
			respond(w, 200, result.Fields...)
		}
		return
	}
	if r.ContentLength > 256*1024 {
		replyScheduleError(w, scheduleRefusal(413, "body_too_large", "Request body exceeds 256 KiB"))
		return
	}
	row, err := parseValveSchedule(body.Value)
	if err != nil {
		replyScheduleError(w, err)
		return
	}
	// api.js: tzFallback = gateway_timezone setting || 'UTC' and the new row's
	// timezone = device.zone_timezone || tzFallback, both as read: a BLOB is a
	// truthy Buffer even when empty, answered as Buffer JSON and bound back as
	// a BLOB.
	fallback := timezoneChain(storedGatewaySetting(ctx, b.db, "gateway_timezone"))
	p := jsvalue.Property
	row = jsvalue.Obj(append([]jsvalue.Field{
		p("schedule_uuid", jsvalue.Str(uuid.NewString())), p("device_eui", jsvalue.Str(eui)),
		p("timezone", timezoneChain(tz, fallback).json()),
	}, row.Fields...)...)
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()
	result, err := b.createValveSchedule(ctx, eui, fallback, session, scoped, row, now)
	if err != nil {
		replyScheduleError(w, err)
		return
	}
	respond(w, 201, result.Fields...)
}

func (b *backend) resendValvePlan(w http.ResponseWriter, ctx context.Context, eui string, session auth.Session, scoped bool, now time.Time) {
	fallback := timezoneChain(storedGatewaySetting(ctx, b.db, "gateway_timezone")).jsString()
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()
	if _, err := authorizeValveSchedule(ctx, b.db, eui, session, scoped); err != nil {
		replyScheduleError(w, err)
		return
	}
	count, waitsFor, err := b.queueValvePlanResend(ctx, eui, fallback, now)
	if err != nil {
		replyScheduleError(w, err)
		return
	}
	p := jsvalue.Property
	respond(w, 202, p("ok", jsvalue.Bool(true)), p("pushes_queued", jsvalue.Num(float64(count))),
		p("conversion_waits_for", waitsFor))
}

// authorizeValveSchedule is api.js authorizedValve; it returns the device's
// zone_timezone with its storage class.
func authorizeValveSchedule(ctx context.Context, db scheduleQueryer, eui string, session auth.Session, scoped bool) (storedValue, error) {
	if scoped {
		// freshValveScope (osi-valve-control api.js): the actor's uuid keeps its
		// storage class, then assertFreshDeviceAccess and canMutate.
		var user, role storedValue
		err := db.QueryRowContext(ctx, "SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1",
			session.UserID, session.Username.MustString()).Scan(&user, &role)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !user.truthy()) {
			return storedValue{}, scheduleRefusal(401, "unauthorized", "Unauthorized")
		}
		if err != nil {
			return storedValue{}, err
		}
		actorScope, problem := assertFreshDeviceAccess(ctx, db, user, eui)
		if problem != nil {
			if problem.status == 500 {
				return storedValue{}, errors.New(problem.message)
			}
			return storedValue{}, scheduleRefusal(problem.status, "error", problem.message)
		}
		if !scopeCanMutate(actorScope.role) {
			return storedValue{}, scheduleRefusal(403, "forbidden", "insufficient role")
		}
	}
	var kind string
	var owner storedValue
	var tz storedValue
	err := db.QueryRowContext(ctx, `SELECT d.type_id,d.user_id,z.timezone FROM devices d
		LEFT JOIN irrigation_zones z ON z.id=d.irrigation_zone_id
		WHERE UPPER(d.deveui)=? AND d.deleted_at IS NULL`, eui).Scan(&kind, &owner, &tz)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return storedValue{}, scheduleRefusal(404, "not_found", "Valve not found")
	case err != nil:
		return storedValue{}, err
	case kind != valveType:
		return storedValue{}, scheduleRefusal(409, "not_a_valve", "Device is not a STREGA valve")
	case ownedByOther(owner, session.UserID):
		// api.js: row.user_id != null && Number(row.user_id) !== Number(userId).
		return storedValue{}, scheduleRefusal(403, "forbidden", "Valve is claimed by another user")
	}
	return tz, nil
}

func scheduleGatewaySetting(ctx context.Context, db scheduleQueryer, key string) string {
	var value sql.NullString
	err := db.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key=?", key).Scan(&value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) && !strings.Contains(err.Error(), "no such table: app_settings") {
		log.Printf("valve schedules setting %s: %v", key, err)
	}
	return value.String
}

var valveFireAt = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T`)

func scheduleFireAt(raw string, loc *time.Location) (time.Time, bool) {
	if !valveFireAt.MatchString(raw) {
		return time.Time{}, false
	}
	return jsdate.Parse(raw, loc)
}

func parseValveSchedule(body jsvalue.Value) (jsvalue.Value, error) {
	invalid := func(code, message string) (jsvalue.Value, error) {
		return jsvalue.Value{}, scheduleRefusal(422, code, message)
	}
	rawKind, rawDuration := body.Get("kind"), body.Get("duration_minutes")

	kind := jsvalue.Upper(rawKind.OrEmpty().MustString())
	duration := jsvalue.Num(rawDuration.MustNumber())
	label := body.Get("label")
	switch label.Kind {
	case jsvalue.String:
		label.Text = label.Text[:min(len(label.Text), 80)]
	case jsvalue.Null, jsvalue.Undefined:
		label = jsvalue.Nil()
	default:
		return invalid("invalid_label", "label must be a string")
	}
	mask, start, fire := jsvalue.Nil(), jsvalue.Nil(), jsvalue.Nil()
	switch kind {
	case "WEEKLY":
		rawMask := body.Get("weekdays_mask")
		mask, start = jsvalue.Num(rawMask.MustNumber()), body.Get("start_time")
		if !valveWhole(mask, 1, 127) {
			return invalid("invalid_weekdays", "weekdays_mask must be 1..127")
		}
		if start.Kind != jsvalue.String {
			return invalid("invalid_start_time", "start_time must be a string HH:MM")
		}
		if _, ok := planStart(start.MustString()); !ok {
			return invalid("invalid_start_time", "start_time must be HH:MM")
		}
		if !valveWhole(duration, 1, 1439) {
			return invalid("invalid_duration", "duration_minutes must be 1..1439")
		}
	case "ONCE":
		input := body.Get("fire_at")
		at, valid := scheduleFireAt(input.MustString(), dailyScheduleLocation())
		if input.Kind != jsvalue.String || !valid {
			return invalid("invalid_fire_at", "fire_at must be an ISO instant")
		}
		if !valveWhole(duration, 1, 255) {
			return invalid("invalid_duration", "duration_minutes must be 1..255 for one-time opens")
		}
		fire = jsvalue.Str(valveISO(at))
	default:
		return invalid("invalid_kind", "kind must be WEEKLY or ONCE")
	}
	enabled := 1.0
	if v := body.Get("enabled"); v.Kind != jsvalue.Undefined && !v.Truthy() {
		enabled = 0
	}
	p := jsvalue.Property
	return jsvalue.Obj(p("kind", jsvalue.Str(kind)), p("weekdays_mask", mask), p("start_time", start),
		p("fire_at", fire), p("duration_minutes", duration), p("label", label),
		p("enabled", jsvalue.Num(enabled))), nil
}

const valveScheduleRowsSQL = `SELECT vs.*, i.state AS dispatch_state, i.command_id AS dispatch_command_id,
	i.created_at AS dispatch_created_at, i.attempted_at AS dispatch_attempted_at,
	vae.expectation_id, vae.transport_json AS dispatch_transport_json
	FROM valve_schedules vs LEFT JOIN valve_once_dispatch_intents i ON i.schedule_uuid=vs.schedule_uuid
	LEFT JOIN valve_actuation_expectations vae ON vae.command_id=i.command_id
	WHERE UPPER(vs.device_eui)=? AND vs.deleted_at IS NULL ORDER BY vs.kind, vs.start_time, vs.fire_at`

func (b *backend) readValveSchedule(ctx context.Context, eui string, now time.Time) (jsvalue.Value, error) {
	schedules, err := queryZones(ctx, b.db, valveScheduleRowsSQL, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	p := jsvalue.Property
	for i := range schedules {
		row := &schedules[i]
		state, _ := valveStoredJSON(row.Get("dispatch_transport_json").OrEmpty().MustString())
		phase := state.Get("phase").OrEmpty().MustString()
		evidence := phase == "ATTEMPTED" || phase == "UNKNOWN" || state.Get("attempt_receipt").Truthy() ||
			(state.Get("attempted_at").Truthy() && phase != "" && phase != "INTENT" && phase != "SNAPSHOT")
		deadline, proof, outcome := jsvalue.Nil(), jsvalue.Nil(), jsvalue.Nil()
		if candidate := state.Get("proof"); slices.Contains([]string{"receipt", "queue", "observed_open"}, candidate.MustString()) {
			proof = candidate
		}
		onceState, dispatchState := row.Get("once_state").MustString(), row.Get("dispatch_state").MustString()
		if onceState == "SKIPPED" && dispatchState == "SKIPPED" {
			outcome = state.Get("once_settlement")
			if outcome.MustString() != "missed" && outcome.MustString() != "uncertain" {
				outcome = jsvalue.Str("missed")
				if evidence {
					outcome = jsvalue.Str("uncertain")
				}
			}
		}
		attempted := zoneFallback(row.Get("dispatch_attempted_at"), zoneFallback(state.Get("attempted_at"), jsvalue.Nil()))
		row.Set(p("dispatch_attempted_at", attempted))
		if row.Get("kind").MustString() == "ONCE" && onceState == "PENDING" && evidence &&
			(dispatchState == "ATTEMPTED" || dispatchState == "UNKNOWN") {
			once := valveOnceIntent{valve: valveDevice{eui: eui}, fireAt: row.Get("fire_at").MustString(),
				expectation: sql.NullString{String: row.Get("expectation_id").OrEmpty().MustString(), Valid: row.Get("expectation_id").Truthy()},
				attempted:   sql.NullString{String: attempted.OrEmpty().MustString(), Valid: attempted.Truthy()}}
			confirmation, err := b.valveOnceConfirmation(ctx, once, &state, now)
			if err != nil {
				return jsvalue.Value{}, err
			}
			if !confirmation.at.Before(now.Truncate(time.Millisecond)) {
				deadline = jsvalue.Str(confirmation.text)
			}
		}
		row.Fields = slices.DeleteFunc(row.Fields, func(f jsvalue.Field) bool {
			key := (jsvalue.Value{Kind: jsvalue.String, Text: f.Key}).MustString()
			return key == "dispatch_transport_json" || key == "expectation_id"
		})
		row.Set(p("awaiting_confirmation_until", deadline))
		row.Set(p("once_proof", proof))
		row.Set(p("once_outcome", outcome))
	}
	settings, err := planSettings(ctx, b.db, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	pushes, err := planWeekdayStates(ctx, b.db, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	plan := compileValvePlan(schedules)
	return jsvalue.Obj(p("schedules", jsvalue.Arr(schedules...)), p("compiled", plan.wire()),
		p("push_state", jsvalue.Arr(pushes...)), p("settings", settings)), nil
}

func planSettings(ctx context.Context, db scheduleQueryer, eui string) (jsvalue.Value, error) {
	rows, err := queryZones(ctx, db, "SELECT * FROM valve_settings WHERE device_eui=?", eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	p := jsvalue.Property
	result := jsvalue.Obj(p("strega_generation", jsvalue.Str("GEN1")), p("flow_rate_lpm", jsvalue.Nil()),
		p("flow_rate_source", jsvalue.Nil()), p("default_open_minutes", jsvalue.Nil()),
		p("scheduler_status", jsvalue.Str("ACTIVE")), p("skip_today_date", jsvalue.Nil()),
		p("last_clock_sync_queued_at", jsvalue.Nil()), p("last_clock_sync_acked_at", jsvalue.Nil()))
	if len(rows) != 0 {
		for _, field := range rows[0].Fields {
			result.Set(field)
		}
	}
	result.Set(p("device_eui", jsvalue.Str(eui)))
	return result, nil
}

func planWeekdayStates(ctx context.Context, db scheduleQueryer, eui string) ([]jsvalue.Value, error) {
	rows, err := queryZones(ctx, db, `SELECT purpose, weekday, payload_hex, state, queued_at, acked_at, error
		FROM valve_schedule_pushes WHERE UPPER(device_eui)=? AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN')
		AND state IN ('QUEUED','ACKED','FAILED') ORDER BY rowid DESC`, eui)
	for i := range rows {
		if valvePushLost(rows[i].Get("state").MustString(), rows[i].Get("error").MustString()) {
			rows[i].Set(jsvalue.Property("state", jsvalue.Str("LOST")))
		}
	}
	return rows, err
}
