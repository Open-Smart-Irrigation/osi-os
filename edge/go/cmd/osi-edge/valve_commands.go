package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

const (
	valveOpen       = "OPEN_FOR_DURATION"
	valveClose      = "CLOSE"
	valveTimedClose = "CLOSE_FOR_DURATION"
	valveType       = "STREGA_VALVE"
)

var valveWriter sync.Mutex

func init() {
	register("POST", "/api/valve/:deveui", (*backend).commandValve)
}

type valveDevice struct {
	eui, kind      string
	user, zone     sql.NullInt64
	state, updated sql.NullString
	// owner is devices.user_id as node-sqlite3 hands it over (findValve only),
	// so the ownership checks can apply Number() as the JS does.
	owner storedValue
}

// ownedByOther is the JS ownership refusal `owner != null && Number(owner)
// !== userId`: TEXT "0xA0", " 160" and "160.0" are owner 160, an empty TEXT or
// Buffer is 0, and a value whose Number() is NaN ("abc") never matches.
func ownedByOther(owner storedValue, userID float64) bool {
	return owner.notNull() && owner.number() != userID
}

func (b *backend) findValve(ctx context.Context, eui string, cancel bool) (valveDevice, error) {
	var valve valveDevice
	where := "deveui = ?"
	if cancel {
		where = "UPPER(deveui) = ? AND deleted_at IS NULL"
	}
	err := b.db.QueryRowContext(ctx, `SELECT deveui, type_id, user_id, irrigation_zone_id,
		current_state, updated_at FROM devices WHERE `+where, eui).
		Scan(&valve.eui, &valve.kind, &valve.owner, &valve.zone, &valve.state, &valve.updated)
	return valve, err
}

func (b *backend) valveUser(w http.ResponseWriter, r *http.Request, cancel bool) (auth.Session, bool) {
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		if failure.Coercion && !cancel {
			deviceAPICoercionFailure(w)
			return session, false
		}
		label := "Unauthorized"
		if failure.Status == 500 {
			label = "device-api failed"
		}
		fields := []jsvalue.Field{
			jsvalue.Property("error", jsvalue.Str(label)),
			jsvalue.Property("message", jsvalue.Str(failure.Message)),
		}
		if cancel {
			sendJSON(w, failure.Status, jsvalue.Obj(jsvalue.Property("message", jsvalue.Str(failure.Message))))
		} else {
			respond(w, failure.Status, fields...)
		}
		return session, false
	}
	return session, true
}

func (b *backend) commandValve(w http.ResponseWriter, r *http.Request, p params, request httpbody.Body) {
	session, ok := b.valveUser(w, r, false)
	if !ok {
		return
	}
	eui := jsvalue.Upper(jsvalue.Trim(p["deveui"]))
	if eui == "" {
		message(w, 400, "Missing valve deveui")
		return
	}
	ctx := r.Context()
	scoped := scopedAccess()
	if scoped {
		// manual-ingress: 404 says "device not found", 403 says "Forbidden".
		if problem := b.valveScope(ctx, session, eui); problem != nil {
			detail := problem.message
			switch problem.status {
			case 404:
				detail = "device not found"
			case 403:
				detail = "Forbidden"
			}
			message(w, problem.status, detail)
			return
		}
	}

	body := request.Value
	action, minutes, refusal := valveAction(body, r.URL.RawQuery)

	if refusal != "" {
		message(w, 400, refusal)
		return
	}
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()
	var actor storedValue
	// manual-ingress.js spells auth.userId into this lookup, in both modes
	// (after the scoped router's bound lookup).
	err := b.db.QueryRowContext(ctx, "SELECT user_uuid FROM users WHERE id=? AND username=?",
		legacyUserLookupID(session), session.Username.MustString()).Scan(&actor)
	if errors.Is(err, sql.ErrNoRows) {
		message(w, 401, "User not found")
		return
	}
	if err != nil {
		valveServerError(w, err)
		return
	}
	valve, err := b.findValve(ctx, eui, false)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		message(w, 404, "Valve not found in devices table")
	case err != nil:
		valveServerError(w, err)
	case valve.kind != valveType:
		message(w, 409, "Device "+eui+" is not a STREGA_VALVE")
	case ownedByOther(valve.owner, session.UserID):
		message(w, 403, "Valve is claimed by another user")
	default:
		// live-authorize: String(msg.actor_user_uuid || '').trim() || null. A
		// Buffer uuid becomes its decoded text here, and an empty one null.
		actorText := ""
		if scoped {
			actorText = jsvalue.Trim(actor.orString(""))
			if action == valveOpen {
				if problem := b.valveDispatchScopeProblem(ctx, valve.eui, actorText); problem != nil {
					b.refuseValveDispatch(ctx, w, valve.eui, problem)
					return
				}
			}
		}
		b.sendValveCommand(w, r, valve, action, minutes, actorText)
	}
}

// valveDispatchRefusal is a refusal from liveWriteExpectation's scope block.
type valveDispatchRefusal struct {
	status        int
	code, message string
}

// valveDispatchScopeProblem is the scoped timed-open check in
// osi-valve-control live-authorize liveWriteExpectation: no actor gives
// scope_actor_required; otherwise assertFreshDeviceAccess(actor) and canMutate
// run again with the actor as a string, and a refusal is scope_denied.
func (b *backend) valveDispatchScopeProblem(ctx context.Context, eui, actor string) *valveDispatchRefusal {
	if actor == "" {
		return &valveDispatchRefusal{403, "scope_actor_required", "STREGA command requires an authenticated actor"}
	}
	user, problem := b.assertFreshDeviceAccess(ctx, storedOf(actor), eui)
	if problem != nil {
		if problem.status == 500 {
			// A scope error without statusCode is rethrown to the outer catch:
			// { error: error.code || 'write_failed', message } with 503, where a
			// node-sqlite3 error's code is its SQLITE_* name.
			return &valveDispatchRefusal{503, jsErrorCode(problem.message), problem.message}
		}
		return &valveDispatchRefusal{problem.status, "scope_denied", problem.message}
	}
	if !scopeCanMutate(user.role) {
		return &valveDispatchRefusal{403, "scope_denied", "insufficient role"}
	}
	return nil
}

// refuseValveDispatch answers as localDispatchFailure does and queues the
// terminal REJECTED_PERMANENT ACK (osi-command-ledger queueCommandAck) for the
// new command id.
func (b *backend) refuseValveDispatch(ctx context.Context, w http.ResponseWriter, eui string, refusal *valveDispatchRefusal) {
	if refusal.code != "write_failed" {
		commandID := uuid.NewString()
		at := valveISO(time.Now())
		detail := jsvalue.Obj(
			jsvalue.Property("commandId", jsvalue.Str(commandID)),
			jsvalue.Property("eventUuid", jsvalue.Nil()),
			jsvalue.Property("aggregateType", jsvalue.Nil()),
			jsvalue.Property("aggregateKey", jsvalue.Nil()),
			jsvalue.Property("commandType", jsvalue.Str(valveOpen)),
			jsvalue.Property("status", jsvalue.Str("NACKED")),
			jsvalue.Property("result", jsvalue.Str("REJECTED_PERMANENT")),
			jsvalue.Property("appliedAt", jsvalue.Str(at)),
			jsvalue.Property("requestedSyncVersion", jsvalue.Nil()),
			jsvalue.Property("appliedSyncVersion", jsvalue.Nil()),
			jsvalue.Property("duplicate", jsvalue.Bool(false)),
			jsvalue.Property("reason", jsvalue.Str(refusal.code)),
			jsvalue.Property("detail", jsvalue.Str(refusal.code)),
		)
		_, err := b.db.ExecContext(ctx, `INSERT INTO applied_commands
			(command_id, device_eui, command_type, applied_at, result, result_detail, originator)
			VALUES (?, ?, ?, ?, 'REJECTED_PERMANENT', ?, 'edge')`, commandID, eui, valveOpen, at, valveJSON(detail))
		if err != nil {
			// queueCommandAck's throw escapes the scope catch and reaches the
			// outer catch, which replaces the refusal with a 503.
			log.Printf("STREGA scope refusal ack: %v", err)
			text := zoneDBMessage(err)
			respond(w, 503, jsvalue.Property("error", jsvalue.Str(jsErrorCode(text))), jsvalue.Property("message", jsvalue.Str(text)))
			return
		}
	}
	if refuseMissingActuators(w) {
		return
	}
	respond(w, refusal.status, jsvalue.Property("error", jsvalue.Str(refusal.code)), jsvalue.Property("message", jsvalue.Str(refusal.message)))
}

func valveAction(body jsvalue.Value, rawQuery string) (action string, minutes int, refusal string) {
	param := func(keys ...string) jsvalue.Value {
		for _, key := range keys {
			value := body.Get(key)
			if value.Kind != jsvalue.Null && value.Kind != jsvalue.Undefined {
				return value
			}
		}
		parsed := httpbody.ParseQuery(rawQuery)
		for _, key := range keys {
			if value := parsed.Get(key); value.Kind != jsvalue.Null && value.Kind != jsvalue.Undefined {
				return value
			}
		}
		return jsvalue.Value{}
	}
	present := func(v jsvalue.Value) bool {
		return v.Kind != jsvalue.Undefined && jsvalue.Trim(v.MustString()) != ""
	}
	rawAction := param("action")

	if present(rawAction) {
		action = jsvalue.Upper(jsvalue.Trim(rawAction.MustString()))
	}
	rawMinutes := param("duration_minutes", "durationMinutes", "duration")
	rawSeconds := param("duration_seconds", "durationSeconds")
	switch action {
	case "":
		return "", 0, "Missing action (CLOSE or OPEN_FOR_DURATION)"
	case "OPEN", "OPENVALVE", "OPEN_VALVE":
		if !present(rawSeconds) && !present(rawMinutes) {
			return "", 0, "Indefinite OPEN is not permitted; provide duration_seconds or use OPEN_FOR_DURATION"
		}
		action = valveOpen
	case valveOpen, "OPENFOR", "OPEN_FOR":
		action = valveOpen
	case valveClose, "CLOSEVALVE", "CLOSE_VALVE":
		return valveClose, 0, ""
	case valveTimedClose, "CLOSEFOR", "CLOSE_FOR":
		action = valveTimedClose
	default:
		return "", 0, "Invalid action: " + action
	}

	var duration float64
	if present(rawSeconds) {
		seconds := rawSeconds.MustNumber()
		if seconds <= 0 || math.Mod(seconds, 60) != 0 {
			return "", 0, "duration_seconds must be a positive whole-minute duration"
		}
		duration = seconds / 60
	} else {
		duration = rawMinutes.MustNumber()
		if duration <= 0 || math.IsInf(duration, 0) || math.Trunc(duration) != duration {
			return "", 0, "duration_minutes must be a positive integer"
		}
	}
	if duration > 255 {
		return "", 0, "duration_minutes must be between 1 and 255"
	}
	return action, int(duration), ""
}

func (b *backend) sendValveCommand(w http.ResponseWriter, r *http.Request, valve valveDevice, action string, minutes int, actor string) {
	// Once a radio attempt is in flight, retain its outcome even if the HTTP client goes away.
	ctx := context.WithoutCancel(r.Context())
	options := valveDispatchOptions{actor: actor}
	if action == valveOpen {
		// write-strega-expectation reads the calibration before the encoder
		// checks the actuators app, the key and the hold. Its catch answers
		// 503 { error: error.code || 'write_failed', message }, and an HTTP
		// request gets no command_ack.
		flow, err := b.valveFlowRate(ctx, valve)
		var preEncoder valvePreEncoderError
		if errors.As(err, &preEncoder) {
			log.Printf("STREGA calibration read for %s: %v", valve.eui, err)
			// write-strega-expectation's catch sets the 503, but the message
			// still reaches the encoder, whose first check (no actuators
			// app) rewrites the reply as transport_unavailable.
			if refuseMissingActuators(w) {
				return
			}
			text := zoneDBMessage(preEncoder.err)
			respond(w, 503, jsvalue.Property("error", jsvalue.Str(jsErrorCode(text))), jsvalue.Property("message", jsvalue.Str(text)))
			return
		}
		options.flow = flow
	}
	if refuseMissingActuators(w) {
		return
	}
	requestedAt := time.Now()
	commandID := uuid.NewString()
	phase, queueID, err := b.dispatchValve(ctx, valve, commandID, action, minutes, options)
	if err != nil {
		log.Printf("STREGA command %s: %v", commandID, err)
	}
	var detail string
	if phase == "write_failed" {
		phase, detail = valveEncoderFault(err)
		if actor != "" && action == valveOpen {
			b.settleScopedValveFault(ctx, commandID, phase, detail)
		}
	} else {
		detail = manualValveFailureDetail(phase, err)
	}
	var audit valveAuditError
	b.publishManualValveOutcome(ctx, valve, commandID, action, phase, detail, !errors.As(err, &audit))
	if phase != "ACCEPTED" {
		status, detail := 503, "STREGA transport did not accept the command"
		switch phase {
		case "valve_busy":
			status, detail = 409, "A conditional irrigation run on this valve is not resolved yet"
		case "enqueue_rejected":
			status = 422
		}
		respond(w, status, jsvalue.Property("error", jsvalue.Str(phase)), jsvalue.Property("message", jsvalue.Str(detail)))
		return
	}
	result := []jsvalue.Field{
		jsvalue.Property("status", jsvalue.Str("queued")),
		jsvalue.Property("deveui", jsvalue.Str(valve.eui)),
		jsvalue.Property("action", jsvalue.Str(action)),
		jsvalue.Property("duration_minutes", valveMinutes(minutes)),
		jsvalue.Property("timestamp", jsvalue.Str(valveISO(requestedAt))),
		jsvalue.Property("command_id", jsvalue.Str(commandID)),
		jsvalue.Property("zone_id", valveInt(valve.zone)),
		jsvalue.Property("transportPhase", jsvalue.Str(phase)),
		jsvalue.Property("queue_id", jsvalue.Str(queueID)),
	}
	if action == valveOpen && jsvalue.Upper(valve.state.String) == "OPEN" {
		result = append(result,
			jsvalue.Property("warning", jsvalue.Str("valve_last_reported_open")),
			jsvalue.Property("valve_last_report", jsvalue.Obj(
				jsvalue.Property("state", jsvalue.Str("OPEN")),
				jsvalue.Property("since", valveText(valve.updated)),
			)),
		)
	}
	respond(w, 202, result...)
}

func valveServerError(w http.ResponseWriter, err error) {
	log.Printf("valve API: %v", err)
	message(w, 500, "Valve request failed")
}

func valveISO(t time.Time) string { return jsdate.ISOString(t) }

func valveMinutes(minutes int) jsvalue.Value {
	if minutes == 0 {
		return jsvalue.Nil()
	}
	return jsvalue.Num(float64(minutes))
}

func valveInt(n sql.NullInt64) jsvalue.Value {
	if !n.Valid {
		return jsvalue.Nil()
	}
	return jsvalue.Num(float64(n.Int64))
}

func valveFloat(n sql.NullFloat64) jsvalue.Value {
	if !n.Valid {
		return jsvalue.Nil()
	}
	return jsvalue.Num(n.Float64)
}

func valveText(s sql.NullString) jsvalue.Value {
	if s.String == "" {
		return jsvalue.Nil()
	}
	return nullableText(s)
}

func valveJSON(value jsvalue.Value) string {
	data, err := jsvalue.Stringify(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func valveStoredJSON(s string) (jsvalue.Value, error) {
	if s == "" {
		return jsvalue.Obj(), nil
	}
	value, err := jsvalue.Parse([]byte(s))
	if err == nil && value.Kind != jsvalue.Object {
		err = errors.New("expected a valve JSON object")
	}
	return value, err
}

// jsErrorCode is `error.code || 'write_failed'` for an error whose message
// zoneDBMessage rendered: node-sqlite3 sets code to the SQLITE_* name that
// prefixes its message; any other error has no code.
func jsErrorCode(message string) string {
	if code, _, ok := strings.Cut(message, ": "); ok && strings.HasPrefix(code, "SQLITE_") && !strings.ContainsAny(code, " ") {
		return code
	}
	return "write_failed"
}
