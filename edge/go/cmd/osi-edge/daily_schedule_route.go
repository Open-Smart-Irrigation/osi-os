package main

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsnum"
	"osi-edge/internal/jsvalue"
)

func init() {
	register("PUT", "/api/irrigation-zones/:id/schedule", (*backend).saveDailySchedule)
}

func (b *backend) saveDailySchedule(w http.ResponseWriter, r *http.Request, p params, request httpbody.Body) {
	session, authFailure := b.zoneBearer(r)
	if authFailure != nil {
		zoneLegacyAuthFailure(w, authFailure)
		return
	}
	ctx := r.Context()
	scoped := scopedAccess()
	if scoped {
		zoneNumber, valid := zoneIntegerID(p["id"])
		if !valid {
			message(w, 400, "Invalid zone ID")
			return
		}
		if status, text := b.dailyScheduleScope(ctx, session, zoneNumber); status != 0 {
			message(w, status, text)
			return
		}
	}
	// schedule-save.js decodeToken splices the username after the scoped
	// guard, in both modes.
	if err := legacyUserLookupError(session); err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()
	result, err := b.writeDailySchedule(ctx, p["id"], session, scoped, request.Value)
	if err != nil {
		var exception *jsvalue.JSError
		if errors.As(err, &exception) {
			respond(w, 500, jsvalue.Property("message", jsvalue.Str("Schedule validation failed")),
				jsvalue.Property("error", jsvalue.Str(exception.Message)))
			return
		}
		var refusal *scheduleError
		if !errors.As(err, &refusal) {
			refusal = scheduleRefusal(500, "lifecycle_error", err.Error())
		}
		if (refusal.status == 400 || refusal.status == 401 || refusal.status == 404) && refusal.code != "lifecycle_error" {
			message(w, refusal.status, refusal.message)
		} else {
			respond(w, refusal.status, jsvalue.Property("message", jsvalue.Str(refusal.message)),
				jsvalue.Property("reason", jsvalue.Str(refusal.code)))
		}
		return
	}
	status := http.StatusOK
	if len(result.Get("clear_results").List) != 0 {
		status = http.StatusAccepted
	}
	respond(w, status, result.Fields...)
}

type dailySchedulePatch struct {
	metric, mode        string
	threshold, duration float64
	enabled             int
}

func parseDailySchedulePatch(body jsvalue.Value) (dailySchedulePatch, string) {
	if body.Kind == jsvalue.String {
		body, _ = jsvalue.Parse(body.UTF8(false))
	}
	get := func(names ...string) jsvalue.Value {
		for _, key := range names {
			v := body.Get(key)
			if v.Kind != jsvalue.Undefined && v.Kind != jsvalue.Null {
				return v
			}
		}
		return jsvalue.Value{}
	}
	rawMetric := get("trigger_metric", "triggerMetric", "metric", "metric_id")

	metric := jsvalue.Upper(rawMetric.OrEmpty().MustString())
	allowed := []string{"SWT_WM1", "SWT_WM2", "SWT_AVG", "SWT_1", "SWT_2", "SWT_3", "DENDRO"}
	if !slices.Contains(allowed, metric) {
		return dailySchedulePatch{}, "Invalid trigger_metric. Allowed: " + strings.Join(allowed, ", ")
	}
	rawThreshold := get("threshold_kpa", "thresholdKpa", "threshold", "kpa")

	threshold := rawThreshold.MustNumber()
	if metric == "DENDRO" {
		prefix := zoneIDPrefix.FindString(jsvalue.Trim(rawThreshold.MustString()))
		encoded, err := strconv.ParseFloat(prefix, 64)
		if err != nil || encoded != threshold || !valveWhole(jsvalue.Num(threshold), 1, 4) {
			return dailySchedulePatch{}, "Invalid DENDRO threshold_kpa (allowed encoded levels: 1=mild, 2=moderate, 3=significant, 4=severe)"
		}
	} else if math.IsNaN(threshold) || threshold <= 0 || threshold > 300 {
		return dailySchedulePatch{}, "Invalid threshold_kpa (0 < x ≤ 300)"
	}
	duration := 20.0
	if v := get("duration_minutes", "durationMinutes", "duration", "minutes"); v.Kind != jsvalue.Undefined {
		duration = v.MustNumber()
	}
	if math.IsNaN(duration) || duration <= 0 || duration > 240 {
		return dailySchedulePatch{}, "Invalid duration_minutes (0 < x ≤ 240)"
	}
	rawMode := zoneFallback(get("response_mode", "responseMode"), jsvalue.Str("proportional"))

	mode := jsvalue.Lower(jsvalue.Trim(rawMode.MustString()))
	if !slices.Contains([]string{"proportional", "fixed", "aggressive"}, mode) {
		return dailySchedulePatch{}, "Invalid response_mode. Allowed: proportional, fixed, aggressive"
	}
	enabled := 1
	value := get("enabled", "is_enabled", "isEnabled")
	if value.Kind != jsvalue.Undefined {
		switch jsvalue.Lower(jsvalue.Trim(value.MustString())) {
		case "0", "false", "no", "off":
			enabled = 0
		case "1", "true", "yes", "on":
		default:
			if !value.Truthy() {
				enabled = 0
			}
		}
	}
	return dailySchedulePatch{metric, mode, threshold, jsnum.Round(duration), enabled}, ""
}

// dailyScheduleScope is osi-daily-scheduler decodeToken's scoped branch: the
// actor's uuid (JS truthiness, bound back with its storage class), the zone
// uuid by Number(id), assertFreshZoneAccess, then canMutate.
func (b *backend) dailyScheduleScope(ctx context.Context, session auth.Session, zoneNumber float64) (int, string) {
	reply := func(problem *scopeProblem) (int, string) {
		switch problem.status {
		case 404:
			return 404, "zone not found"
		case 403:
			return 403, "Forbidden"
		}
		return problem.status, problem.message
	}
	var actor storedValue
	err := b.db.QueryRowContext(ctx, "SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1",
		session.UserID, session.Username.MustString()).Scan(&actor)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !actor.truthy()) {
		return 401, "Unauthorized"
	}
	if err != nil {
		return 500, err.Error()
	}
	zoneUUID, found := b.resolveZoneUUIDByID(ctx, zoneNumber)
	if !found {
		return 404, "zone not found"
	}
	user, problem := assertFreshZoneAccess(ctx, b.db, actor, zoneUUID)
	if problem != nil {
		return reply(problem)
	}
	if !scopeCanMutate(user.role) {
		return 403, "Forbidden"
	}
	return 0, ""
}

func (b *backend) writeDailySchedule(ctx context.Context, rawID string, session auth.Session, scoped bool, body jsvalue.Value) (jsvalue.Value, error) {
	var result jsvalue.Value
	err := b.db.withImmediateTx(ctx, func(tx *farmConn) (err error) {
		defer jsvalue.CatchConversion(&err)
		// The flow's user lookup only checks that the row exists; the scoped
		// account checks ran before (dailyScheduleScope).
		var userID int64
		// schedule-save.js decodeToken spells auth.userId, in both modes.
		err = tx.QueryRowContext(ctx, "SELECT id FROM users WHERE id=? AND username=?",
			legacyUserLookupID(session), session.Username.MustString()).Scan(&userID)
		if errors.Is(err, sql.ErrNoRows) {
			return scheduleRefusal(401, "unauthorized", "User not found")
		}
		if err != nil {
			return err
		}
		id, err := strconv.ParseFloat(zoneIDPrefix.FindString(jsvalue.Trim(rawID)), 64)
		if err != nil {
			return scheduleRefusal(400, "", "Invalid zone ID")
		}
		patch, problem := parseDailySchedulePatch(body)
		if problem != "" {
			return scheduleRefusal(400, "", problem)
		}
		var lastApplied, policy sql.NullString
		var zone, gateway storedValue
		// schedule-save.js verifyZoneOwnership embeds zone and user ids as SQL
		// literals; the row itself is written with bound values (lifecycle.js).
		err = tx.QueryRowContext(ctx, `SELECT z.zone_uuid,z.gateway_device_eui,CAST(s.last_applied_at AS TEXT)
			FROM irrigation_zones z LEFT JOIN irrigation_schedules s ON s.irrigation_zone_id=z.id
			WHERE z.id=? AND z.deleted_at IS NULL AND (? OR z.user_id=?)`,
			sqliteNumberLiteral(id), scoped, sqliteNumberLiteral(float64(userID))).Scan(&zone, &gateway, &lastApplied)
		if errors.Is(err, sql.ErrNoRows) {
			return scheduleRefusal(404, "not_found", "Zone not found or access denied")
		}
		if err != nil {
			return err
		}
		if err := authorizeLegacyScheduleWrite(ctx, tx, float64(userID), session.Username.MustString(), id, scoped); err != nil {
			return err
		}
		var linkAttempt sql.NullString
		err = tx.QueryRowContext(ctx, "SELECT link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").Scan(&linkAttempt)
		if err != nil && !errors.Is(err, sql.ErrNoRows) && !strings.Contains(err.Error(), "no such column") {
			return err
		}
		if jsvalue.Trim(linkAttempt.String) != "" {
			return scheduleRefusal(409, "link_in_progress", "gateway account linking is in progress")
		}
		// lifecycle.js zoneState binds the zone_uuid it read: TEXT as the
		// decoded string (so a zone_uuid stored with invalid UTF-8 finds no
		// policy), a BLOB as a Buffer, which matches only a BLOB policy key.
		err = tx.QueryRowContext(ctx, "SELECT policy_uuid FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1",
			zone.bindJS()).Scan(&policy)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := time.Now()
		if policy.Valid {
			if patch.enabled != 0 {
				return scheduleRefusal(409, "managed_schedule_conflict", "legacy schedule writes are disabled while a conditional policy exists")
			}
			result, err = pauseManagedDailySchedule(ctx, tx, id, policy.String, now)
			return err
		}

		at := valveISO(now)
		var version int64
		err = tx.QueryRowContext(ctx, `INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,
			duration_minutes,enabled,response_mode,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)
			ON CONFLICT(irrigation_zone_id) DO UPDATE SET trigger_metric=excluded.trigger_metric,threshold_kpa=excluded.threshold_kpa,
			duration_minutes=excluded.duration_minutes,enabled=excluded.enabled,response_mode=excluded.response_mode,
			deleted_at=NULL,sync_version=COALESCE(irrigation_schedules.sync_version,0)+1,updated_at=excluded.updated_at
			RETURNING sync_version`, id, patch.metric, patch.threshold, patch.duration, patch.enabled, patch.mode, at, at).Scan(&version)
		if err != nil {
			return err
		}
		// routes.js answers the zone row as read: zone.zone_uuid || null and
		// zone.gateway_device_eui || String(DEVICE_EUI || 'UNKNOWN').toUpperCase();
		// a BLOB is a truthy Buffer, answered as Buffer JSON.
		gatewayEUI := gateway.json()
		if !gateway.truthy() {
			gatewayEUI = jsvalue.Str(jsvalue.Upper(cmp.Or(os.Getenv("DEVICE_EUI"), "UNKNOWN")))
		}
		zoneUUID := jsvalue.Nil()
		if zone.truthy() {
			zoneUUID = zone.json()
		}
		p := jsvalue.Property
		result = jsvalue.Obj(p("irrigation_zone_id", jsvalue.Num(id)), p("zone_uuid", zoneUUID),
			p("gateway_device_eui", gatewayEUI), p("trigger_metric", jsvalue.Str(patch.metric)),
			p("threshold_kpa", jsvalue.Num(patch.threshold)), p("duration_minutes", jsvalue.Num(patch.duration)),
			p("enabled", jsvalue.Bool(patch.enabled != 0)), p("response_mode", jsvalue.Str(patch.mode)),
			p("sync_version", jsvalue.Num(float64(version))), p("deleted_at", jsvalue.Nil()),
			p("last_applied_at", zoneFallback(nullableText(lastApplied), jsvalue.Nil())))
		return nil
	})
	return result, err
}

// authorizeLegacyScheduleWrite is authorizeAfterWriters in osi-irrigation-policy
// routes.js (legacy_schedule_write), run inside the writer. It binds
// request.actorId, which is Number(msg.payload[0].id), and request.zoneId as
// doubles, where the checks before it spelled them. User 123456789012345700
// passes the spelled gate and is refused here with 401; zone
// 123456789012345700 passes the spelled ownership query and is not found
// here. In scoped mode it repeats assertFreshRole, canMutate and
// assertFreshZoneAccess on the fresh rows, so a role or grant change after
// dailyScheduleScope refuses the write. Failures carry reason lifecycle_error
// (the scope helper's errors have no code).
func authorizeLegacyScheduleWrite(ctx context.Context, tx *farmConn, actorID float64, username string, zoneID float64, scoped bool) error {
	var actor, role storedValue
	var err error
	// String(msg.authUsername || request.username || '').trim(): an empty
	// name looks the actor up by id alone.
	if name := jsvalue.Trim(username); name != "" {
		err = tx.QueryRowContext(ctx, "SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1", actorID, name).Scan(&actor, &role)
	} else {
		err = tx.QueryRowContext(ctx, "SELECT user_uuid, role FROM users WHERE id=? LIMIT 1", actorID).Scan(&actor, &role)
	}
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !actor.truthy()) {
		return scheduleRefusal(401, "lifecycle_error", "Unauthorized")
	}
	if err != nil {
		return err
	}
	var zoneUUID storedValue
	err = tx.QueryRowContext(ctx, "SELECT zone_uuid FROM irrigation_zones WHERE id=? AND deleted_at IS NULL", zoneID).Scan(&zoneUUID)
	if errors.Is(err, sql.ErrNoRows) {
		return scheduleRefusal(404, "lifecycle_error", "zone not found")
	}
	if err != nil {
		return err
	}
	if scoped {
		refuse := func(problem *scopeProblem) error {
			return scheduleRefusal(problem.status, "lifecycle_error", problem.message)
		}
		user, problem := assertFreshRole(ctx, tx, actor, role)
		if problem != nil {
			return refuse(problem)
		}
		if !scopeCanMutate(user.role) {
			return scheduleRefusal(403, "lifecycle_error", "insufficient role")
		}
		if _, problem := assertFreshZoneAccess(ctx, tx, actor, zoneUUID); problem != nil {
			return refuse(problem)
		}
		return nil
	}
	var found int64
	err = tx.QueryRowContext(ctx, "SELECT 1 FROM irrigation_zones WHERE id=? AND user_id=? AND deleted_at IS NULL", zoneID, actorID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return scheduleRefusal(404, "lifecycle_error", "zone not found or access denied")
	}
	return err
}
