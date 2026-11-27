package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jstimezone"
	"osi-edge/internal/jsvalue"
)

func init() {
	registerWithCatch("GET", "/api/system/settings", (*backend).getSystemSettings, settingsCoercionCatch)
	registerWithCatch("PUT", "/api/system/settings", (*backend).putSystemSettings, settingsCoercionCatch)
}

type moduleSetting struct {
	field       string
	key         string
	autoDefault bool
	shipped     bool
}

var moduleSettings = []moduleSetting{
	{field: "dataModuleEnabled", key: "data_module_enabled", shipped: true},
	{field: "networkModuleEnabled", key: "network_module_enabled", autoDefault: true},
	{field: "gatewayHubModuleEnabled", key: "gateway_hub_module_enabled", shipped: true},
	{field: "journalModuleEnabled", key: "journal_module_enabled", shipped: true},
}

func moduleDefaults() jsvalue.Value {
	fields := make([]jsvalue.Field, 0, len(moduleSettings))
	for _, m := range moduleSettings {
		fields = append(fields, jsvalue.Property(m.field, jsvalue.Bool(m.shipped)))
	}
	return jsvalue.Obj(fields...)
}

func moduleOffValue(text string) bool {
	switch jsvalue.Lower(jsvalue.Trim(text)) {
	case "0", "false", "off", "no":
		return true
	}
	return false
}

func interpretStoredModule(m moduleSetting, stored bool, fieldTesterPresent bool) bool {
	if !stored {
		if m.autoDefault {
			return fieldTesterPresent
		}
		return m.shipped
	}
	return true
}

func settingsRespond(w http.ResponseWriter, status int, fields ...jsvalue.Field) {
	headers := w.Header()
	headers.Set("Access-Control-Allow-Origin", "*")
	headers.Set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
	sendJSON(w, status, jsvalue.Obj(fields...))
}

type settingsError struct {
	status  int
	code    string
	message string
}

func (e *settingsError) fields() []jsvalue.Field {
	status := e.status
	code := e.code
	message := e.message
	if status == 500 {
		code = "internal_error"
		message = "System settings request failed"
	} else if code == "" {
		code = "error"
	}
	return []jsvalue.Field{
		jsvalue.Property("error", jsvalue.Str(code)),
		jsvalue.Property("message", jsvalue.Str(message)),
	}
}

func (b *backend) settingsSession(w http.ResponseWriter, r *http.Request) (auth.Session, bool) {
	secret := configuredAuthSecret()
	if secret == "" {
		_, secret = existingAuthSecret(authSecretPaths())
	}
	if secret == "" {
		problem := settingsError{503, "auth_unavailable", "System settings authentication is unavailable"}
		settingsRespond(w, problem.status, problem.fields()...)
		return auth.Session{}, false
	}
	payload, failure := auth.VerifyBearerPayload(r.Header.Get("Authorization"),
		func() (string, error) { return secret, nil })
	if failure == nil {
		if session, ok := validateSettingsClaims(payload); ok {
			return session, true
		}
	}
	problem := settingsError{401, "unauthorized", "Unauthorized"}
	settingsRespond(w, problem.status, problem.fields()...)
	return auth.Session{}, false
}

func validateSettingsClaims(payload jsvalue.Value) (auth.Session, bool) {
	userID, err := payload.Get("userId").CoerceNumber()
	if err != nil {
		return auth.Session{}, false
	}
	username, err := payload.Get("username").OrEmpty().CoerceTrimmedString()
	if err != nil {
		return auth.Session{}, false
	}
	exp, err := payload.Get("exp").OrEmpty().CoerceNumber()
	if err != nil {
		return auth.Session{}, false
	}
	if userID <= 0 || math.IsInf(userID, 0) || math.Trunc(userID) != userID ||
		len(username.Text) == 0 || len(username.Text) > 120 ||
		math.IsNaN(exp) || math.IsInf(exp, 0) || exp <= 0 || float64(time.Now().UnixMilli()) > exp {
		return auth.Session{}, false
	}
	return auth.Session{UserID: userID, Username: username, Expiration: exp}, true
}

func validateTimezone(value jsvalue.Value, label string) (string, *settingsError) {
	raw, err := value.OrEmpty().CoerceString()
	if err != nil {
		return "", &settingsError{status: 500, message: err.Error()}
	}
	text := jsvalue.Trim(raw)
	if text == "" {
		return "", &settingsError{status: 422, code: "invalid_timezone", message: label + " is required"}
	}
	if jstimezone.Canonical(text) == "" {
		return "", &settingsError{status: 422, code: "invalid_timezone", message: label + " must be a valid IANA time zone"}
	}
	return text, nil
}

// readGatewayTimezone is `(row && row.value) || 'UTC'`, as read: a BLOB setting
// is a truthy Buffer, answered as Buffer JSON and bound back as a BLOB.
func (b *backend) readGatewayTimezone(ctx context.Context) storedValue {
	var value storedValue
	err := b.db.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key = 'gateway_timezone'").Scan(&value)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) && !settingsTableMissing(err) {
			log.Printf("[sys-settings] gateway_timezone read failed: %v", err)
		}
		return storedTimezoneUTC
	}
	return timezoneChain(value)
}

func (b *backend) readFieldTesterPresent(ctx context.Context) bool {
	var present int
	err := b.db.QueryRowContext(ctx, "SELECT 1 AS present FROM devices WHERE type_id='RAK10701_FIELD_TESTER' AND deleted_at IS NULL LIMIT 1").Scan(&present)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("[sys-settings] field tester presence read failed: %v", err)
		}
		return false
	}
	return present == 1
}

func (b *backend) readModuleSettings(ctx context.Context, fieldTesterPresent bool) []jsvalue.Field {
	fields := make([]jsvalue.Field, 0, len(moduleSettings))
	for _, m := range moduleSettings {
		var raw sql.NullString
		err := b.db.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key = ?", m.key).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) && !settingsTableMissing(err) {
			log.Printf("[sys-settings] %s read failed: %v", m.key, err)
		}
		enabled := interpretStoredModule(m, false, fieldTesterPresent)
		if err == nil && raw.Valid {
			enabled = !moduleOffValue(raw.String)
		}
		fields = append(fields, jsvalue.Property(m.field, jsvalue.Bool(enabled)))
	}
	return fields
}

type moduleWrite struct {
	setting moduleSetting
	text    string
	boolean bool
}

func collectModuleWrites(body jsvalue.Value) ([]moduleWrite, *settingsError) {
	var writes []moduleWrite
	if body.Kind != jsvalue.Object {
		return writes, nil
	}
	for _, m := range moduleSettings {
		value, present := objectField(body, m.field)
		if !present {
			continue
		}
		if value.Kind == jsvalue.Boolean {
			writes = append(writes, moduleWrite{setting: m, boolean: value.Bool})
			continue
		}
		if value.Kind == jsvalue.String && string(utf16.Decode(value.Text)) == "auto" && m.autoDefault {
			writes = append(writes, moduleWrite{setting: m, text: "auto"})
			continue
		}
		return nil, &settingsError{status: 422, code: "invalid_request", message: m.field + " must be a boolean"}
	}
	return writes, nil
}

func objectField(v jsvalue.Value, key string) (jsvalue.Value, bool) {
	for _, field := range v.Fields {
		if string(utf16.Decode(field.Key)) == key {
			return field.Value, true
		}
	}
	return jsvalue.Value{}, false
}

func (b *backend) getSystemSettings(w http.ResponseWriter, r *http.Request, _ params, _ httpbody.Body) {
	if _, ok := b.settingsSession(w, r); !ok {
		return
	}
	ctx := r.Context()
	fieldTesterPresent := b.readFieldTesterPresent(ctx)
	gatewayTimezone := b.readGatewayTimezone(ctx)
	modules := b.readModuleSettings(ctx, fieldTesterPresent)
	fields := append([]jsvalue.Field{
		jsvalue.Property("gatewayTimezone", gatewayTimezone.json()),
		jsvalue.Property("moduleDefaults", moduleDefaults()),
	}, modules...)
	settingsRespond(w, 200, fields...)
}

func (b *backend) assertSettingsAdmin(ctx context.Context, session auth.Session) *settingsError {
	// osi-scope-helper assertAuthenticatedRole: `!user.user_uuid` and
	// `user.disabled_at` are JS truthiness (a Buffer is truthy, even empty),
	// and `user.role !== 'admin'` holds for anything but the TEXT value.
	var role, userUUID, disabled storedValue
	err := b.db.QueryRowContext(ctx, "SELECT role, disabled_at, user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1",
		session.UserID, session.Username.MustString()).Scan(&role, &disabled, &userUUID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return &settingsError{status: 500, message: "authorization database read failed"}
	}
	if errors.Is(err, sql.ErrNoRows) || !userUUID.truthy() {
		return &settingsError{status: 401, message: "Unauthorized"}
	}
	if disabled.truthy() {
		return &settingsError{status: 403, message: "account disabled"}
	}
	if !role.is("admin") {
		return &settingsError{status: 403, message: "insufficient role"}
	}
	return nil
}

func (b *backend) putSystemSettings(w http.ResponseWriter, r *http.Request, _ params, body httpbody.Body) {
	session, ok := b.settingsSession(w, r)
	if !ok {
		return
	}
	if scopedAccess() {
		if problem := b.assertSettingsAdmin(r.Context(), session); problem != nil {
			settingsRespond(w, problem.status, problem.fields()...)
			return
		}
	}
	if r.ContentLength > 256*1024 {
		problem := settingsError{413, "body_too_large", "Request body exceeds 256 KiB"}
		settingsRespond(w, problem.status, problem.fields()...)
		return
	}
	ctx := r.Context()
	fieldTesterPresent := b.readFieldTesterPresent(ctx)
	moduleWrites, problem := collectModuleWrites(body.Value)
	if problem != nil {
		settingsRespond(w, problem.status, problem.fields()...)
		return
	}
	_, hasTimezone := objectField(body.Value, "gatewayTimezone")
	var gatewayTimezone storedValue
	if len(moduleWrites) > 0 && !hasTimezone {
		gatewayTimezone = b.readGatewayTimezone(ctx)
	} else {
		validated, tzErr := validateTimezone(body.Value.Get("gatewayTimezone"), "gatewayTimezone")
		gatewayTimezone = storedOf(validated)
		if tzErr != nil {
			if tzErr.status == 500 {
				log.Printf("[sys-settings] PUT failed: %s", tzErr.message)
			}
			settingsRespond(w, tzErr.status, tzErr.fields()...)
			return
		}
	}
	writeTimezone := hasTimezone || len(moduleWrites) == 0
	applyAll := body.Value.Get("applyToAllZones")
	applyToAllZones := applyAll.Kind == jsvalue.Boolean && applyAll.Bool
	now := timestamp()

	b.writes.RLock()
	defer b.writes.RUnlock()
	if writeTimezone {
		_, err := b.db.ExecContext(ctx,
			"INSERT INTO app_settings(key, value, updated_at) VALUES ('gateway_timezone', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
			gatewayTimezone.bindJS(), now)
		if err != nil {
			b.settingsWriteFailed(w, err)
			return
		}
	}
	for _, write := range moduleWrites {
		if write.text == "auto" {
			_, err := b.db.ExecContext(ctx, "DELETE FROM app_settings WHERE key = ?", write.setting.key)
			if err != nil {
				b.settingsWriteFailed(w, err)
				return
			}
			continue
		}
		stored := "0"
		if write.boolean {
			stored = "1"
		}
		_, err := b.db.ExecContext(ctx,
			"INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
			write.setting.key, stored, now)
		if err != nil {
			b.settingsWriteFailed(w, err)
			return
		}
	}
	zonesUpdated := 0
	if applyToAllZones {
		count, err := b.applyTimezoneToZones(ctx, session.UserID, gatewayTimezone, now)
		if err != nil {
			log.Printf("[sys-settings] PUT failed: %v", err)
			settingsRespond(w, 500, (&settingsError{status: 500}).fields()...)
			return
		}
		zonesUpdated = count
	}
	modules := b.readModuleSettings(ctx, fieldTesterPresent)
	fields := append([]jsvalue.Field{
		jsvalue.Property("gatewayTimezone", gatewayTimezone.json()),
		jsvalue.Property("zonesUpdated", jsvalue.Num(float64(zonesUpdated))),
		jsvalue.Property("moduleDefaults", moduleDefaults()),
	}, modules...)
	settingsRespond(w, 200, fields...)
}

func (b *backend) settingsWriteFailed(w http.ResponseWriter, err error) {
	if settingsTableMissing(err) {
		settingsRespond(w, 503,
			jsvalue.Property("error", jsvalue.Str("schema_pending")),
			jsvalue.Property("message", jsvalue.Str("Gateway settings are not available yet; run the pending migration")),
		)
		return
	}
	log.Printf("[sys-settings] PUT failed: %v", err)
	settingsRespond(w, 500, (&settingsError{status: 500}).fields()...)
}

func settingsTableMissing(err error) bool {
	return strings.Contains(err.Error(), "no such table: app_settings")
}

// applyTimezoneToZones binds the timezone as the PUT holds it: a module-only
// PUT re-reads the stored setting, so a BLOB setting is written to the zones
// as a BLOB.
func (b *backend) applyTimezoneToZones(ctx context.Context, userID float64, setting storedValue, now string) (int, error) {
	gatewayTimezone := setting.bindJS()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var count int64
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) AS c FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL AND timezone <> ?",
		userID, gatewayTimezone).Scan(&count); err != nil {
		return 0, err
	}
	if count > 0 {
		if _, err := tx.ExecContext(ctx,
			"UPDATE irrigation_zones SET timezone = ?, updated_at = ?, sync_version = COALESCE(sync_version,0)+1 WHERE user_id = ? AND deleted_at IS NULL AND timezone <> ?",
			gatewayTimezone, now, userID, gatewayTimezone); err != nil {
			return 0, err
		}
	}
	return int(count), tx.Commit()
}
