package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jstimezone"
	"osi-edge/internal/jsvalue"
)

// Keep the SELECT and response order aligned with the zone config/list flows.
const zoneConfigColumns = `iz.timezone, iz.latitude, iz.longitude, iz.phenological_stage, iz.calibration_key,
	iz.crop_type, iz.variety, iz.soil_type, iz.irrigation_method, iz.area_m2, iz.irrigation_efficiency_pct,
	COALESCE(iz.prediction_card_enabled,0) AS prediction_card_enabled, iz.scheduling_mode, iz.notes,
	iz.weather_source, iz.stage_started_on`

var zoneConfigFieldNames = []string{
	"timezone", "latitude", "longitude", "phenological_stage", "calibration_key", "crop_type", "variety",
	"soil_type", "irrigation_method", "area_m2", "irrigation_efficiency_pct", "scheduling_mode",
	"prediction_card_enabled", "notes", "weather_source", "stage_started_on",
}

func zoneConfigFields(row jsvalue.Value, forList bool) []jsvalue.Field {
	p := jsvalue.Property
	fields := make([]jsvalue.Field, 0, len(zoneConfigFieldNames)+1)
	for _, key := range zoneConfigFieldNames {
		value := row.Get(key)
		switch key {
		case "scheduling_mode":
			value = zoneFallback(value, jsvalue.Str("local"))
		case "prediction_card_enabled":
			value = jsvalue.Bool(zoneNumberOrZero(value).Truthy())
		case "weather_source":
			value = zoneFallback(value, jsvalue.Str("auto"))
		case "stage_started_on":
			value = zoneFallback(value, jsvalue.Nil())
		case "area_m2", "irrigation_efficiency_pct":
			if forList {
				value = zoneNullableNumber(value)
			}
		default:
			if forList {
				value = zoneFallback(value, jsvalue.Nil())
			}
		}
		fields = append(fields, p(key, value))
		if key == "weather_source" {
			provider := "open_meteo"
			if jsvalue.Lower(jsvalue.Trim(os.Getenv("OSI_WEATHER_PROVIDER_DEFAULT"))) == "meteoswiss" {
				provider = "meteoswiss"
			}
			fields = append(fields, p("weather_source_default", jsvalue.Str(provider)))
		}
	}
	return fields
}

var (
	zoneConfigPath = regexp.MustCompile(`^/api/irrigation-zones/[^/]+/config$`)
	zoneIDPrefix   = regexp.MustCompile(`^[+-]?[0-9]+`)
	weatherSource  = regexp.MustCompile(`^[a-z_]{1,20}$`)
	stageStartDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
)

func configResponseError(w http.ResponseWriter, status int, text string, fromHandler bool) {
	if fromHandler {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	sendJSON(w, status, jsvalue.Obj(jsvalue.Property("error", jsvalue.Str(text))))
}

func (b *backend) configureZone(w http.ResponseWriter, r *http.Request, path params, request httpbody.Body) {
	const handler, guard = true, false
	if !zoneConfigPath.MatchString(r.URL.EscapedPath()) {
		configResponseError(w, 404, "Zone config route not found", guard)
		return
	}
	scoped := scopedAccess()
	session, authFailure := b.zoneBearer(r)
	if authFailure != nil {
		if !scoped && signedNullPayload(authFailure) {
			configResponseError(w, 500, nullPayloadMessage, handler)
		} else if !scoped && authFailure.SignedPayload != nil {
			configResponseError(w, 500, legacyConfigTokenError(*authFailure.SignedPayload), handler)
		} else {
			configResponseError(w, authFailure.Status, authFailure.Message, !scoped)
		}
		return
	}

	ctx, rawID := r.Context(), path["zone_id"]
	owner := session.UserID
	if scoped {
		var failure *zoneFailure
		owner, failure = b.scopedZoneOwner(ctx, session, rawID)
		if failure != nil {
			configResponseError(w, failure.status, failure.text, guard)
			return
		}
	}
	// The handler has always used parseInt(..., 10), while the guard uses Number.
	id, err := strconv.ParseFloat(zoneIDPrefix.FindString(jsvalue.Trim(rawID)), 64)
	if err != nil {
		configResponseError(w, 400, "Invalid zone ID", handler)
		return
	}
	var timezone string
	// The flow embeds zone and owner ids as SQL literals in all three statements.
	// A scoped owner is Number(zone.user_id); when that is NaN or ±Infinity the
	// flow's text reads `user_id=NaN`, which SQLite refuses as a column name.
	ownerSQL, ownerArgs := sqliteNumberText(owner)
	err = b.db.QueryRowContext(ctx, `SELECT timezone FROM irrigation_zones
		WHERE id=? AND user_id=`+ownerSQL+` AND deleted_at IS NULL`, append([]any{sqliteNumberLiteral(id)}, ownerArgs...)...).Scan(&timezone)
	if errors.Is(err, sql.ErrNoRows) {
		configResponseError(w, 404, "Zone not found or access denied", handler)
		return
	}
	if err != nil {
		configResponseError(w, 500, zoneDBMessage(err), handler)
		return
	}

	update, invalid := buildZoneConfigUpdate(request.Value, timezone, time.Now())
	if invalid != "" {
		configResponseError(w, 400, invalid, handler)
		return
	}
	if update.literalError != nil {
		configResponseError(w, 500, update.literalError.Error(), handler)
		return
	}
	if len(update.sets) > 0 {
		update.set("updated_at", timestamp())
		update.sets = append(update.sets, "sync_version=COALESCE(sync_version,0)+1")
		// The existing SQLite trigger owns payload_json. Its key order and
		// REAL rendering are part of the on-disk sync contract.
		_, err = b.db.ExecContext(ctx, "UPDATE irrigation_zones SET "+strings.Join(update.sets, ",")+" WHERE id=? AND user_id="+ownerSQL,
			append(append(update.args, sqliteNumberLiteral(id)), ownerArgs...)...)
		if err != nil {
			configResponseError(w, 500, zoneDBMessage(err), handler)
			return
		}
	}

	rows, err := queryZones(ctx, b.db, "SELECT iz.id, iz.name, "+zoneConfigColumns+" FROM irrigation_zones iz WHERE iz.id=? AND iz.user_id="+ownerSQL,
		append([]any{sqliteNumberLiteral(id)}, ownerArgs...)...)
	if err != nil {
		configResponseError(w, 500, zoneDBMessage(err), handler)
		return
	}
	if len(rows) == 0 {
		configResponseError(w, 404, "Zone not found", handler)
		return
	}
	row, p := rows[0], jsvalue.Property
	fields := append([]jsvalue.Field{p("id", row.Get("id")), p("name", row.Get("name"))}, zoneConfigFields(row, false)...)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	sendJSON(w, 200, jsvalue.Obj(fields...))
}

type zoneConfigUpdate struct {
	sets         []string
	args         []any
	literalError error
}

func (u *zoneConfigUpdate) set(column string, value any) {
	u.sets = append(u.sets, column+"=?")
	u.args = append(u.args, value)
}

func (u *zoneConfigUpdate) text(column string, value jsvalue.Value) {
	switch value.Kind {
	case jsvalue.Undefined:
	case jsvalue.Null:
		u.set(column, nil)
	default:
		text := value.MustString()
		if u.literalError == nil {
			u.literalError = splicedLiteralError(text)
		}
		u.set(column, text)
	}
}

func configAlias(body jsvalue.Value, primary, alias string) jsvalue.Value {
	v := body.Get(primary)
	if v.Kind != jsvalue.Undefined {
		return v
	}
	return body.Get(alias)
}

// This route uses Number(value), but treats an explicit null and the exact
// empty string as a request to clear the corresponding column.
func (u *zoneConfigUpdate) positiveNumber(column string, v jsvalue.Value, max float64) bool {
	if v.Kind == jsvalue.Undefined {
		return true
	}
	if v.Kind == jsvalue.Null || (v.Kind == jsvalue.String && len(v.Text) == 0) {
		u.set(column, nil)
		return true
	}
	number := v.MustNumber()
	if math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 || number > max {
		return false
	}
	// The original UPDATE embeds String(number) as a SQLite REAL literal.
	// Bind the result of the oracle's conversion to preserve its stored bits.
	u.set(column, sqlite344Real(jsvalue.Num(number).MustString()))
	return true
}

// sqlite344RealScales holds the scale constants of sqlite3AtoF's long-double
// path (1e±100, 1e±10, 1e±1) rounded to the given precision.
func sqlite344RealScales(prec uint) [2][3]*big.Float {
	var scales [2][3]*big.Float
	for sign, constants := range [2][3]string{
		{"1e-100", "1e-10", "1e-1"},
		{"1e100", "1e10", "1e1"},
	} {
		for i, text := range constants {
			scales[sign][i], _, _ = big.ParseFloat(text, 10, prec, big.ToNearestEven)
		}
	}
	return scales
}

var sqlite344RealScalesByPrec = map[uint][2][3]*big.Float{
	64:  sqlite344RealScales(64),
	113: sqlite344RealScales(113),
}

// sqlite344Real mirrors SQLite 3.44.2's long-double path in sqlite3AtoF for a
// finite positive JavaScript number's decimal spelling. The long double is
// 113-bit binary128 on the aarch64 gateway and 64-bit x87 extended on the x86
// oracle (sqliteLongDoubleBits, per GOARCH); the two store different doubles
// for about 18 in 100,000 spellings (edge/vectors/atof-sweep.js, measured on a
// Pi 5 and on the x86 oracle).
func sqlite344Real(decimal string) float64 {
	return sqlite344RealPrec(decimal, sqliteLongDoubleBits)
}

func sqlite344RealPrec(decimal string, prec uint) float64 {
	mantissa, exponent, _ := strings.Cut(decimal, "e")
	integer, fraction, _ := strings.Cut(mantissa, ".")
	power, _ := strconv.Atoi(exponent)
	var significand uint64
	const digitLimit = (math.MaxUint64 - 9) / 10
	for i, digit := range integer {
		significand = 10*significand + uint64(digit-'0')
		if significand >= digitLimit {
			power += len(integer) - i - 1
			break
		}
	}
	for _, digit := range fraction {
		if significand >= digitLimit {
			break
		}
		significand = 10*significand + uint64(digit-'0')
		power--
	}
	if significand == 0 {
		return 0
	}
	for power > 0 && significand < math.MaxUint64/10 {
		significand *= 10
		power--
	}
	for power < 0 && significand%10 == 0 {
		significand /= 10
		power++
	}
	if power == 0 {
		return float64(significand)
	}

	scales := sqlite344RealScalesByPrec[prec]
	scale := scales[1]
	if power < 0 {
		scale, power = scales[0], -power
	}
	value := new(big.Float).SetPrec(prec).SetUint64(significand)
	for i, step := range [...]int{100, 10, 1} {
		for power >= step {
			value.Mul(value, scale[i])
			power -= step
		}
	}
	number, _ := value.Float64()
	return number
}

func buildZoneConfigUpdate(body jsvalue.Value, timezone string, now time.Time) (zoneConfigUpdate, string) {
	var update zoneConfigUpdate
	update.text("crop_type", body.Get("cropType"))
	update.text("variety", body.Get("variety"))
	update.text("soil_type", body.Get("soilType"))
	update.text("irrigation_method", body.Get("irrigationMethod"))
	area := configAlias(body, "areaM2", "area_m2")
	if !update.positiveNumber("area_m2", area, math.MaxFloat64) {
		return update, "Area must be greater than 0"
	}
	efficiency := configAlias(body, "irrigationEfficiencyPct", "irrigation_efficiency_pct")
	if !update.positiveNumber("irrigation_efficiency_pct", efficiency, 100) {
		return update, "Irrigation efficiency must be between 0 and 100"
	}
	if value := configAlias(body, "schedulingMode", "scheduling_mode"); value.Kind != jsvalue.Undefined {
		mode := normalizedConfigText(value)
		switch mode {
		case "", "local":
			mode = "local"
		case "server_preferred":
		default:
			return update, "Scheduling mode must be local or server_preferred"
		}
		update.set("scheduling_mode", mode)
	}
	if value := configAlias(body, "predictionCardEnabled", "prediction_card_enabled"); value.Kind != jsvalue.Undefined {
		enabled := value.Kind == jsvalue.Number && value.Num == 1 || jsvalue.Lower(value.MustString()) == "true"
		update.set("prediction_card_enabled", enabled)
	}
	if value := configAlias(body, "weatherSource", "weather_source"); value.Kind != jsvalue.Undefined {
		provider := normalizedConfigText(value)
		if provider == "" {
			provider = "auto"
		}
		if !weatherSource.MatchString(provider) {
			return update, "Weather provider must be 1 to 20 lower-case letters or underscores"
		}
		update.set("weather_source", provider)
	}
	stage := body.Get("phenologicalStage")
	update.text("notes", body.Get("notes"))
	update.text("timezone", body.Get("timezone"))
	update.text("phenological_stage", stage)

	start := configAlias(body, "stageStartedOn", "stage_started_on")
	var explicitDate any
	if start.Kind != jsvalue.Null && start.Kind != jsvalue.Undefined {
		date := jsvalue.Trim(start.MustString())
		if date != "" {
			parsed, valid := jsdate.Parse(date, time.UTC)
			if !valid || !stageStartDate.MatchString(date) || parsed.Year() < 100 || jsdate.ISOString(parsed)[:10] != date {
				return update, "stageStartedOn must be YYYY-MM-DD or null"
			}
			explicitDate = date
		}
	}
	if stage.Kind == jsvalue.Undefined {
		if start.Kind != jsvalue.Undefined {
			update.set("stage_started_on", explicitDate)
		}
	} else {
		update.setStageStart(body.Get("timezone"), timezone, stage, start, explicitDate, now)
	}
	update.text("calibration_key", body.Get("calibrationKey"))
	return update, ""
}

func normalizedConfigText(v jsvalue.Value) string {
	if v.Kind == jsvalue.Null || v.Kind == jsvalue.Undefined {
		return ""
	}
	return jsvalue.Lower(jsvalue.Trim(v.MustString()))
}

var zoneStages = [][2]string{
	{"initial", "initial"}, {"development", "development"}, {"mid_season", "mid_season"},
	{"late_season", "late_season"}, {"dormancy", "dormancy"}, {"budbreak", "initial"},
	{"bud_break", "initial"}, {"fruitset", "development"}, {"cell_division", "development"},
	{"cell_expansion", "development"}, {"veraison", "mid_season"}, {"fruit_maturation", "mid_season"},
	{"harvest", "late_season"}, {"post_harvest", "late_season"},
}

var storedZoneStage = func() string {
	var expression strings.Builder
	expression.WriteString("CASE lower(trim(COALESCE(phenological_stage,'')))")
	for _, pair := range zoneStages {
		fmt.Fprintf(&expression, " WHEN '%s' THEN '%s'", pair[0], pair[1])
	}
	expression.WriteString(" END")
	return expression.String()
}()

func (u *zoneConfigUpdate) setStageStart(requestTZ jsvalue.Value, timezone string, stage, start jsvalue.Value, explicitDate any, now time.Time) {
	var key string
	normalized := normalizedConfigText(stage)
	for _, pair := range zoneStages {
		if pair[0] == normalized {
			key = pair[1]
			break
		}
	}

	switch {
	case key == "" && start.Kind == jsvalue.Undefined:
		u.sets = append(u.sets, "stage_started_on=CASE WHEN ("+storedZoneStage+") IS NOT NULL THEN NULL ELSE stage_started_on END")
	case key == "":
		u.sets = append(u.sets, "stage_started_on=CASE WHEN ("+storedZoneStage+") IS NOT NULL THEN NULL ELSE ? END")
		u.args = append(u.args, explicitDate)
	case start.Kind != jsvalue.Undefined:
		u.set("stage_started_on", explicitDate)
	default:
		if requestTZ.Kind != jsvalue.Null && requestTZ.Kind != jsvalue.Undefined {
			if name := jsvalue.Trim(requestTZ.MustString()); name != "" {
				timezone = name
			}
		}
		u.sets = append(u.sets, "stage_started_on=CASE WHEN ("+storedZoneStage+")=? THEN stage_started_on ELSE ? END")
		u.args = append(u.args, key, now.In(jstimezone.Location(timezone)).Format(time.DateOnly))
	}
}

// The flag-off flow lets V8's exception escape bearer parsing. These
// messages are surfaced only after the token signature has been checked.
func legacyConfigTokenError(raw string) string {
	trimmed := jsvalue.Trim(raw)
	var payload json.RawMessage
	err := json.Unmarshal([]byte(raw), &payload)
	var syntax *json.SyntaxError
	if !errors.As(err, &syntax) {
		return "Invalid token"
	}
	// The offset follows the offending character; step back over all of it.
	_, size := utf8.DecodeLastRuneInString(raw[:syntax.Offset])
	pos := int(syntax.Offset) - size
	detail := syntax.Error()
	if detail == "unexpected end of JSON input" {
		if !strings.HasSuffix(trimmed, "{") && !strings.HasSuffix(trimmed, ",") {
			return "Unexpected end of JSON input"
		}
		pos = len(raw)
	}
	if pos < 0 {
		return "Unexpected end of JSON input"
	}
	before := raw[:pos]
	// V8 11.3 (Node 20.18.3, the gateway's Node) has no "(line N column M)" suffix.
	where := fmt.Sprintf(" in JSON at position %d", len(utf16.Encode([]rune(before))))
	switch {
	case strings.HasSuffix(jsvalue.Trim(before), "{"):
		return "Expected property name or '}'" + where
	case strings.Contains(detail, "looking for beginning of object key string"):
		return "Expected double-quoted property name" + where
	case strings.Contains(detail, "after object key:value pair"):
		return "Expected ',' or '}' after property value" + where
	case strings.Contains(detail, "after object key"):
		return "Expected ':' after property name" + where
	case strings.Contains(detail, "after top-level value"):
		return "Unexpected non-whitespace character after JSON at position " + strings.TrimPrefix(where, " in JSON at position ")
	case strings.Contains(detail, "after array element"):
		return "Expected ',' or ']' after array element" + where
	case strings.Contains(detail, "looking for beginning of value"):
		return v8UnexpectedToken(raw, len(utf16.Encode([]rune(before))))
	}
	return "Unexpected end of JSON input"
}

// v8UnexpectedToken is V8 11.3's JsonParser::ReportUnexpectedToken for a
// character token at UTF-16 position pos: the whole source when it is short,
// otherwise ten units of context on each side of the character.
func v8UnexpectedToken(source string, pos int) string {
	switch source {
	case "NaN", "Infinity", "undefined", "[object Object]":
		return "\"" + source + "\" is not valid JSON"
	}
	const context = 10
	units := utf16.Encode([]rune(source))
	if pos >= len(units) {
		return "Unexpected end of JSON input"
	}
	token := string(utf16.Decode(units[pos : pos+1]))
	text := func(from, to int) string { return string(utf16.Decode(units[from:min(to, len(units))])) }
	prefix := "Unexpected token '" + token + "', "
	switch n := len(units); {
	case n < 2*context+1:
		return prefix + "\"" + source + "\" is not valid JSON"
	case pos < context:
		return prefix + "\"" + text(0, pos+context) + "\"... is not valid JSON"
	case pos < n-context:
		return prefix + "...\"" + text(pos-context, pos+context) + "\"... is not valid JSON"
	default:
		return prefix + "...\"" + text(pos-context, n) + "\" is not valid JSON"
	}
}
