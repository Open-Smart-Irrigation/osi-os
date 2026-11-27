package main

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/chirpstack/chirpstack/api/go/v4/api"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsvalue"
)

func init() {
	register("POST", "/api/devices", (*backend).claimDevice)
	register("PUT", "/api/devices/:deveui/name", (*backend).renameDevice)
}

const entityNameMaxCodePoints = 100

func nameTrimSpace(unit uint16) bool {
	switch unit {
	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return unit >= 0x2000 && unit <= 0x200a
}

func nameControlCharacter(unit uint16) bool {
	return unit <= 0x1f || unit >= 0x7f && unit <= 0x9f || unit == 0x2028 || unit == 0x2029
}

type entityNameError struct {
	code string
}

func (e *entityNameError) body() []jsvalue.Field {
	return []jsvalue.Field{
		jsvalue.Property("message", jsvalue.Str("Device name is not valid")),
		jsvalue.Property("reason", jsvalue.Str(e.code)),
	}
}

func hasLoneSurrogate(text []uint16) bool {
	for i := 0; i < len(text); i++ {
		unit := text[i]
		if unit >= 0xd800 && unit <= 0xdbff {
			next := uint16(0)
			if i+1 < len(text) {
				next = text[i+1]
			}
			if next < 0xdc00 || next > 0xdfff {
				return true
			}
			i++
		} else if unit >= 0xdc00 && unit <= 0xdfff {
			return true
		}
	}
	return false
}

func utf16CodePoints(units []uint16) int {
	count := 0
	for i := 0; i < len(units); i++ {
		if units[i] >= 0xd800 && units[i] <= 0xdbff && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
			i++
		}
		count++
	}
	return count
}

func normalizeEntityName(raw jsvalue.Value) (string, *entityNameError) {
	if raw.Kind == jsvalue.Undefined || raw.Kind == jsvalue.Null {
		return "", &entityNameError{code: "name_empty"}
	}
	if raw.Kind != jsvalue.String {
		return "", &entityNameError{code: "name_invalid_unicode"}
	}
	text := raw.Text
	if hasLoneSurrogate(text) {
		return "", &entityNameError{code: "name_invalid_unicode"}
	}
	start, end := 0, len(text)
	for start < end && nameTrimSpace(text[start]) {
		start++
	}
	for end > start && nameTrimSpace(text[end-1]) {
		end--
	}
	trimmed := text[start:end]
	if len(trimmed) == 0 {
		return "", &entityNameError{code: "name_empty"}
	}
	if utf16CodePoints(trimmed) > entityNameMaxCodePoints {
		return "", &entityNameError{code: "name_too_long"}
	}
	for _, unit := range trimmed {
		if nameControlCharacter(unit) {
			return "", &entityNameError{code: "name_control_characters"}
		}
	}
	return string(utf16.Decode(trimmed)), nil
}

type scopeProblem struct {
	status  int
	message string
}

func (p *scopeProblem) publicMessage() string {
	if p.status == 404 {
		return "Device not found"
	}
	if p.status == 403 {
		return "Forbidden"
	}
	return p.message
}

func scopeRespond(w http.ResponseWriter, problem *scopeProblem) {
	respond(w, problem.status, jsvalue.Property("message", jsvalue.Str(problem.publicMessage())))
}

// scopeUser is osi-scope-helper loadUser's row. role keeps its storage class:
// the helpers compare it with === and canMutate's Set.has.
type scopeUser struct {
	id       int64
	role     storedValue
	disabled bool
}

// scopeQuerier is *farmDB, *farmTx or *farmConn.
type scopeQuerier = scheduleQueryer

// loadScopeUser is osi-scope-helper loadUser: `if (!userUuid)` throws 500,
// the uuid is bound back with its storage class (a Buffer binds as a BLOB),
// and disabled is Boolean(user.disabled_at).
func loadScopeUser(ctx context.Context, db scopeQuerier, userUUID storedValue) (scopeUser, *scopeProblem) {
	if !userUUID.truthy() {
		return scopeUser{}, &scopeProblem{500, "resolveScope called without user_uuid"}
	}
	var id storedValue
	var role, disabled storedValue
	err := db.QueryRowContext(ctx, "SELECT id, role, disabled_at FROM users WHERE user_uuid = ?", userUUID.arg()).Scan(&id, &role, &disabled)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return scopeUser{}, &scopeProblem{403, "unknown user"}
		}
		return scopeUser{}, &scopeProblem{500, zoneDBMessage(err)}
	}
	userID, _ := id.raw.(int64)
	return scopeUser{id: userID, role: role, disabled: disabled.truthy()}, nil
}

func (b *backend) loadScopeUser(ctx context.Context, userUUID storedValue) (scopeUser, *scopeProblem) {
	return loadScopeUser(ctx, b.db, userUUID)
}

func (b *backend) assertEnabledAccount(ctx context.Context, userUUID storedValue) *scopeProblem {
	scope, err := b.resolveScope(ctx, userUUID)
	if errors.Is(err, sql.ErrNoRows) {
		return &scopeProblem{403, "unknown user"}
	}
	if err != nil {
		return &scopeProblem{500, zoneDBMessage(err)}
	}
	if scope.disabled {
		return &scopeProblem{403, "account disabled"}
	}
	return nil
}

// assertFreshRole: account disabled, then scope.role !== role.
func assertFreshRole(ctx context.Context, db scopeQuerier, userUUID, role storedValue) (scopeUser, *scopeProblem) {
	user, problem := loadScopeUser(ctx, db, userUUID)
	if problem != nil {
		return user, problem
	}
	if user.disabled {
		return user, &scopeProblem{403, "account disabled"}
	}
	if !storedStrictEqual(user.role, role) {
		return user, &scopeProblem{403, "insufficient role"}
	}
	return user, nil
}

func (b *backend) assertFreshRole(ctx context.Context, userUUID, role storedValue) (scopeUser, *scopeProblem) {
	return assertFreshRole(ctx, b.db, userUUID, role)
}

// scopeCanMutate is canMutate: a Set of the two role strings.
func scopeCanMutate(role storedValue) bool {
	return role.is("admin") || role.is("researcher")
}

// zoneScopeKeys is loadScope's zoneUuids Set, keyed as Set.has compares.
func zoneScopeKeys(ctx context.Context, db scopeQuerier, user scopeUser, userUUID storedValue) (map[string]bool, *scopeProblem) {
	zones := make(map[string]bool)
	for _, q := range []struct {
		query string
		arg   any
	}{
		{`SELECT zone_uuid FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL AND zone_uuid IS NOT NULL`, user.id},
		{`SELECT zone_uuid FROM user_zone_assignments WHERE user_uuid = ? AND deleted_at IS NULL`, userUUID.arg()},
	} {
		if err := addZoneScopeKeys(ctx, db, q.query, q.arg, zones); err != nil {
			return nil, &scopeProblem{500, zoneDBMessage(err)}
		}
	}
	return zones, nil
}

// addZoneScopeKeys reads one zone_uuid list into keys. The deferred Close
// releases the shared connection on every exit, a recovered panic included.
func addZoneScopeKeys(ctx context.Context, db scopeQuerier, query string, arg any, keys map[string]bool) error {
	rows, err := db.QueryContext(ctx, query, arg)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var uuid storedValue
		if err := rows.Scan(&uuid); err != nil {
			return err
		}
		if key, ok := uuid.key(); ok {
			keys[key] = true
		}
	}
	return rows.Err()
}

func scopeKeyHas(keys map[string]bool, value storedValue) bool {
	key, ok := value.key()
	return ok && keys[key]
}

func assertFreshZoneAccess(ctx context.Context, db scopeQuerier, userUUID, zoneUUID storedValue) (scopeUser, *scopeProblem) {
	user, problem := loadScopeUser(ctx, db, userUUID)
	if problem != nil {
		return user, problem
	}
	if user.disabled {
		return user, &scopeProblem{403, "account disabled"}
	}
	zones, problem := zoneScopeKeys(ctx, db, user, userUUID)
	if problem != nil {
		return user, problem
	}
	if !scopeKeyHas(zones, zoneUUID) {
		return user, &scopeProblem{404, "zone not found"}
	}
	return user, nil
}

func (b *backend) assertFreshZoneAccess(ctx context.Context, userUUID, zoneUUID storedValue) *scopeProblem {
	_, problem := assertFreshZoneAccess(ctx, b.db, userUUID, zoneUUID)
	return problem
}

// assertFreshDeviceAccess (without allowUnassignedOwner): device not found,
// then the account, then weather stations, then zone membership.
func assertFreshDeviceAccess(ctx context.Context, db scopeQuerier, userUUID storedValue, deveui string) (scopeUser, *scopeProblem) {
	var typeID, zoneUUID storedValue
	var zoneID sql.NullInt64
	err := db.QueryRowContext(ctx,
		`SELECT d.type_id, d.irrigation_zone_id, iz.zone_uuid
		   FROM devices d LEFT JOIN irrigation_zones iz
		     ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
		  WHERE d.deveui = ? AND d.deleted_at IS NULL`, deveui).Scan(&typeID, &zoneID, &zoneUUID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return scopeUser{}, &scopeProblem{404, "device not found"}
		}
		return scopeUser{}, &scopeProblem{500, zoneDBMessage(err)}
	}
	user, problem := loadScopeUser(ctx, db, userUUID)
	if problem != nil {
		return user, problem
	}
	if user.disabled {
		return user, &scopeProblem{403, "account disabled"}
	}
	if typeID.is("SENSECAP_S2120") || typeID.is("AQUASCOPE_LORAIN") {
		return user, nil
	}
	if !zoneUUID.truthy() {
		return user, &scopeProblem{404, "device not found"}
	}
	zones, problem := zoneScopeKeys(ctx, db, user, userUUID)
	if problem != nil {
		return user, problem
	}
	if !scopeKeyHas(zones, zoneUUID) {
		return user, &scopeProblem{404, "device not found"}
	}
	return user, nil
}

func (b *backend) assertFreshDeviceAccess(ctx context.Context, userUUID storedValue, deveui string) (scopeUser, *scopeProblem) {
	return assertFreshDeviceAccess(ctx, b.db, userUUID, deveui)
}

// resolveZoneUuidById: `row && row.zone_uuid ? row.zone_uuid : null`.
func (b *backend) resolveZoneUUIDByID(ctx context.Context, zoneID any) (storedValue, bool) {
	var uuid storedValue
	err := b.db.QueryRowContext(ctx, "SELECT zone_uuid FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL", zoneID).Scan(&uuid)
	if err != nil || !uuid.truthy() {
		return storedValue{}, false
	}
	return uuid, true
}

var validDeviceTypes = map[string]bool{
	"KIWI_SENSOR": true, "STREGA_VALVE": true, "DRAGINO_LSN50": true, "TEKTELIC_CLOVER": true,
	"SENSECAP_S2120": true, "AQUASCOPE_LORAIN": true, "MILESIGHT_UC512": true, "DRAGINO_SDI12": true,
	"RAK10701_FIELD_TESTER": true,
}

func deviceApplicationID(typeID string) string {
	switch typeID {
	case "STREGA_VALVE", "MILESIGHT_UC512":
		return jsvalue.Trim(os.Getenv("CHIRPSTACK_APP_ACTUATORS"))
	case "RAK10701_FIELD_TESTER":
		return jsvalue.Trim(os.Getenv("CHIRPSTACK_APP_FIELD_TESTER"))
	case "KIWI_SENSOR", "DRAGINO_LSN50", "TEKTELIC_CLOVER", "SENSECAP_S2120", "AQUASCOPE_LORAIN", "DRAGINO_SDI12":
		return jsvalue.Trim(os.Getenv("CHIRPSTACK_APP_SENSORS"))
	}
	return ""
}

func deviceProfileID(typeID string) string {
	var env string
	switch typeID {
	case "KIWI_SENSOR":
		env = "CHIRPSTACK_PROFILE_KIWI"
	case "STREGA_VALVE":
		env = "CHIRPSTACK_PROFILE_STREGA"
	case "DRAGINO_LSN50":
		env = "CHIRPSTACK_PROFILE_LSN50"
	case "TEKTELIC_CLOVER":
		env = "CHIRPSTACK_PROFILE_CLOVER"
	case "SENSECAP_S2120":
		env = "CHIRPSTACK_PROFILE_S2120"
	case "AQUASCOPE_LORAIN":
		env = "CHIRPSTACK_PROFILE_LORAIN"
	case "MILESIGHT_UC512":
		env = "CHIRPSTACK_PROFILE_UC512"
	case "DRAGINO_SDI12":
		env = "CHIRPSTACK_PROFILE_SDI12"
	case "RAK10701_FIELD_TESTER":
		env = "CHIRPSTACK_PROFILE_RAK10701"
	default:
		return ""
	}
	return jsvalue.Trim(os.Getenv(env))
}

func hex32(text string) bool {
	if len(text) != 32 {
		return false
	}
	for _, r := range text {
		if !strings.ContainsRune("0123456789ABCDEF", r) {
			return false
		}
	}
	return true
}

func (b *backend) claimDevice(w http.ResponseWriter, r *http.Request, _ params, body httpbody.Body) {
	zoneID, actorUUID, ok := b.scopedClaimGuard(w, r, body.Value)
	if !ok {
		return
	}
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		deviceAPIFailure(w, failure)
		return
	}
	bodyValue := body.Value
	rawEUI, rawKey := bodyValue.Get("deveui").OrEmpty(), bodyValue.Get("appkey").OrEmpty()

	deveui, appkey := upperTrim(rawEUI.MustString()), upperTrim(rawKey.MustString())
	name := bodyValue.Get("name")
	rawType := bodyValue.Get("type_id")
	if deveui == "" || !name.Truthy() || !rawType.Truthy() {
		message(w, 400, "Missing required fields: deveui, name, type_id")
		return
	}
	typeID := jsOrText(rawType)
	if !validDeviceTypes[typeID] {
		message(w, 400, "Invalid type_id")
		return
	}
	stregaGeneration := ""
	if typeID == "STREGA_VALVE" {
		rawGeneration := bodyValue.Get("strega_generation").OrEmpty()
		stregaGeneration = upperTrim(rawGeneration.MustString())
	}
	if stregaGeneration != "" && stregaGeneration != "GEN1" && stregaGeneration != "GEN2" {
		message(w, 400, "strega_generation must be GEN1 or GEN2")
		return
	}
	normalizedName, nameProblem := normalizeEntityName(name)
	if nameProblem != nil {
		respond(w, 400, nameProblem.body()...)
		return
	}
	// post-devices-auth splices the username after its field checks (the
	// scoped router before it binds); check-existing-device then splices the
	// DevEUI. Both fail before any ChirpStack call.
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
		log.Printf("post-devices: %v", err)
		message(w, 500, "device-api failed")
		return
	}
	if err := splicedLiteralError(deveui); err != nil {
		deviceAPISQLFailure(w, err)
		return
	}
	existingRows, err := queryValues(ctx, b.db, `SELECT d.id,d.user_id,d.irrigation_zone_id,d.type_id,d.sync_version,
		CAST(d.deleted_at AS TEXT) AS deleted_at,d.gateway_device_eui,vs.strega_generation,
		typeof(d.gateway_device_eui) AS gateway_device_eui_class
		FROM devices d LEFT JOIN valve_settings vs ON vs.device_eui=d.deveui WHERE d.deveui=?`, deveui)
	if err != nil {
		log.Printf("post-devices: %v", err)
		message(w, 500, "device-api failed")
		return
	}
	var existing jsvalue.Value
	if len(existingRows) > 0 {
		existing = existingRows[0]
	}
	b.writes.RLock()
	defer b.writes.RUnlock()
	b.claimDeviceRow(w, ctx, claimInput{
		userID:           userID,
		deveui:           deveui,
		name:             normalizedName,
		typeID:           typeID,
		appkey:           appkey,
		stregaGeneration: stregaGeneration,
		zoneID:           zoneID,
		actorUUID:        actorUUID,
		existing:         existing,
	})
}

func deviceAPICoercionFailure(w http.ResponseWriter) {
	deviceCoercionCatch(w, &jsvalue.JSError{Name: "TypeError", Message: jsvalue.PrimitiveConversionError})
}

func deviceAPIFailure(w http.ResponseWriter, failure *auth.AuthError) {
	if failure.Coercion {
		deviceAPICoercionFailure(w)
		return
	}
	if signedNullPayload(failure) {
		// get-devices-auth and post-devices-auth throw the TypeError outside
		// their try; device-api-catch reports err.toString().
		respond(w, 500,
			jsvalue.Property("error", jsvalue.Str("device-api failed")),
			jsvalue.Property("message", jsvalue.Str("TypeError: "+nullPayloadMessage)),
		)
		return
	}
	if failure.Status == 401 {
		deviceAuth401(w, failure.Message)
		return
	}
	respond(w, 500,
		jsvalue.Property("error", jsvalue.Str("device-api failed")),
		jsvalue.Property("message", jsvalue.Str(failure.Message)),
	)
}

func (b *backend) scopedClaimGuard(w http.ResponseWriter, r *http.Request, body jsvalue.Value) (*float64, string, bool) {
	if !scopedAccess() {
		return nil, "", true
	}
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		respond(w, failure.Status, jsvalue.Property("message", jsvalue.Str(failure.Message)))
		return nil, "", false
	}
	ctx := r.Context()
	var id int64
	var userUUID, role storedValue
	err := b.db.QueryRowContext(ctx,
		"SELECT id, user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1",
		session.UserID, session.Username.MustString()).Scan(&id, &userUUID, &role)
	if err != nil || !userUUID.truthy() {
		message(w, 401, "Unauthorized")
		return nil, "", false
	}
	actorScope, problem := b.assertFreshRole(ctx, userUUID, role)
	if problem != nil {
		scopeRespond(w, problem)
		return nil, "", false
	}
	if !scopeCanMutate(actorScope.role) {
		scopeRespond(w, &scopeProblem{403, "insufficient role"})
		return nil, "", false
	}
	rawEUI := body.Get("deveui").OrEmpty()
	eui, err := rawEUI.CoerceString()
	if err != nil {
		message(w, 500, err.Error())
		return nil, "", false
	}
	deveui := upperTrim(eui)
	if deveui == "" {
		scopeRespond(w, &scopeProblem{400, "Device EUI is required"})
		return nil, "", false
	}
	// targetZoneId = Number(rawZoneId): a double, bound to the zone lookup and
	// later spelled into the claim statement (post-devices-insert).
	var zoneID *float64
	rawZone := body.Get("zone_id")
	if rawZone.Kind != jsvalue.Undefined && rawZone.Kind != jsvalue.Null && !isEmptyString(rawZone) {
		number, err := rawZone.CoerceNumber()
		if err != nil {
			message(w, 500, err.Error())
			return nil, "", false
		}
		if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number {
			scopeRespond(w, &scopeProblem{400, "zone_id must be an integer zone id"})
			return nil, "", false
		}
		zoneUUID, found := b.resolveZoneUUIDByID(ctx, number)
		if !found {
			scopeRespond(w, &scopeProblem{404, "zone not found"})
			return nil, "", false
		}
		if problem := b.assertFreshZoneAccess(ctx, userUUID, zoneUUID); problem != nil {
			scopeRespond(w, problem)
			return nil, "", false
		}
		zoneID = &number
	}
	var existingZoneID sql.NullInt64
	var existingZoneUUID storedValue
	var existingZoneName sql.NullString
	err = b.db.QueryRowContext(ctx,
		"SELECT d.irrigation_zone_id, iz.zone_uuid, iz.name AS current_zone_name FROM devices d "+
			"LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id "+
			"WHERE d.deveui = ? AND d.deleted_at IS NULL", deveui).Scan(&existingZoneID, &existingZoneUUID, &existingZoneName)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		scopeRespond(w, &scopeProblem{500, err.Error()})
		return nil, "", false
	}
	if err == nil && existingZoneUUID.truthy() {
		if _, problem := b.assertFreshDeviceAccess(ctx, userUUID, deveui); problem != nil {
			scopeRespond(w, problem)
			return nil, "", false
		}
	}
	// The guard compares Number(null) with the stored assignment, both as
	// doubles: zone 123456789012345700 equals a requested 123456789012345696.
	requestedZoneID := float64(0)
	if zoneID != nil {
		requestedZoneID = *zoneID
	}
	if err == nil && existingZoneID.Valid && requestedZoneID != float64(existingZoneID.Int64) {
		nameValue := jsvalue.Nil()
		if existingZoneName.String != "" {
			nameValue = jsvalue.Str(existingZoneName.String)
		}
		respond(w, 409,
			jsvalue.Property("message", jsvalue.Str("Device is already assigned to a zone")),
			jsvalue.Property("current_zone_id", jsvalue.Num(float64(existingZoneID.Int64))),
			jsvalue.Property("current_zone_name", nameValue),
		)
		return nil, "", false
	}
	return zoneID, userUUID.jsString(), true
}

// jsOrZero is `n || 0` for a number.
func jsOrZero(n float64) float64 {
	if math.IsNaN(n) {
		return 0
	}
	return n
}

func isEmptyString(v jsvalue.Value) bool {
	return v.Kind == jsvalue.String && len(v.Text) == 0
}

type claimInput struct {
	userID           int64
	deveui           string
	name             string
	typeID           string
	appkey           string
	stregaGeneration string
	zoneID           *float64
	actorUUID        string
	existing         jsvalue.Value
}

func (b *backend) claimDeviceRow(w http.ResponseWriter, ctx context.Context, input claimInput) {
	now := timestamp()
	// post-devices-insert: const gatewayDeviceEui = String(env.get('DEVICE_EUI')
	// || 'UNKNOWN').trim().toUpperCase().
	gatewayEUI := claimGatewayEUI()
	applicationID := deviceApplicationID(input.typeID)
	profileID := deviceProfileID(input.typeID)
	joinEUI := ""
	if input.typeID == "AQUASCOPE_LORAIN" {
		joinEUI = "4943485448592021"
	}
	if applicationID == "" || profileID == "" {
		message(w, 503, "Unsupported device type or missing ChirpStack application/profile mapping")
		return
	}
	if !hex32(input.appkey) {
		message(w, 400, "AppKey is required for LoRa registration and must be 32 hex characters")
		return
	}
	storedGEN2 := false
	if input.existing.Kind == jsvalue.Object && jsOrText(input.existing.Get("strega_generation")) == "GEN2" {
		storedGEN2 = true
	}
	generation := "GEN1"
	if input.stregaGeneration == "GEN2" || storedGEN2 {
		generation = "GEN2"
	}
	if input.typeID == "STREGA_VALVE" && generation == "GEN2" {
		if gen2 := jsvalue.Trim(os.Getenv("CHIRPSTACK_PROFILE_STREGA_GEN2")); gen2 != "" {
			profileID = gen2
		} else {
			log.Printf("[devices] CHIRPSTACK_PROFILE_STREGA_GEN2 unset; registering %s on the Gen1 profile", input.deveui)
		}
	}
	// post-devices-insert spells userId (Number of the looked-up row id), the
	// zone id and the next sync_version into the statement as JS numbers.
	// Each becomes a placeholder bound to what SQLite 3.44 reads from that
	// text (sqliteNumberText); NaN stays in the text and fails as the node's.
	var statementArgs []any
	spell := func(n float64) string {
		text, args := sqliteNumberText(n)
		statementArgs = append(statementArgs, args...)
		return text
	}
	userID := float64(input.userID)
	var action string
	var nextSyncVersion float64
	var effectiveGatewayEUI string
	var statement string
	var effectiveZone *float64
	if input.existing.Kind == jsvalue.Object {
		existingType := jsOrText(input.existing.Get("type_id"))
		if existingType != "" && existingType != input.typeID {
			message(w, 409, "Device exists with different type_id ("+existingType+")")
			return
		}
		// post-devices-insert: existingUserId !== null && Number(existingUserId)
		// !== userId. TEXT '0xA0' or BLOB ' 160' is user 160; 'abc' is NaN.
		existingUser := input.existing.Get("user_id")
		existingOwned := existingUser.Kind != jsvalue.Null && existingUser.Kind != jsvalue.Undefined
		if existingOwned && existingUser.MustNumber() != float64(input.userID) {
			message(w, 409, "Device already claimed by another user")
			return
		}
		// Number(existing.sync_version || 0) + 1: REAL 2.5 gives 3.5, TEXT
		// 'abc' NaN, 123456789012345696 the double 123456789012345700.
		currentVersion := float64(0)
		if version := input.existing.Get("sync_version"); version.Truthy() {
			currentVersion = version.MustNumber()
		}
		nextSyncVersion = currentVersion + 1
		// String(existing.gateway_device_eui || gatewayDeviceEui).trim()
		// .toUpperCase(): the fallback is taken before the trim, so a stored
		// '   ' is truthy and writes ''. A BLOB reads as a Buffer, which is
		// truthy even when empty; String() decodes it as UTF-8.
		effectiveGatewayEUI = gatewayEUI
		stored := input.existing.Get("gateway_device_eui")
		if stored.Truthy() || jsOrText(input.existing.Get("gateway_device_eui_class")) == "blob" {
			effectiveGatewayEUI = upperTrim(stored.MustString())
		}
		if input.zoneID != nil {
			effectiveZone = input.zoneID
		} else if z := input.existing.Get("irrigation_zone_id"); z.Kind == jsvalue.Number {
			id := z.Num
			effectiveZone = &id
		}
		statement = "UPDATE devices SET user_id = " + spell(userID)
		zoneLiteral := "NULL"
		if input.zoneID != nil {
			zoneLiteral = spell(*input.zoneID)
		}
		statement += ", irrigation_zone_id = COALESCE(irrigation_zone_id, " + zoneLiteral + ")" +
			", name = '" + strings.ReplaceAll(input.name, "'", "''") + "'" +
			", gateway_device_eui = '" + strings.ReplaceAll(effectiveGatewayEUI, "'", "''") + "'" +
			", chirpstack_app_id = '" + strings.ReplaceAll(applicationID, "'", "''") + "'" +
			", sync_version = " + spell(nextSyncVersion) +
			", claimed_at = COALESCE(claimed_at, '" + now + "')" +
			", updated_at = '" + now + "'" +
			", deleted_at = NULL" +
			" WHERE deveui = '" + strings.ReplaceAll(input.deveui, "'", "''") + "'"
		if existingOwned {
			action = "updated"
		} else {
			action = "claimed"
		}
	} else {
		nextSyncVersion = 1
		effectiveGatewayEUI = gatewayEUI
		valveState := "NULL"
		if input.typeID == "STREGA_VALVE" {
			valveState = "'CLOSED'"
		}
		zoneLiteral := "NULL"
		userLiteral := spell(userID)
		if input.zoneID != nil {
			zoneLiteral = spell(*input.zoneID)
		}
		statement = "INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,current_state,target_state,gateway_device_eui,chirpstack_app_id,sync_version,deleted_at,created_at,updated_at,claimed_at) VALUES ('" +
			strings.ReplaceAll(input.deveui, "'", "''") + "','" + strings.ReplaceAll(input.name, "'", "''") + "','" + input.typeID + "'," + userLiteral + "," +
			zoneLiteral + "," +
			valveState + "," + valveState + ",'" + strings.ReplaceAll(effectiveGatewayEUI, "'", "''") + "','" + strings.ReplaceAll(applicationID, "'", "''") + "',1,NULL,'" +
			now + "','" + now + "','" + now + "')"
		action = "created"
	}
	radio, err := openValveRadio()
	if err != nil {
		provisioningFailed(w, &provisioningError{err: err, step: "chirpstack"})
		return
	}
	defer radio.conn.Close()
	provisioned, provErr := radio.ensureDeviceProvisioned(ctx, input, profileID, applicationID, joinEUI)
	if provErr == nil {
		if err := b.applyClaim(ctx, input, statement, statementArgs, generation, now); err != nil {
			provErr = &provisioningError{err: errors.New(zoneDBMessage(err)), step: "db"}
		}
	}
	if provErr != nil {
		if provisioned.deviceCreated {
			radio.deleteDeviceBestEffort(context.WithoutCancel(ctx), input.deveui)
		}
		provisioningFailed(w, provErr)
		return
	}
	responseFields := []jsvalue.Field{
		jsvalue.Property("deveui", jsvalue.Str(input.deveui)),
		jsvalue.Property("name", jsvalue.Str(input.name)),
		jsvalue.Property("type_id", jsvalue.Str(input.typeID)),
		jsvalue.Property("last_seen", jsvalue.Str(timestamp())),
		jsvalue.Property("latest_data", jsvalue.Obj()),
	}
	if input.typeID == "STREGA_VALVE" {
		responseFields = append(responseFields,
			jsvalue.Property("current_state", jsvalue.Str("CLOSED")),
			jsvalue.Property("target_state", jsvalue.Str("CLOSED")),
		)
	}
	zoneField := jsvalue.Nil()
	if effectiveZone != nil {
		zoneField = jsvalue.Num(*effectiveZone)
	} else if input.zoneID != nil {
		zoneField = jsvalue.Num(*input.zoneID)
	}
	responseFields = append(responseFields,
		jsvalue.Property("irrigation_zone_id", zoneField),
		jsvalue.Property("irrigation_zone_uuid", jsvalue.Nil()),
		// post-devices-response: flow.get('device_gateway_device_eui') ||
		// String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase(), so
		// the '' a whitespace-only stored EUI writes answers the gateway EUI.
		jsvalue.Property("gateway_device_eui", jsvalue.Str(cmp.Or(effectiveGatewayEUI, claimGatewayEUI()))),
		// Number(flow.get('device_next_sync_version') || 0)
		jsvalue.Property("sync_version", jsvalue.Num(jsOrZero(nextSyncVersion))),
		jsvalue.Property("deleted_at", jsvalue.Nil()),
		jsvalue.Property("provisioned_in_chirpstack", jsvalue.Bool(true)),
		jsvalue.Property("chirpstack", provisioned.wire()),
	)
	status := 200
	if action == "created" {
		status = 201
	}
	respond(w, status, responseFields...)
}

// claimGatewayEUI is String(env.get('DEVICE_EUI') || 'UNKNOWN').trim()
// .toUpperCase(), as post-devices-insert and post-devices-response spell it.
func claimGatewayEUI() string {
	return upperTrim(cmp.Or(os.Getenv("DEVICE_EUI"), "UNKNOWN"))
}

type provisioningError struct {
	err        error
	step       string
	grpcStatus string
}

func (e *provisioningError) message() string {
	if e.err == nil {
		return ""
	}
	return e.err.Error()
}

func provisioningFailed(w http.ResponseWriter, problem *provisioningError) {
	statusCode := 502
	if problem.step == "validate" {
		statusCode = 400
	} else if problem.grpcStatus == "UNAVAILABLE" {
		statusCode = 503
	} else if problem.step == "db" {
		statusCode = 500
	}
	text := "ChirpStack provisioning failed"
	if problem.step == "db" {
		text = "Device registration could not be saved locally"
	}
	respond(w, statusCode,
		jsvalue.Property("message", jsvalue.Str(text)),
		jsvalue.Property("error", jsvalue.Str(problem.message())),
		jsvalue.Property("step", jsvalue.Str(problem.step)),
		jsvalue.Property("grpcStatus", orNil(jsvalue.Str(problem.grpcStatus))),
		jsvalue.Property("verificationRequired", jsvalue.Bool(false)),
	)
}

type provisioningResult struct {
	devEui        string
	deviceCreated bool
	keysAction    string
	profileAction string
	nameAction    string
}

func (p *provisioningResult) wire() jsvalue.Value {
	return jsvalue.Obj(
		jsvalue.Property("devEui", jsvalue.Str(p.devEui)),
		jsvalue.Property("deviceCreated", jsvalue.Bool(p.deviceCreated)),
		jsvalue.Property("deviceExisted", jsvalue.Bool(!p.deviceCreated)),
		jsvalue.Property("keysAction", jsvalue.Str(p.keysAction)),
		jsvalue.Property("profileAction", jsvalue.Str(p.profileAction)),
		jsvalue.Property("nameAction", jsvalue.Str(p.nameAction)),
	)
}

func canonicalStoredKey(value string) string {
	trimmed := jsvalue.Upper(jsvalue.Trim(value))
	if trimmed == "" {
		return strings.Repeat("0", 32)
	}
	return trimmed
}

func euiUpper(value string) string {
	return jsvalue.Upper(jsvalue.Trim(value))
}

var deviceRPCStatusNames = [...]string{
	codes.Canceled:           "CANCELLED",
	codes.Unknown:            "UNKNOWN",
	codes.InvalidArgument:    "INVALID_ARGUMENT",
	codes.DeadlineExceeded:   "DEADLINE_EXCEEDED",
	codes.NotFound:           "NOT_FOUND",
	codes.AlreadyExists:      "ALREADY_EXISTS",
	codes.PermissionDenied:   "PERMISSION_DENIED",
	codes.ResourceExhausted:  "RESOURCE_EXHAUSTED",
	codes.FailedPrecondition: "FAILED_PRECONDITION",
	codes.Aborted:            "ABORTED",
	codes.OutOfRange:         "OUT_OF_RANGE",
	codes.Unimplemented:      "UNIMPLEMENTED",
	codes.Internal:           "INTERNAL",
	codes.Unavailable:        "UNAVAILABLE",
	codes.DataLoss:           "DATA_LOSS",
	codes.Unauthenticated:    "UNAUTHENTICATED",
}

func (radio *valveRadio) rpcError(err error, step string) *provisioningError {
	reply := status.Convert(err)
	name := "UNKNOWN"
	if code := reply.Code(); code < codes.Code(len(deviceRPCStatusNames)) && deviceRPCStatusNames[code] != "" {
		name = deviceRPCStatusNames[code]
	}
	return &provisioningError{
		err:        errors.New(reply.Message()),
		step:       step,
		grpcStatus: name,
	}
}

func (radio *valveRadio) getDevice(ctx context.Context, eui string) (*api.Device, *provisioningError) {
	callCtx, stop := radio.request(ctx)
	reply, err := radio.Get(callCtx, &api.GetDeviceRequest{DevEui: euiUpper(eui)})
	stop()
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, nil
		}
		return nil, radio.rpcError(err, "getDevice")
	}
	return reply.GetDevice(), nil
}

func (radio *valveRadio) setDeviceProfile(ctx context.Context, eui, profileID string) (bool, *provisioningError) {
	existing, problem := radio.getDevice(ctx, eui)
	if problem != nil {
		return false, problem
	}
	if existing == nil {
		return false, nil
	}
	if existing.GetDeviceProfileId() == profileID {
		return false, nil
	}
	existing.DeviceProfileId = profileID
	callCtx, stop := radio.request(ctx)
	_, err := radio.Update(callCtx, &api.UpdateDeviceRequest{Device: existing})
	stop()
	if err != nil {
		return false, radio.rpcError(err, "setDeviceProfile")
	}
	return true, nil
}

func (radio *valveRadio) setDeviceName(ctx context.Context, eui, name, step string, deadline time.Time) (string, *provisioningError) {
	if name == "" {
		return "skipped", nil
	}
	if !deadline.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	existing, problem := radio.getDevice(ctx, eui)
	if problem != nil {
		return "", problem
	}
	if existing == nil {
		return "skipped", nil
	}
	if existing.GetName() == name {
		return "unchanged", nil
	}
	existing.Name = name
	callCtx, stop := radio.request(ctx)
	_, err := radio.Update(callCtx, &api.UpdateDeviceRequest{Device: existing})
	stop()
	if err != nil {
		return "", radio.rpcError(err, step)
	}
	return "updated", nil
}

func (radio *valveRadio) ensureDeviceProvisioned(ctx context.Context, input claimInput, profileID, applicationID, joinEUI string) (*provisioningResult, *provisioningError) {
	devEui := euiUpper(input.deveui)
	appKey := jsvalue.Upper(jsvalue.Trim(input.appkey))
	name := jsvalue.Trim(input.name)
	providedName := name
	result := &provisioningResult{devEui: devEui, keysAction: "unchanged", profileAction: "unchanged", nameAction: "unchanged"}
	if devEui == "" {
		return result, &provisioningError{step: "validate", err: errors.New("DevEUI is required")}
	}
	if applicationID == "" || profileID == "" {
		return result, &provisioningError{step: "validate", err: errors.New("ChirpStack application/profile mapping is incomplete")}
	}
	if !hex32(appKey) {
		return result, &provisioningError{step: "validate", err: errors.New("AppKey must be exactly 32 uppercase hex characters")}
	}
	if appKey == strings.Repeat("0", 32) {
		return result, &provisioningError{step: "validate", err: errors.New("AppKey must not be all zeros")}
	}
	if name == "" {
		name = devEui
	}
	existing, problem := radio.getDevice(ctx, devEui)
	if problem != nil {
		return result, problem
	}
	if existing == nil {
		device := &api.Device{
			DevEui:          devEui,
			Name:            name,
			Description:     "",
			ApplicationId:   applicationID,
			DeviceProfileId: profileID,
			IsDisabled:      false,
		}
		if joinEUI != "" {
			device.JoinEui = jsvalue.Upper(jsvalue.Trim(joinEUI))
		}
		callCtx, stop := radio.request(ctx)
		_, err := radio.Create(callCtx, &api.CreateDeviceRequest{Device: device})
		stop()
		if err != nil {
			if status.Code(err) == codes.AlreadyExists {
				result.deviceCreated = false
			} else {
				return result, radio.rpcError(err, "createDevice")
			}
		} else {
			result.deviceCreated = true
		}
	} else {
		if existing.GetDeviceProfileId() != profileID {
			repointed, problem := radio.setDeviceProfile(ctx, devEui, profileID)
			if problem != nil {
				return result, problem
			}
			if repointed {
				result.profileAction = "repointed"
			}
		}
		if providedName != "" {
			if existing.GetName() == providedName {
				result.nameAction = "unchanged"
			} else {
				outcome, problem := radio.setDeviceName(ctx, devEui, providedName, "ensureDeviceProvisioned", time.Time{})
				if problem != nil {
					return result, problem
				}
				result.nameAction = outcome
			}
		}
	}
	callCtx, stop := radio.request(ctx)
	keysReply, err := radio.GetKeys(callCtx, &api.GetDeviceKeysRequest{DevEui: devEui})
	stop()
	var existingKeys *api.DeviceKeys
	if err != nil {
		if status.Code(err) != codes.NotFound {
			return result, radio.rpcError(err, "getKeys")
		}
	} else {
		existingKeys = keysReply.GetDeviceKeys()
	}
	keySpec := &api.DeviceKeys{DevEui: devEui, NwkKey: appKey}
	if existingKeys == nil {
		callCtx, stop := radio.request(ctx)
		_, err := radio.CreateKeys(callCtx, &api.CreateDeviceKeysRequest{DeviceKeys: keySpec})
		stop()
		if err != nil {
			return result, radio.rpcError(err, "createKeys")
		}
		result.keysAction = "created"
	} else if canonicalStoredKey(existingKeys.GetNwkKey()) != canonicalStoredKey(appKey) ||
		canonicalStoredKey(existingKeys.GetAppKey()) != canonicalStoredKey("") {
		callCtx, stop := radio.request(ctx)
		_, err := radio.UpdateKeys(callCtx, &api.UpdateDeviceKeysRequest{DeviceKeys: keySpec})
		stop()
		if err != nil {
			return result, radio.rpcError(err, "updateKeys")
		}
		result.keysAction = "updated"
	}
	return result, nil
}

func (radio *valveRadio) deleteDeviceBestEffort(ctx context.Context, eui string) {
	callCtx, stop := radio.request(ctx)
	_, err := radio.Delete(callCtx, &api.DeleteDeviceRequest{DevEui: euiUpper(eui)})
	stop()
	if err != nil && status.Code(err) != codes.NotFound {
		log.Printf("chirpstack cleanup: %v", err)
	}
}

func (b *backend) applyClaim(ctx context.Context, input claimInput, statement string, statementArgs []any, generation, now string) error {
	if input.typeID == "STREGA_VALVE" {
		// applyStregaClaim takes dispatch.withValveWriter(eui), whose
		// normalizeDevice throws before the transaction opens.
		if _, err := valveWriterDevice(input.deveui); err != nil {
			return err
		}
	}
	valveWriter.Lock()
	defer valveWriter.Unlock()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	strega := input.typeID == "STREGA_VALVE"
	fence := claimFenceFrom(input.existing, input.typeID)
	before, beforeSettings, err := readClaimState(ctx, tx, input.deveui, strega)
	if err != nil {
		return err
	}
	if strega {
		if problem := assertClaimAuthorization(ctx, tx, input.userID); problem != nil {
			return problem
		}
	}
	if problem := assertClaimFence(fence, before, beforeSettings); problem != nil {
		return problem
	}
	if _, err := tx.ExecContext(ctx, statement, statementArgs...); err != nil {
		return err
	}
	if strega {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO valve_settings (device_eui, strega_generation) VALUES (?, ?) "+
				"ON CONFLICT(device_eui) DO UPDATE SET strega_generation = excluded.strega_generation, updated_at = datetime('now') "+
				"WHERE valve_settings.strega_generation <> excluded.strega_generation AND excluded.strega_generation = 'GEN2'",
			input.deveui, generation); err != nil {
			return err
		}
	}
	after, afterSettings, err := readClaimState(ctx, tx, input.deveui, strega)
	if err != nil {
		return err
	}
	// Number(after.user_id) !== Number(registration.userId)
	if after == nil || after.typeID != input.typeID || after.deletedAt != nil ||
		after.userID.number() != float64(input.userID) {
		return errors.New("claim_write_not_applied")
	}
	if strega && expectedBindingChanged(before, after, beforeSettings, afterSettings) {
		if err := supersedeClaimLifecycle(ctx, tx, input.deveui, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// claimState holds the devices row as node-sqlite3 returns it: the fence
// compares ids with String() and Number(), and the binding check with ===.
type claimState struct {
	id          *int64
	userID      storedValue
	zoneID      storedValue
	deletedAt   *string
	typeID      string
	syncVersion float64 // Number(before.sync_version || 0)
	generation  *string
}

func readClaimState(ctx context.Context, tx *farmTx, eui string, strega bool) (*claimState, *claimState, error) {
	var id sql.NullInt64
	var userID, zoneID storedValue
	var deletedAt, typeID sql.NullString
	var syncVersion storedValue
	err := tx.QueryRowContext(ctx,
		"SELECT id, user_id, irrigation_zone_id, CAST(deleted_at AS TEXT), type_id, sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)", eui).
		Scan(&id, &userID, &zoneID, &deletedAt, &typeID, &syncVersion)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	version := float64(0)
	if syncVersion.truthy() {
		version = syncVersion.number()
	}
	state := &claimState{typeID: typeID.String, syncVersion: version, userID: userID, zoneID: zoneID}
	if id.Valid {
		value := id.Int64
		state.id = &value
	}
	if deletedAt.Valid {
		value := deletedAt.String
		state.deletedAt = &value
	}
	if !strega {
		return state, nil, nil
	}
	var generation sql.NullString
	err = tx.QueryRowContext(ctx, "SELECT strega_generation FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)", eui).Scan(&generation)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, err
	}
	settings := &claimState{}
	if generation.Valid {
		value := generation.String
		settings.generation = &value
	}
	return state, settings, nil
}

type claimFence struct {
	exists           bool
	id               *int64
	typeID           string
	userID           *float64 // existing.user_id == null ? null : Number(existing.user_id)
	zoneID           *float64
	deletedAt        *string
	syncVersion      float64
	stregaGeneration *string
}

func claimFenceFrom(existing jsvalue.Value, typeID string) claimFence {
	if existing.Kind != jsvalue.Object {
		return claimFence{}
	}
	fence := claimFence{exists: true, typeID: jsOrText(existing.Get("type_id"))}
	if id := existing.Get("id"); id.Kind == jsvalue.Number {
		value := int64(id.Num)
		fence.id = &value
	}
	fence.userID = claimFenceNumber(existing.Get("user_id"))
	fence.zoneID = claimFenceNumber(existing.Get("irrigation_zone_id"))
	if deleted := existing.Get("deleted_at"); deleted.Kind == jsvalue.String {
		value := jsOrText(deleted)
		fence.deletedAt = &value
	}
	// claimFence.sync_version: Number(existing.sync_version || 0).
	if version := existing.Get("sync_version"); version.Truthy() {
		fence.syncVersion = version.MustNumber()
	}
	if typeID == "STREGA_VALVE" {
		generation := "GEN1"
		if jsOrText(existing.Get("strega_generation")) == "GEN2" {
			generation = "GEN2"
		}
		fence.stregaGeneration = &generation
	}
	return fence
}

func sameClaimText(left, right *string) bool {
	if left == nil && right == nil {
		return true
	}
	if left == nil || right == nil {
		return false
	}
	return *left == *right
}

func claimFenceNumber(value jsvalue.Value) *float64 {
	if value.Kind == jsvalue.Null || value.Kind == jsvalue.Undefined {
		return nil
	}
	n := value.MustNumber()
	return &n
}

// sameClaimValue is the flows' fence comparison: both null, or
// String(stored) === String(Number(existing)). A TEXT '0xA0' owner reads
// back as '0xA0' against the fence's '160', so the claim is refused.
func sameClaimValue(stored storedValue, fence *float64) bool {
	if !stored.notNull() || fence == nil {
		return !stored.notNull() && fence == nil
	}
	return stored.jsString() == jsvalue.Num(*fence).MustString()
}

// assertClaimAuthorization is claim.js assertAuthorizationTx, which binds
// Number(authorization.userId): the double node-sqlite3 read back for the
// row. User 123456789012345700 passes the spelled gate and is refused here.
func assertClaimAuthorization(ctx context.Context, tx *farmTx, userID int64) error {
	var disabled sql.NullString
	err := tx.QueryRowContext(ctx, "SELECT disabled_at FROM users WHERE id=? LIMIT 1", float64(userID)).Scan(&disabled)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("claim_authorization_changed")
		}
		return err
	}
	if disabled.Valid {
		return errors.New("claim_authorization_changed")
	}
	return nil
}

func assertClaimFence(fence claimFence, before, beforeSettings *claimState) error {
	if !fence.exists {
		if before != nil {
			return errors.New("claim_state_changed")
		}
		return nil
	}
	if before == nil {
		return errors.New("claim_state_changed")
	}
	if fence.id != nil && before.id != nil && *before.id != *fence.id {
		return errors.New("claim_state_changed")
	}
	if before.typeID != fence.typeID {
		return errors.New("claim_state_changed")
	}
	if !sameClaimValue(before.userID, fence.userID) {
		return errors.New("claim_state_changed")
	}
	if !sameClaimValue(before.zoneID, fence.zoneID) {
		return errors.New("claim_state_changed")
	}
	if !sameClaimText(before.deletedAt, fence.deletedAt) {
		return errors.New("claim_state_changed")
	}
	// Number(before.sync_version || 0) !== Number(fence.sync_version || 0):
	// a stored 'abc' is NaN on the left and 0 on the right.
	if before.syncVersion != jsOrZero(fence.syncVersion) {
		return errors.New("claim_state_changed")
	}
	if fence.stregaGeneration != nil {
		stored := "GEN1"
		if beforeSettings != nil && beforeSettings.generation != nil {
			stored = *beforeSettings.generation
		}
		if stored != *fence.stregaGeneration {
			return errors.New("claim_state_changed")
		}
	}
	return nil
}

func expectedBindingChanged(before, after, beforeSettings, afterSettings *claimState) bool {
	if before == nil || after == nil {
		return false
	}
	generationChanged := beforeSettings != nil && afterSettings != nil &&
		beforeSettings.generation != nil && afterSettings.generation != nil &&
		*beforeSettings.generation != *afterSettings.generation
	return !storedStrictEqual(before.userID, after.userID) ||
		!storedStrictEqual(before.zoneID, after.zoneID) ||
		!sameClaimText(before.deletedAt, after.deletedAt) ||
		generationChanged
}

func (b *backend) renameDevice(w http.ResponseWriter, r *http.Request, p params, body httpbody.Body) {
	scoped := scopedAccess()
	ownerID := 0.0
	if scoped {
		guardOwner, problem, responded := b.scopedRenameGuard(w, r, p)
		if responded {
			return
		}
		if problem != nil {
			scopeRespond(w, problem)
			return
		}
		ownerID = guardOwner
	}
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		statusCode := failure.Status
		if statusCode == 0 {
			statusCode = 500
		}
		text := failure.Message
		if !scoped && signedNullPayload(failure) {
			// device-rename-fn catches the TypeError and answers its message.
			statusCode, text = 500, nullPayloadMessage
		}
		if statusCode == 404 {
			text = "Device not found"
		}
		message(w, statusCode, text)
		return
	}
	deveui := upperTrim(p["deveui"])
	if deveui == "" {
		message(w, 400, "Device EUI is required")
		return
	}
	normalizedName, nameProblem := normalizeEntityName(body.Value.Get("name"))
	if nameProblem != nil {
		respond(w, 400, nameProblem.body()...)
		return
	}
	if !scoped {
		ownerID = session.UserID
	}
	ctx := r.Context()
	var owned int64
	err := b.db.QueryRowContext(ctx,
		"SELECT id FROM devices WHERE deveui=? AND user_id=? AND deleted_at IS NULL LIMIT 1",
		deveui, ownerID).Scan(&owned)
	if errors.Is(err, sql.ErrNoRows) {
		message(w, 404, "Device not found")
		return
	}
	if err != nil {
		message(w, 500, zoneDBMessage(err))
		return
	}
	b.writes.RLock()
	defer b.writes.RUnlock()
	renamed, outcome, problem := b.renameDeviceRow(ctx, deveui, normalizedName)
	if problem != nil {
		respond(w, problem.status, jsvalue.Property("message", jsvalue.Str(problem.message)))
		return
	}
	respond(w, 200,
		jsvalue.Property("deveui", jsvalue.Str(renamed.deveui)),
		jsvalue.Property("name", jsvalue.Str(renamed.name)),
		jsvalue.Property("sync_version", jsvalue.Num(renamed.syncVersion)),
		jsvalue.Property("changed", jsvalue.Bool(renamed.changed)),
		jsvalue.Property("chirpstack", jsvalue.Str(outcome)),
	)
}

func (b *backend) scopedRenameGuard(w http.ResponseWriter, r *http.Request, p params) (float64, *scopeProblem, bool) {
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		respond(w, failure.Status, jsvalue.Property("message", jsvalue.Str(failure.Message)))
		return 0, nil, true
	}
	ctx := r.Context()
	var userUUID, role storedValue
	err := b.db.QueryRowContext(ctx,
		"SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1",
		session.UserID, session.Username.MustString()).Scan(&userUUID, &role)
	if err != nil || !userUUID.truthy() {
		return 0, &scopeProblem{401, "Unauthorized"}, false
	}
	actorScope, problem := b.assertFreshRole(ctx, userUUID, role)
	if problem != nil {
		return 0, problem, false
	}
	if !scopeCanMutate(actorScope.role) {
		return 0, &scopeProblem{403, "insufficient role"}, false
	}
	deveui := upperTrim(p["deveui"])
	if deveui == "" {
		return 0, &scopeProblem{400, "Device EUI is required"}, false
	}
	var ownerID storedValue
	err = b.db.QueryRowContext(ctx,
		"SELECT user_id FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1", deveui).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, &scopeProblem{404, "device not found"}, false
		}
		return 0, &scopeProblem{500, zoneDBMessage(err)}, false
	}
	if _, problem := b.assertFreshDeviceAccess(ctx, userUUID, deveui); problem != nil {
		return 0, problem, false
	}
	// msg._scopedDeviceOwnerId = Number(device.user_id): NULL is 0, TEXT
	// '0xA0' is 160, 'abc' or an empty Buffer is NaN (bound as NULL, so the
	// owned-row check finds nothing), and a REAL keeps its value.
	return ownerID.number(), nil, false
}

type renameOutcome struct {
	deveui      string
	name        string
	syncVersion float64
	changed     bool
}

func (b *backend) renameDeviceRow(ctx context.Context, deveui, name string) (renameOutcome, string, *scopeProblem) {
	if !hex16.MatchString(deveui) {
		return renameOutcome{}, "", &scopeProblem{500, "renameDevice requires a 16-hex DevEUI"}
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return renameOutcome{}, "", &scopeProblem{500, zoneDBMessage(err)}
	}
	defer tx.Rollback()
	var rowDeveui sql.NullString
	var rowName storedValue
	var syncVersion sql.NullFloat64
	err = tx.QueryRowContext(ctx,
		"SELECT deveui, name, sync_version FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1", deveui).Scan(&rowDeveui, &rowName, &syncVersion)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return renameOutcome{}, "", &scopeProblem{404, "device not found"}
		}
		return renameOutcome{}, "", &scopeProblem{500, zoneDBMessage(err)}
	}
	current := 0.0
	if syncVersion.Valid {
		current = syncVersion.Float64
	}
	// osi-entity-name renameDeviceInTransaction: row.name === name is strict,
	// so a BLOB name (a Buffer) is always renamed, and TEXT compares as its
	// decoded string.
	outcome := renameOutcome{deveui: rowDeveui.String, name: name, syncVersion: current, changed: false}
	if rowName.is(name) {
		return outcome, "skipped", nil
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE devices SET name=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE deveui=?",
		name, timestamp(), deveui); err != nil {
		return renameOutcome{}, "", &scopeProblem{500, zoneDBMessage(err)}
	}
	if err := tx.Commit(); err != nil {
		return renameOutcome{}, "", &scopeProblem{500, zoneDBMessage(err)}
	}
	outcome.changed = true
	outcome.name = name
	outcome.syncVersion = current + 1
	chirpstackOutcome := "skipped"
	radio, radioErr := openValveRadio()
	if radioErr != nil {
		log.Printf("Device rename ChirpStack provisioning not configured: %v", radioErr)
	} else {
		defer radio.conn.Close()
		err := serializeDeviceName(deveui, func() error {
			deadline := time.Now().Add(time.Duration(nameUpdateDeadlineMS() * float64(time.Millisecond)))
			stored, found := b.currentDeviceName(ctx, deveui)
			if !found || stored == nil {
				return nil
			}
			updated, problem := radio.setDeviceName(ctx, deveui, *stored, "updateDeviceName", deadline)
			if problem != nil {
				return errors.New(problem.message())
			}
			if updated == "updated" {
				chirpstackOutcome = updated
			}
			return nil
		})
		if err != nil {
			log.Printf("Device rename ChirpStack update failed for %s: %s", deveui, err.Error())
			chirpstackOutcome = "failed"
		}
	}
	return outcome, chirpstackOutcome, nil
}

func nameUpdateDeadlineMS() float64 {
	deadline := 5000.0
	if general := valveRPCDeadlineMS(); general < deadline {
		return general
	}
	return deadline
}

func (b *backend) currentDeviceName(ctx context.Context, deveui string) (*string, bool) {
	var name sql.NullString
	err := b.db.QueryRowContext(ctx, "SELECT name FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1", deveui).Scan(&name)
	if err != nil {
		return nil, false
	}
	if !name.Valid {
		return nil, true
	}
	value := name.String
	return &value, true
}

var deviceNameLocks sync.Map

func serializeDeviceName(eui string, task func() error) error {
	previous, _ := deviceNameLocks.LoadOrStore(eui, &sync.Mutex{})
	lock := previous.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	return task()
}

// valveWriterDevice is osi-valve-control dispatch.js normalizeDevice: every
// valve writer key must be a 16-digit hexadecimal EUI after String(),
// trim and toUpperCase.
func valveWriterDevice(eui string) (string, error) {
	device := upperTrim(eui)
	if len(device) != 16 || strings.Trim(device, "0123456789ABCDEF") != "" {
		return "", errors.New("device_eui must be a 16-character hexadecimal EUI")
	}
	return device, nil
}
