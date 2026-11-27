package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
	"modernc.org/sqlite"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsvalue"
)

func init() {
	register("GET", "/api/irrigation-zones", (*backend).listZones)
	register("POST", "/api/irrigation-zones", (*backend).createZone)
	register("PUT", "/api/irrigation-zones/:id/name", (*backend).renameZone)
	registerWithCatch("PUT", "/api/irrigation-zones/:zone_id/config", (*backend).configureZone, configCoercionCatch)
}

// zoneActor keeps user_uuid and role in their storage classes: the flows bind
// the uuid back as read and compare the role with ===.
type zoneActor struct {
	id   int64
	uuid storedValue
	role storedValue
}

type zoneFailure struct {
	status int
	text   string
}

func (b *backend) zoneBearer(r *http.Request) (auth.Session, *auth.AuthError) {
	return auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
}

func zoneLegacyAuthFailure(w http.ResponseWriter, failure *auth.AuthError) {
	if failure.Coercion {
		deviceAPICoercionFailure(w)
		return
	}
	status, text := failure.Status, failure.Message
	if signedNullPayload(failure) {
		// The uncaught TypeError reaches device-api-catch, which reports
		// err.toString(), name included.
		status, text = http.StatusInternalServerError, "TypeError: "+nullPayloadMessage
	}
	kind := "Unauthorized"
	if status == http.StatusInternalServerError {
		kind = "device-api failed"
	}
	respond(w, status, jsvalue.Property("error", jsvalue.Str(kind)), jsvalue.Property("message", jsvalue.Str(text)))
}

// deviceAPISQLFailure is device-api-catch's answer to a failed SQLite node.
func deviceAPISQLFailure(w http.ResponseWriter, err error) {
	respond(w, 500, jsvalue.Property("error", jsvalue.Str("device-api failed")),
		jsvalue.Property("message", jsvalue.Str("Error: "+zoneDBMessage(err))))
}

// zoneAccount looks the token's account up by userID: session.UserID where
// the JS binds auth.userId (the scoped routers), legacyUserLookupID where it
// spells it (get-zones-auth, post-zone-auth).
func (b *backend) zoneAccount(ctx context.Context, session auth.Session, userID any) (zoneActor, error) {
	var actor zoneActor
	err := b.db.QueryRowContext(ctx, `SELECT id, user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1`,
		userID, session.Username.MustString()).Scan(&actor.id, &actor.uuid, &actor.role)
	return actor, err
}

// The write guards refresh the role and zone grants on every request.
func (b *backend) zoneWriter(ctx context.Context, session auth.Session) (zoneActor, *zoneFailure) {
	actor, err := b.zoneAccount(ctx, session, session.UserID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !actor.uuid.truthy()) {
		return zoneActor{}, &zoneFailure{401, "Unauthorized"}
	}
	if err != nil {
		return zoneActor{}, &zoneFailure{500, zoneDBMessage(err)}
	}
	scope, err := b.loadScope(ctx, actor.uuid)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return zoneActor{}, &zoneFailure{500, zoneDBMessage(err)}
	}
	if errors.Is(err, sql.ErrNoRows) || scope.disabled || !storedStrictEqual(scope.roleValue, actor.role) ||
		!scopeCanMutate(scope.roleValue) {
		return zoneActor{}, &zoneFailure{403, "Forbidden"}
	}
	return actor, nil
}

func (b *backend) scopedZoneOwner(ctx context.Context, session auth.Session, rawID string) (float64, *zoneFailure) {
	actor, failure := b.zoneWriter(ctx, session)
	if failure != nil {
		return 0, failure
	}
	id, valid := zoneIntegerID(rawID)
	if !valid {
		return 0, &zoneFailure{400, "Invalid zone ID"}
	}
	var owner, zoneUUID storedValue
	err := b.db.QueryRowContext(ctx, `SELECT user_id, zone_uuid FROM irrigation_zones
		WHERE id=? AND deleted_at IS NULL LIMIT 1`, id).Scan(&owner, &zoneUUID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !zoneUUID.truthy()) {
		return 0, &zoneFailure{404, "Zone not found"}
	}
	if err != nil {
		return 0, &zoneFailure{500, zoneDBMessage(err)}
	}
	scope, err := b.loadScope(ctx, actor.uuid)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, &zoneFailure{500, zoneDBMessage(err)}
	}
	if errors.Is(err, sql.ErrNoRows) || scope.disabled {
		return 0, &zoneFailure{403, "Forbidden"}
	}
	// Set.has: a Buffer zone_uuid matches nothing.
	if scopeKeyHas(scope.zoneKeys, zoneUUID) {
		// msg._scopedZoneOwnerId = Number(zone.user_id): TEXT, REAL and BLOB
		// owners keep what Number() makes of them, NaN included.
		return owner.number(), nil
	}
	return 0, &zoneFailure{404, "Zone not found"}
}

func zoneIntegerID(raw string) (float64, bool) {
	n := jsvalue.Str(raw).MustNumber()
	return n, !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n)
}

func (b *backend) listZones(w http.ResponseWriter, r *http.Request, _ params, _ httpbody.Body) {
	session, authFailure := b.zoneBearer(r)
	if authFailure != nil {
		zoneLegacyAuthFailure(w, authFailure)
		return
	}
	// get-zones-auth splices the username, in both modes.
	if err := legacyUserLookupError(session); err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	ctx := r.Context()
	actor, err := b.zoneAccount(ctx, session, legacyUserLookupID(session))
	if errors.Is(err, sql.ErrNoRows) {
		message(w, 401, "User not found")
		return
	}
	if err != nil {
		deviceAPISQLFailure(w, err)
		return
	}

	join, filter := "d.user_id=?", "iz.user_id=?"
	args := []any{actor.id, actor.id}
	if scopedAccess() {
		// get-zones-query looks the uuid up again by msg.payload[0].id, a
		// double: user 123456789012345700 passes the spelled gate and then
		// misses here, so assertEnabledAccount sees no uuid.
		var userUUID storedValue
		err := b.db.QueryRowContext(ctx, "SELECT user_uuid FROM users WHERE id = ?", float64(actor.id)).Scan(&userUUID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			message(w, 500, zoneDBMessage(err))
			return
		}
		scope, err := b.resolveScope(ctx, userUUID)
		if errors.Is(err, sql.ErrNoRows) || scope.disabled {
			message(w, 403, "Forbidden")
			return
		}
		if err != nil {
			message(w, 500, zoneDBMessage(err))
			return
		}
		join, filter, args = "d.deleted_at IS NULL", "1=1", nil
	}

	query := `SELECT iz.id, iz.name, iz.zone_uuid, iz.gateway_device_eui, iz.sync_version, iz.deleted_at,
		iz.created_at, iz.updated_at, ` + zoneConfigColumns + `,
		zic.measured_flow_rate_lpm, zic.measurement_method, zic.updated_at AS irrigation_calibration_updated_at,
		COUNT(d.deveui) AS device_count,
		s.trigger_metric, s.threshold_kpa, s.duration_minutes, s.enabled, s.last_triggered_at, s.response_mode,
		s.sync_version AS schedule_sync_version, CAST(s.deleted_at AS TEXT) AS schedule_deleted_at,
		CAST(s.last_applied_at AS TEXT) AS last_applied_at
		FROM irrigation_zones iz
		LEFT JOIN devices d ON d.irrigation_zone_id=iz.id AND ` + join + `
		LEFT JOIN irrigation_schedules s ON s.irrigation_zone_id=iz.id
		LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id=iz.id
		WHERE ` + filter + ` AND iz.deleted_at IS NULL GROUP BY iz.id ORDER BY iz.created_at DESC`
	rows, err := queryZones(ctx, b.db, query, args...)
	if err != nil {
		message(w, 500, "DB error: "+zoneDBMessage(err))
		return
	}
	for i, row := range rows {
		rows[i] = listedZone(row)
	}
	zoneListHeaders(w)
	sendJSON(w, 200, jsvalue.Arr(rows...))
}

func zoneListHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
}

func listedZone(row jsvalue.Value) jsvalue.Value {
	p := jsvalue.Property
	fields := []jsvalue.Field{
		p("id", row.Get("id")), p("name", row.Get("name")),
		p("zone_uuid", zoneFallback(row.Get("zone_uuid"), jsvalue.Nil())),
		p("gateway_device_eui", zoneFallback(row.Get("gateway_device_eui"), jsvalue.Nil())),
		p("sync_version", zoneNumberOrZero(row.Get("sync_version"))),
		p("deleted_at", zoneFallback(row.Get("deleted_at"), jsvalue.Nil())),
		p("device_count", zoneNumberOrZero(row.Get("device_count"))),
		p("created_at", row.Get("created_at")), p("updated_at", row.Get("updated_at")),
	}
	fields = append(fields, zoneConfigFields(row, true)...)
	fields = append(fields,
		p("measured_flow_rate_lpm", zoneNullableNumber(row.Get("measured_flow_rate_lpm"))),
		p("measurement_method", zoneFallback(row.Get("measurement_method"), jsvalue.Nil())),
		p("irrigation_calibration_updated_at", zoneFallback(row.Get("irrigation_calibration_updated_at"), jsvalue.Nil())),
	)
	schedule := jsvalue.Nil()
	if metric := row.Get("trigger_metric"); metric.Truthy() {
		schedule = jsvalue.Obj(
			p("irrigation_zone_id", row.Get("id")),
			p("zone_uuid", zoneFallback(row.Get("zone_uuid"), jsvalue.Nil())),
			p("trigger_metric", metric),
			p("threshold_kpa", row.Get("threshold_kpa")),
			p("duration_minutes", row.Get("duration_minutes")),
			p("enabled", jsvalue.Bool(row.Get("enabled").Truthy())),
			p("last_triggered_at", row.Get("last_triggered_at")),
			p("response_mode", zoneFallback(row.Get("response_mode"), jsvalue.Str("proportional"))),
			p("sync_version", zoneNumberOrZero(row.Get("schedule_sync_version"))),
			p("deleted_at", zoneFallback(row.Get("schedule_deleted_at"), jsvalue.Nil())),
			p("last_applied_at", zoneFallback(row.Get("last_applied_at"), jsvalue.Nil())),
		)
	}
	return jsvalue.Obj(append(fields, p("schedule", schedule))...)
}

func (b *backend) createZone(w http.ResponseWriter, r *http.Request, _ params, request httpbody.Body) {
	scoped := scopedAccess()
	session, authFailure := b.zoneBearer(r)
	if authFailure != nil {
		if scoped {
			message(w, authFailure.Status, authFailure.Message)
		} else {
			zoneLegacyAuthFailure(w, authFailure)
		}
		return
	}

	ctx := r.Context()
	var actor zoneActor
	if scoped {
		var failure *zoneFailure
		actor, failure = b.zoneWriter(ctx, session)
		if failure != nil {
			message(w, failure.status, failure.text)
			return
		}
	}
	name, reason := normalizeZoneName(request.Value.Get("name"))
	if reason != "" {
		zoneNameFailure(w, reason, true)
		return
	}
	if scoped {
		b.createScopedZone(ctx, w, actor, name)
		return
	}
	// post-zone-auth splices the username after validating the name; the
	// scoped router answers before that node with a bound lookup.
	if err := legacyUserLookupError(session); err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	actor, err := b.zoneAccount(ctx, session, legacyUserLookupID(session))
	if errors.Is(err, sql.ErrNoRows) {
		message(w, 401, "User not found")
		return
	}
	if err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	b.createLegacyZone(ctx, w, actor.id, name, request.Value.Get("timezone"))
}

func (b *backend) createLegacyZone(ctx context.Context, w http.ResponseWriter, userID int64, name string, requestedTZ jsvalue.Value) {
	var timezone string
	if requestedTZ.Kind == jsvalue.String {
		timezone = jsvalue.Trim(requestedTZ.MustString())
	}
	if timezone == "" {
		// post-zone-insert: (row && row.value) || 'UTC', spliced into the
		// INSERT as String(timezone): a BLOB setting is a truthy Buffer, so an
		// empty one writes '' and any other its decoded text.
		var setting storedValue
		err := b.db.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key='gateway_timezone'").Scan(&setting)
		if err != nil && !errors.Is(err, sql.ErrNoRows) && !strings.Contains(err.Error(), "no such table: app_settings") {
			log.Printf("zone create gateway timezone: %v", err)
		}
		timezone = timezoneChain(setting).jsString()
	}
	if err := splicedLiteralError(timezone); err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	id, err := uuid.NewRandom()
	if err != nil {
		log.Printf("generate zone UUID: %v", err)
		message(w, 500, "Failed to create zone")
		return
	}
	zoneUUID, gateway, now := id.String(), zoneGateway(false), timestamp()
	_, err = b.db.ExecContext(ctx, `INSERT INTO irrigation_zones
		(name,user_id,zone_uuid,gateway_device_eui,sync_version,timezone,created_at,updated_at)
		VALUES (?,?,?,?,1,?,?,?)`, name, userID, zoneUUID, gateway, timezone, now, now)
	if err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	rows, err := queryZones(ctx, b.db, `SELECT id,name,zone_uuid,gateway_device_eui,sync_version,deleted_at,created_at,updated_at
		FROM irrigation_zones WHERE zone_uuid=? LIMIT 1`, zoneUUID)
	if err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	if len(rows) == 0 {
		message(w, 500, "Failed to create zone")
		return
	}
	respondCreatedZone(w, rows[0])
}

func (b *backend) createScopedZone(ctx context.Context, w http.ResponseWriter, actor zoneActor, name string) {
	var ids [32]byte
	if _, err := rand.Read(ids[:]); err != nil {
		message(w, 500, err.Error())
		return
	}
	zoneUUID, assignmentUUID := hex.EncodeToString(ids[:16]), hex.EncodeToString(ids[16:])
	gateway, now := zoneGateway(true), timestamp()
	var id int64
	err := b.db.withImmediateTx(ctx, func(tx *farmConn) error {
		result, err := tx.ExecContext(ctx, `INSERT INTO irrigation_zones
			(name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at)
			VALUES (?,?,?,?,1,?,?)`, name, actor.id, zoneUUID, gateway, now, now)
		if err != nil {
			return err
		}
		id, err = result.LastInsertId()
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO user_zone_assignments
			(assignment_uuid,user_uuid,zone_uuid,assigned_by_user_uuid,gateway_device_eui,sync_version,created_at,updated_at)
			VALUES (?,?,?,?,?,1,?,?)`, assignmentUUID, actor.uuid.arg(), zoneUUID, actor.uuid.arg(), gateway, now, now)
		return err
	})
	if err != nil {
		message(w, 500, zoneDBMessage(err))
		return
	}
	b.invalidateScope(actor.uuid)
	p := jsvalue.Property
	respondCreatedZone(w, jsvalue.Obj(
		p("id", jsvalue.Num(float64(id))), p("name", jsvalue.Str(name)),
		p("zone_uuid", jsvalue.Str(zoneUUID)), p("gateway_device_eui", jsvalue.Str(gateway)),
		p("sync_version", jsvalue.Num(1)), p("deleted_at", jsvalue.Nil()),
		p("created_at", jsvalue.Str(now)), p("updated_at", jsvalue.Str(now)),
	))
}

func respondCreatedZone(w http.ResponseWriter, row jsvalue.Value) {
	p := jsvalue.Property
	respond(w, 201, p("id", row.Get("id")), p("name", row.Get("name")), p("zone_uuid", row.Get("zone_uuid")),
		p("gateway_device_eui", row.Get("gateway_device_eui")), p("sync_version", zoneNumberOrZero(row.Get("sync_version"))),
		p("deleted_at", zoneFallback(row.Get("deleted_at"), jsvalue.Nil())), p("device_count", jsvalue.Num(0)),
		p("created_at", row.Get("created_at")), p("updated_at", row.Get("updated_at")), p("schedule", jsvalue.Nil()))
}

func zoneGateway(scoped bool) string {
	eui := os.Getenv("DEVICE_EUI")
	if eui == "" && scoped {
		eui = os.Getenv("GATEWAY_DEVICE_EUI")
	}
	if eui == "" {
		eui = "UNKNOWN"
	}
	return jsvalue.Upper(jsvalue.Trim(eui))
}

func (b *backend) renameZone(w http.ResponseWriter, r *http.Request, path params, request httpbody.Body) {
	scoped := scopedAccess()
	session, authFailure := b.zoneBearer(r)
	if authFailure != nil {
		if !scoped && signedNullPayload(authFailure) {
			message(w, 500, nullPayloadMessage)
		} else {
			message(w, authFailure.Status, authFailure.Message)
		}
		return
	}
	ctx := r.Context()
	owner := session.UserID
	if scoped {
		var failure *zoneFailure
		owner, failure = b.scopedZoneOwner(ctx, session, path["id"])
		if failure != nil {
			message(w, failure.status, failure.text)
			return
		}
	}
	id, valid := zoneIntegerID(path["id"])
	if !valid {
		message(w, 400, "Invalid zone ID")
		return
	}
	name, reason := normalizeZoneName(request.Value.Get("name"))
	if reason != "" {
		zoneNameFailure(w, reason, false)
		return
	}

	var zoneUUID storedValue
	var version float64
	var changed bool
	err := b.db.withImmediateTx(ctx, func(tx *farmConn) error {
		row := tx.QueryRowContext(ctx, `SELECT zone_uuid, name, COALESCE(sync_version,0) FROM irrigation_zones
			WHERE id=? AND user_id=? AND deleted_at IS NULL LIMIT 1`, id, owner)
		// osi-entity-name renameZoneInTransaction: row.name === name is strict,
		// so a BLOB name (a Buffer) is always renamed, and TEXT compares as
		// its decoded string. The response echoes row.zone_uuid as read.
		var previous storedValue
		if err := row.Scan(&zoneUUID, &previous, &version); err != nil {
			return err
		}
		changed = !previous.is(name)
		if !changed {
			return nil
		}
		_, err := tx.ExecContext(ctx, `UPDATE irrigation_zones SET name=?, updated_at=?,
			sync_version=COALESCE(sync_version,0)+1 WHERE id=?`, name, timestamp(), id)
		version++
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		message(w, 404, "Zone not found")
		return
	}
	if err != nil {
		message(w, 500, zoneDBMessage(err))
		return
	}
	p := jsvalue.Property
	respond(w, 200, p("id", jsvalue.Num(id)), p("zone_uuid", zoneUUID.json()), p("name", jsvalue.Str(name)),
		p("sync_version", jsvalue.Num(version)), p("changed", jsvalue.Bool(changed)))
}

// The rule is shared by the JS REST and command writers. Count code points
// after trimming, while rejecting lone UTF-16 surrogates before conversion.
func normalizeZoneName(raw jsvalue.Value) (string, string) {
	if raw.Kind == jsvalue.Undefined || raw.Kind == jsvalue.Null {
		return "", "name_empty"
	}
	if raw.Kind != jsvalue.String {
		return "", "name_invalid_unicode"
	}
	for i := 0; i < len(raw.Text); i++ {
		unit := rune(raw.Text[i])
		if utf16.IsSurrogate(unit) {
			if i+1 == len(raw.Text) || utf16.DecodeRune(unit, rune(raw.Text[i+1])) == utf8.RuneError {
				return "", "name_invalid_unicode"
			}
			i++
		}
	}
	name := raw.TrimmedString().MustString()
	if name == "" {
		return "", "name_empty"
	}
	if utf8.RuneCountInString(name) > 100 {
		return "", "name_too_long"
	}
	for _, r := range name {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) || r == '\u2028' || r == '\u2029' {
			return "", "name_control_characters"
		}
	}
	return name, ""
}

func zoneNameFailure(w http.ResponseWriter, reason string, create bool) {
	text := "Zone name is not valid"
	if create && reason == "name_empty" {
		text = "Zone name is required"
	}
	respond(w, 400, jsvalue.Property("message", jsvalue.Str(text)), jsvalue.Property("reason", jsvalue.Str(reason)))
}

func queryZones(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*farmRows, error)
}, query string, args ...any) ([]jsvalue.Value, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	values, dest := make([]any, len(columns)), make([]any, len(columns))
	for i := range dest {
		dest[i] = &values[i]
	}
	var result []jsvalue.Value
	for rows.Next() {
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		fields := make([]jsvalue.Field, len(columns))
		for i, name := range columns {
			fields[i] = jsvalue.Property(name, zoneSQLValue(values[i]))
		}
		result = append(result, jsvalue.Obj(fields...))
	}
	return result, rows.Err()
}

func zoneSQLValue(value any) jsvalue.Value {
	switch v := value.(type) {
	case nil:
		return jsvalue.Nil()
	case string:
		return jsvalue.Str(v)
	case int64:
		return jsvalue.Num(float64(v))
	case float64:
		return jsvalue.Num(v)
	case []byte:
		data := make([]jsvalue.Value, len(v))
		for i, n := range v {
			data[i] = jsvalue.Num(float64(n))
		}
		return jsvalue.Obj(jsvalue.Property("type", jsvalue.Str("Buffer")), jsvalue.Property("data", jsvalue.Arr(data...)))
	case time.Time:
		// modernc may scan columns declared DATETIME as time.Time.
		return jsvalue.Str(v.Format("2006-01-02T15:04:05.000Z07:00"))
	default:
		panic(fmt.Sprintf("unexpected SQLite value %T", value))
	}
}

func zoneFallback(v, fallback jsvalue.Value) jsvalue.Value {
	if v.Truthy() {
		return v
	}
	return fallback
}

func zoneNullableNumber(v jsvalue.Value) jsvalue.Value {
	if v.Kind == jsvalue.Null || v.Kind == jsvalue.Undefined {
		return jsvalue.Nil()
	}
	return jsvalue.Num(v.MustNumber())
}

func zoneNumberOrZero(v jsvalue.Value) jsvalue.Value {
	return jsvalue.Num(zoneFallback(v, jsvalue.Num(0)).MustNumber())
}

func zoneDBMessage(err error) string {
	var dbError *sqlite.Error
	if !errors.As(err, &dbError) {
		return err.Error()
	}
	label := sqlite.ErrorCodeString[dbError.Code()&255]
	i := strings.LastIndex(label, "(SQLITE_")
	if i < 0 {
		return dbError.Error()
	}
	code := strings.TrimSuffix(label[i+1:], ")")
	text := strings.TrimSuffix(dbError.Error(), " ("+code+")")
	text = strings.TrimSuffix(text, fmt.Sprintf(" (%d)", dbError.Code()))
	if _, detail, ok := strings.Cut(text, ": "); ok {
		text = detail
	}
	return code + ": " + text
}
