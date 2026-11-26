// Package canon implements the protected-command binding canonicaliser v1
// (JS source: osi-watermark-binding/canonicalization.js): JSON with keys
// sorted by UTF-16 code units, field-typed strings (EUI, UUID, local hex
// actor, ISO instants) and numbers expanded out of exponent notation.
// Vectors: edge/vectors/canonical-v1.vectors.json.
package canon

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsnum"
	"osi-edge/internal/jsvalue"
)

// Canonicalize renders v in the protected-binding canonical form.
func Canonicalize(v jsvalue.Value) (string, error) {
	var b strings.Builder
	if err := encode(&b, v, ""); err != nil {
		return "", err
	}
	return b.String(), nil
}

func encode(b *strings.Builder, v jsvalue.Value, field string) error {
	switch v.Kind {
	case jsvalue.Undefined:
		return errors.New("TypeError: protected binding cannot encode undefined")
	case jsvalue.Null:
		b.WriteString("null")
		return nil
	case jsvalue.Boolean:
		if v.Bool {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
		return nil
	case jsvalue.Number:
		text, err := fixedNumber(v.Num)
		if err != nil {
			return err
		}
		b.WriteString(text)
		return nil
	case jsvalue.String:
		text, err := typedString(v.Text, field)
		if err != nil {
			return err
		}
		appendJSONString(b, text)
		return nil
	case jsvalue.Array:
		b.WriteByte('[')
		for i, member := range v.List {
			if i != 0 {
				b.WriteByte(',')
			}
			if err := encode(b, member, ""); err != nil {
				return err
			}
		}
		b.WriteByte(']')
		return nil
	case jsvalue.Object:
		fields := cloneSorted(v.Fields)
		b.WriteByte('{')
		for i, field := range fields {
			if field.Value.Kind == jsvalue.Undefined {
				return errors.New("TypeError: protected binding forbids undefined at " + decodeLoose(field.Key))
			}
			if i != 0 {
				b.WriteByte(',')
			}
			appendJSONString(b, field.Key)
			b.WriteByte(':')
			if err := encode(b, field.Value, decodeLoose(field.Key)); err != nil {
				return err
			}
		}
		b.WriteByte('}')
		return nil
	}
	return errors.New("TypeError: protected binding cannot encode unknown value")
}

// decodeLoose renders UTF-16 units as a Go string, substituting U+FFFD for
// lone surrogates. It is used where the JS keeps the raw string (sorting,
// error text); typed rules match ASCII only and are checked before use.
func decodeLoose(units []uint16) string {
	return string(utf16.Decode(units))
}

func cloneSorted(fields []jsvalue.Field) []jsvalue.Field {
	sorted := make([]jsvalue.Field, len(fields))
	copy(sorted, fields)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && compareUnits(sorted[j-1].Key, sorted[j].Key) > 0; j-- {
			sorted[j-1], sorted[j] = sorted[j], sorted[j-1]
		}
	}
	return sorted
}

func compareUnits(a, b []uint16) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return len(a) - len(b)
}

// fixedNumber expands String(number) out of exponent notation, as the v1
// binding requires: 1e+21 becomes 1000000000000000000000 and 5e-324 becomes
// 0.000...5. Zero (either sign) is "0".
func fixedNumber(n float64) (string, error) {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return "", errors.New("TypeError: protected binding forbids non-finite numbers")
	}
	if n == 0 {
		return "0", nil
	}
	text := jsnum.String(n)
	if !strings.ContainsAny(text, "eE") {
		return text, nil
	}
	lower := jsvalue.Lower(text)
	parts := strings.SplitN(lower, "e", 2)
	coefficient, exponentText := parts[0], parts[1]
	negative := strings.HasPrefix(coefficient, "-")
	unsigned := strings.TrimPrefix(coefficient, "-")
	digits := strings.Replace(unsigned, ".", "", 1)
	fraction := 0
	if dot := strings.IndexByte(unsigned, '.'); dot >= 0 {
		fraction = len(unsigned) - dot - 1
	}
	exponent, err := strconv.Atoi(exponentText)
	if err != nil {
		return "", err
	}
	power := exponent - fraction
	var fixed string
	switch {
	case power >= 0:
		fixed = digits + strings.Repeat("0", power)
	case len(digits)+power > 0:
		cut := len(digits) + power
		fixed = digits[:cut] + "." + digits[cut:]
	default:
		fixed = "0." + strings.Repeat("0", -(len(digits)+power)) + digits
	}
	if strings.IndexByte(fixed, '.') >= 0 {
		fixed = strings.TrimSuffix(strings.TrimRight(fixed, "0"), ".")
	}
	if negative {
		fixed = "-" + fixed
	}
	return fixed, nil
}

var (
	uuidRE        = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	localHexActor = regexp.MustCompile(`^[0-9a-f]{32}$`)
	euiRE         = regexp.MustCompile(`(?i)^[0-9a-f]{16}$`)
	instantRE     = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:?[0-9]{2})$`)
)

var euiFields = map[string]bool{"device_eui": true, "gateway_device_eui": true}
var uuidFields = map[string]bool{"actor_user_uuid": true, "command_id": true, "user_uuid": true}
var instantFields = map[string]bool{
	"created_at": true, "deleted_at": true, "measured_at": true,
	"recorded_at": true, "requested_at": true, "updated_at": true,
}

func typedString(text []uint16, field string) ([]uint16, error) {
	if !isWellFormed(text) {
		// No typed rule can match a string with unpaired surrogates.
		return text, nil
	}
	value := decodeLoose(text)
	if euiFields[field] {
		if !euiRE.MatchString(value) {
			return nil, errors.New("TypeError: protected binding " + field + " must be an EUI64")
		}
		return asciiUnits(jsvalue.Upper(value)), nil
	}
	if field == "actor_user_uuid" && localHexActor.MatchString(value) {
		return text, nil
	}
	if uuidFields[field] {
		if !uuidRE.MatchString(value) {
			return nil, errors.New("TypeError: protected binding " + field + " must be a UUID")
		}
		return asciiUnits(jsvalue.Lower(value)), nil
	}
	if instantFields[field] {
		instant, err := assertCalendarTimestamp(value, field)
		if err != nil {
			return nil, err
		}
		return asciiUnits(instant), nil
	}
	return text, nil
}

func asciiUnits(s string) []uint16 {
	units := make([]uint16, len(s))
	for i := 0; i < len(s); i++ {
		units[i] = uint16(s[i])
	}
	return units
}

func isWellFormed(units []uint16) bool {
	for i := 0; i < len(units); i++ {
		if utf16.IsSurrogate(rune(units[i])) {
			if i+1 < len(units) && utf16.IsSurrogate(rune(units[i+1])) {
				if utf16.DecodeRune(rune(units[i]), rune(units[i+1])) != 0xfffd {
					i++
					continue
				}
			}
			return false
		}
	}
	return true
}

// assertCalendarTimestamp validates and normalizes an instant field exactly as
// the JS does: regex, calendar ranges (with leap-year February), the quirky
// offset arithmetic the JS performs (Number on the sign-prefixed hour), a
// ±14h bound on its result, then new Date(value).toISOString().
func assertCalendarTimestamp(value, field string) (string, error) {
	match := instantRE.FindStringSubmatch(value)
	if match == nil {
		return "", errors.New("TypeError: protected binding " + field + " must be an ISO instant")
	}
	year := decimal(match[1])
	month := decimal(match[2])
	day := decimal(match[3])
	hour := decimal(match[4])
	minute := decimal(match[5])
	second := decimal(match[6])
	zone := match[8]
	offsetMinutes := 0
	if zone != "Z" {
		compact := strings.Replace(zone, ":", "", 1)
		hours, _ := strconv.Atoi(compact[:3])
		minutes, _ := strconv.Atoi(compact[3:])
		offset := hours*60 + minutes
		if zone[0] == '-' {
			offset = -offset
		}
		offsetMinutes = offset
	}
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(dateUTCYear(year), month) ||
		hour > 23 || minute > 59 || second > 59 || abs(offsetMinutes) > 14*60 {
		return "", errors.New("TypeError: protected binding " + field + " must be a valid ISO instant")
	}
	instant, ok := jsdate.Parse(value, time.UTC)
	if !ok {
		return "", errors.New("TypeError: protected binding " + field + " must be a valid ISO instant")
	}
	return jsdate.ISOString(instant), nil
}

func dateUTCYear(year int) int {
	if year < 100 {
		return 1900 + year
	}
	return year
}

func daysInMonth(year, month int) int {
	switch month {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	}
	if year%400 == 0 || (year%4 == 0 && year%100 != 0) {
		return 29
	}
	return 28
}

func decimal(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

const hexDigits = "0123456789abcdef"

// appendJSONString quotes UTF-16 units the way the hand-rolled v1 encoder (and
// JSON.stringify) does: control characters and lone surrogates become \u
// escapes, surrogate pairs are kept as their combined rune.
func appendJSONString(b *strings.Builder, text []uint16) {
	b.WriteByte('"')
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch c {
		case 0x08:
			b.WriteString("\\b")
		case 0x09:
			b.WriteString("\\t")
		case 0x0a:
			b.WriteString("\\n")
		case 0x0c:
			b.WriteString("\\f")
		case 0x0d:
			b.WriteString("\\r")
		case '"':
			b.WriteString("\\\"")
		case '\\':
			b.WriteString("\\\\")
		default:
			r := rune(c)
			if utf16.IsSurrogate(r) {
				if i+1 < len(text) {
					if pair := utf16.DecodeRune(r, rune(text[i+1])); pair != 0xfffd {
						var buffer [4]byte
						b.Write(buffer[:utf8.EncodeRune(buffer[:], pair)])
						i++
						continue
					}
				}
				b.WriteString(`\u`)
				b.WriteByte(hexDigits[(c>>12)&0xf])
				b.WriteByte(hexDigits[(c>>8)&0xf])
				b.WriteByte(hexDigits[(c>>4)&0xf])
				b.WriteByte(hexDigits[c&0xf])
			} else if c < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[(c>>4)&0xf])
				b.WriteByte(hexDigits[c&0xf])
			} else if c < 0x80 {
				b.WriteByte(byte(c))
			} else {
				var buffer [4]byte
				b.Write(buffer[:utf8.EncodeRune(buffer[:], r)])
			}
		}
	}
	b.WriteByte('"')
}
