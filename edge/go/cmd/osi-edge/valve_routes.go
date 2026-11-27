package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsvalue"
)

func init() {
	registerWithCatch("GET", "/api/valves", (*backend).listValves, valveAPICoercionCatch)
	registerWithCatch("POST", "/api/valve/:deveui/cancel", (*backend).cancelValve, cancelCoercionCatch)
	registerWithCatch("POST", "/api/v1/valves/:deveui/cancel", (*backend).cancelValve, cancelCoercionCatch)
}

// valveScopeProblem is an error thrown by freshValveScope (osi-valve-control
// api.js) or the manual-command boundary (osi-command-ingress): code is the
// error.code the valve API router reports (osi-scope-helper errors have none).
type valveScopeProblem struct {
	status        int
	code, message string
}

// valveScope reads the actor's user_uuid and role, refuses a falsy uuid with
// 401, then runs assertFreshDeviceAccess (with a device) or assertFreshRole
// (without one), and finally canMutate on the scope's role. Every column keeps
// the storage class node-sqlite3 hands to the flows.
func (b *backend) valveScope(ctx context.Context, session auth.Session, eui string) *valveScopeProblem {
	var userUUID, role storedValue
	err := b.db.QueryRowContext(ctx, `SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1`,
		session.UserID, session.Username.MustString()).Scan(&userUUID, &role)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !userUUID.truthy()) {
		return &valveScopeProblem{401, "unauthorized", "Unauthorized"}
	}
	if err != nil {
		log.Printf("valve scope user: %v", err)
		return &valveScopeProblem{500, "error", err.Error()}
	}
	var actorScope scopeUser
	var problem *scopeProblem
	if eui != "" {
		actorScope, problem = b.assertFreshDeviceAccess(ctx, userUUID, eui)
	} else {
		actorScope, problem = b.assertFreshRole(ctx, userUUID, role)
	}
	if problem != nil {
		return &valveScopeProblem{problem.status, "error", problem.message}
	}
	if !scopeCanMutate(actorScope.role) {
		return &valveScopeProblem{403, "forbidden", "insufficient role"}
	}
	return nil
}

// respondValveAPIProblem is the valve API router's catch block.
func respondValveAPIProblem(w http.ResponseWriter, problem *valveScopeProblem) {
	if problem.status == 500 {
		respond(w, 500, jsvalue.Property("error", jsvalue.Str("internal_error")), jsvalue.Property("message", jsvalue.Str("Valve request failed")))
		return
	}
	respond(w, problem.status, jsvalue.Property("error", jsvalue.Str(problem.code)), jsvalue.Property("message", jsvalue.Str(problem.message)))
}

// valveListSQL is store.js VALVE_LIST_SQL. Its LIKE matches a BLOB as text on
// the gateway's sqlite3; modernc is built with SQLITE_LIKE_DOESNT_MATCH_BLOBS,
// so the stale-state filter casts first.
const valveListSQL = `
	SELECT d.deveui, d.name, d.irrigation_zone_id, z.name, z.zone_uuid, z.timezone,
		d.current_state, d.target_state, COALESCE(s.strega_generation,'GEN1'),
		COALESCE(s.flow_rate_lpm,c.measured_flow_rate_lpm),
		CASE WHEN s.flow_rate_lpm IS NOT NULL THEN COALESCE(s.flow_rate_source,'estimated')
		     WHEN c.measured_flow_rate_lpm IS NOT NULL THEN 'zone' END,
		s.default_open_minutes, COALESCE(s.scheduler_status,'ACTIVE'), s.skip_today_date,
		(SELECT MAX(recorded_at) FROM device_data WHERE deveui=d.deveui),
		(SELECT ambient_temperature FROM device_data WHERE deveui=d.deveui AND ambient_temperature IS NOT NULL
			AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day') ORDER BY recorded_at DESC LIMIT 1),
		(SELECT relative_humidity FROM device_data WHERE deveui=d.deveui AND relative_humidity IS NOT NULL
			AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day') ORDER BY recorded_at DESC LIMIT 1),
		(SELECT MAX(recorded_at) FROM device_data WHERE deveui=d.deveui AND (ambient_temperature IS NOT NULL OR relative_humidity IS NOT NULL)
			AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day')),
		(SELECT reconciliation_state FROM valve_actuation_expectations WHERE device_eui=d.deveui
			AND CAST(reconciliation_state AS TEXT) LIKE 'STALE_%' AND datetime(commanded_at) > datetime('now','-1 day')
			ORDER BY commanded_at DESC LIMIT 1),
		(SELECT COUNT(*) FROM valve_schedules WHERE UPPER(device_eui)=UPPER(d.deveui) AND deleted_at IS NULL),
		s.last_clock_sync_acked_at
	FROM devices d
	LEFT JOIN irrigation_zones z ON z.id=d.irrigation_zone_id AND z.deleted_at IS NULL
	LEFT JOIN valve_settings s ON s.device_eui=d.deveui
	LEFT JOIN zone_irrigation_calibration c ON c.zone_id=d.irrigation_zone_id
	WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL AND d.user_id=?
	ORDER BY COALESCE(z.name,'~'), d.name`

type valveListRow struct {
	eui, generation, scheduler  string
	current, target, flowSource sql.NullString
	// Echoed as read: api.js shapeValve answers row.name and `row.x || null`
	// for the others, so a BLOB answers as Buffer JSON.
	name, zoneName, zoneUUID, skipDate, lastUplink, measuredAt, staleState, clockAck storedValue
	timezone                                                                         storedValue
	zoneID, defaultMinutes                                                           sql.NullInt64
	rate, temperature, humidity                                                      sql.NullFloat64
	scheduleCount                                                                    int
}

func (b *backend) listValves(w http.ResponseWriter, r *http.Request, _ params, _ httpbody.Body) {
	now := time.Now()
	session, ok := valveAPISession(w, r, now)
	if !ok {
		return
	}
	ctx := r.Context()
	scoped := scopedAccess()
	if scoped {
		if problem := b.valveScope(ctx, session, ""); problem != nil {
			respondValveAPIProblem(w, problem)
			return
		}
	}
	valves, err := b.valveListRows(ctx, session.UserID)
	if err != nil {
		valveServerError(w, err)
		return
	}
	// api.js: tzFallback = gatewayTimezone setting || 'UTC', kept as read (a
	// BLOB setting is a Buffer).
	fallback := timezoneChain(storedGatewaySetting(ctx, b.db, "gateway_timezone"))
	result := make([]jsvalue.Value, 0, len(valves))
	for _, row := range valves {
		if scoped {
			problem := b.valveScope(ctx, session, jsvalue.Upper(row.eui))
			if problem != nil && problem.status == 404 {
				continue
			}
			if problem != nil {
				respondValveAPIProblem(w, problem)
				return
			}
		}
		active, err := b.cancellableValves(ctx, row.eui)
		if err != nil {
			valveServerError(w, err)
			return
		}
		actuation := jsvalue.Nil()
		if len(active) > 0 {
			actuation = active[0].wire()
		}
		// shapeValve: row.zone_timezone || tzFallback, answered as read and
		// passed to nextRun as its fallback.
		timezone := timezoneChain(row.timezone, fallback)
		next, err := b.nextValveRun(ctx, row.eui, timezone, now)
		if err != nil {
			valveServerError(w, err)
			return
		}
		pushes, err := valvePushSummary(ctx, b.db, row.eui, now)
		if err != nil {
			valveServerError(w, err)
			return
		}
		result = append(result, row.wire(timezone, actuation, next, pushes))
	}
	respond(w, 200,
		jsvalue.Property("generatedAt", jsvalue.Str(valveISO(now))),
		jsvalue.Property("valves", jsvalue.Arr(result...)),
	)
}

func (b *backend) valveListRows(ctx context.Context, userID float64) ([]valveListRow, error) {
	rows, err := b.db.QueryContext(ctx, valveListSQL, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var valves []valveListRow
	for rows.Next() {
		var row valveListRow
		if err := rows.Scan(&row.eui, &row.name, &row.zoneID, &row.zoneName, &row.zoneUUID, &row.timezone,
			&row.current, &row.target, &row.generation, &row.rate, &row.flowSource, &row.defaultMinutes,
			&row.scheduler, &row.skipDate, &row.lastUplink, &row.temperature, &row.humidity, &row.measuredAt,
			&row.staleState, &row.scheduleCount, &row.clockAck); err != nil {
			return nil, err
		}
		valves = append(valves, row)
	}
	return valves, rows.Err()
}

func (row valveListRow) wire(timezone storedValue, actuation, next, pushes jsvalue.Value) jsvalue.Value {
	return jsvalue.Obj(
		jsvalue.Property("device_eui", jsvalue.Str(row.eui)),
		jsvalue.Property("name", row.name.json()),
		jsvalue.Property("zone_id", valveInt(row.zoneID)),
		jsvalue.Property("zone_name", row.zoneName.orNull()),
		jsvalue.Property("zone_uuid", row.zoneUUID.orNull()),
		jsvalue.Property("timezone", timezone.json()),
		jsvalue.Property("current_state", valveText(row.current)),
		jsvalue.Property("target_state", valveText(row.target)),
		jsvalue.Property("strega_generation", jsvalue.Str(row.generation)),
		jsvalue.Property("flow_rate_lpm", valveFloat(row.rate)),
		jsvalue.Property("flow_rate_source", valveText(row.flowSource)),
		jsvalue.Property("default_open_minutes", valveInt(row.defaultMinutes)),
		jsvalue.Property("scheduler_status", jsvalue.Str(row.scheduler)),
		jsvalue.Property("skip_today_date", row.skipDate.orNull()),
		jsvalue.Property("last_uplink_at", row.lastUplink.orNull()),
		jsvalue.Property("enclosure_temperature_c", valveFloat(row.temperature)),
		jsvalue.Property("enclosure_humidity_pct", valveFloat(row.humidity)),
		jsvalue.Property("enclosure_measured_at", row.measuredAt.orNull()),
		jsvalue.Property("active_actuation", actuation),
		jsvalue.Property("recent_stale_state", row.staleState.orNull()),
		jsvalue.Property("next_run", next),
		jsvalue.Property("schedule_count", jsvalue.Num(float64(row.scheduleCount))),
		jsvalue.Property("push_state", pushes),
		jsvalue.Property("last_clock_sync_acked_at", row.clockAck.orNull()),
	)
}

type cancellableValve struct {
	id, state, commandedAt, expectedCloseAt string
	trigger                                 sql.NullString
	seconds                                 int
	queueID                                 string
	transport                               sql.NullString
	commandID                               sql.NullString
	conditional                             bool
}

func (v cancellableValve) wire() jsvalue.Value {
	return jsvalue.Obj(
		jsvalue.Property("expectation_id", jsvalue.Str(v.id)),
		jsvalue.Property("reconciliation_state", jsvalue.Str(v.state)),
		jsvalue.Property("commanded_at", jsvalue.Str(v.commandedAt)),
		jsvalue.Property("expected_close_at", jsvalue.Str(v.expectedCloseAt)),
		jsvalue.Property("duration_seconds", jsvalue.Num(float64(v.seconds))),
		jsvalue.Property("trigger", valveText(v.trigger)),
	)
}

func (b *backend) cancellableValves(ctx context.Context, eui string) ([]cancellableValve, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT expectation_id, reconciliation_state, commanded_at,
		expected_close_at, commanded_duration_seconds, trigger, transport_json, command_id,
		EXISTS(SELECT 1 FROM irrigation_occurrences o WHERE UPPER(o.device_eui)=UPPER(e.device_eui) AND o.command_id IS NOT NULL
			AND (o.command_id=e.command_id OR o.state IN ('RESERVED','ATTEMPTED','SENT','UNKNOWN')))
		FROM valve_actuation_expectations e WHERE UPPER(device_eui)=UPPER(?)
		AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')
		AND commanded_duration_seconds > 0 ORDER BY commanded_at DESC, rowid DESC`, eui)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var active []cancellableValve
	for rows.Next() {
		var v cancellableValve
		err := rows.Scan(&v.id, &v.state, &v.commandedAt, &v.expectedCloseAt, &v.seconds,
			&v.trigger, &v.transport, &v.commandID, &v.conditional)
		if err != nil {
			return nil, err
		}
		transport, _ := valveStoredJSON(v.transport.String)
		seen := transport.Get("untrusted_report")
		if transport.Get("physical_run").Kind == jsvalue.Object || (seen.Get("open").Truthy() && seen.Get("closed").Truthy()) {
			continue
		}
		if q := transport.Get("queue_id"); q.Kind != jsvalue.Null && q.Kind != jsvalue.Undefined {
			// storedQueueId catches coercion errors and treats the ID as absent.
			v.queueID, _ = q.CoerceString()
		}
		active = append(active, v)
	}
	return active, rows.Err()
}

func (b *backend) cancelValve(w http.ResponseWriter, r *http.Request, p params, request httpbody.Body) {
	session, ok := b.valveUser(w, r, true)
	if !ok {
		return
	}
	reply := func(status int, message string, extra ...jsvalue.Field) {
		sendJSON(w, status, jsvalue.Obj(append([]jsvalue.Field{jsvalue.Property("message", jsvalue.Str(message))}, extra...)...))
	}
	eui := jsvalue.Upper(jsvalue.Trim(p["deveui"]))
	if eui == "" {
		reply(400, "Missing valve deveui")
		return
	}
	body := request.Value
	rawReason := zoneFallback(body.Get("reason"), jsvalue.Str("operator_cancel"))
	reason := rawReason.TrimmedString().MustString()
	if reason == "" {
		reason = "operator_cancel"
	}
	ctx := r.Context()
	scoped := scopedAccess()
	if scoped {
		// cancel-ingress: `!actor.user_uuid` is JS truthiness, and the uuid is
		// bound back with its storage class.
		var actor storedValue
		err := b.db.QueryRowContext(ctx, "SELECT user_uuid FROM users WHERE id=? AND username=?",
			session.UserID, session.Username.MustString()).Scan(&actor)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !actor.truthy()) {
			reply(401, "Unauthorized")
			return
		}
		if err != nil {
			reply(500, err.Error())
			return
		}
		user, problem := b.assertFreshDeviceAccess(ctx, actor, eui)
		if problem != nil {
			reply(problem.status, problem.message)
			return
		}
		if !scopeCanMutate(user.role) {
			reply(403, "insufficient role")
			return
		}
	}
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()
	valve, err := b.findValve(ctx, eui, true)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		reply(404, "Valve not found in devices table")
		return
	case err != nil:
		log.Printf("cancel valve lookup: %v", err)
		reply(500, "Valve request failed")
		return
	case valve.kind != valveType:
		reply(409, "Device "+eui+" is not a STREGA_VALVE")
		return
	case !scoped && ownedByOther(valve.owner, session.UserID):
		reply(403, "Valve is claimed by another user")
		return
	}
	// cancel-ingress passes `transport: cs()` into cancelActuation, so the
	// ChirpStack client is built before any target selection or write; its
	// constructor throws on an empty or invalid URL or key, and the outer
	// catch answers 500 with that message.
	if err := chirpstackClientConfigError(); err != nil {
		reply(500, err.Error())
		return
	}
	rawExpectation := body.Get("expectation_id")
	var expectation string
	if rawExpectation.Kind != jsvalue.Undefined && rawExpectation.Kind != jsvalue.Null {
		expectation = rawExpectation.TrimmedString().MustString()
	}
	active, err := b.cancellableValves(ctx, eui)
	if err != nil {
		log.Printf("cancel valve active commands: %v", err)
		reply(500, "Valve request failed")
		return
	}
	ctx = context.WithoutCancel(ctx)
	target, queue, ambiguity, err := b.selectValveCancel(ctx, eui, active, expectation)
	if err != nil {
		log.Printf("select valve cancellation: %v", err)
		reply(500, "Unable to cancel STREGA actuation")
		return
	}
	if ambiguity != "" {
		reply(409, "More than one actuation is active; name the one to cancel (expectation_id)",
			jsvalue.Property("error", jsvalue.Str("ambiguous_actuation")), jsvalue.Property("ambiguity", jsvalue.Str(ambiguity)))
		return
	}
	if target.id == "" {
		reply(404, "No active actuation to cancel", jsvalue.Property("error", jsvalue.Str("no_active_actuation")))
		return
	}
	if target.state == "" {
		reply(409, "That actuation is no longer active", jsvalue.Property("error", jsvalue.Str("actuation_not_active")))
		return
	}
	b.cancelSelectedValve(w, ctx, eui, target, active, queue, reason)
}
