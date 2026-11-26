// Package history implements the durable history row hash (hashVersion 1)
// from osi-history-sync-helper: buildCanonicalColumns, hashHistoryRow and
// historyKey for the tables covered by edge/vectors/history-row-hash.vectors.json.
package history

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

// Column is one [name, type, encoded-value] triple of the canonical column
// list; the encoded value is null, a boolean or a string.
type Column struct {
	Name  string
	Type  string
	Value jsvalue.Value
}

var tableColumns = map[string][]Column{
	"radio_uplinks": {
		{"id", "INTEGER", jsvalue.Value{}},
		{"installation_uuid", "TEXT", jsvalue.Value{}},
		{"deveui", "TEXT", jsvalue.Value{}},
		{"recorded_at", "TIMESTAMP", jsvalue.Value{}},
		{"deduplication_id", "TEXT", jsvalue.Value{}},
		{"metadata_json", "JSON", jsvalue.Value{}},
	},
	"device_data": {
		{"id", "INTEGER", jsvalue.Value{}},
		{"deveui", "TEXT", jsvalue.Value{}},
		{"recorded_at", "TIMESTAMP", jsvalue.Value{}},
		{"swt_1", "REAL", jsvalue.Value{}},
		{"swt_2", "REAL", jsvalue.Value{}},
		{"dendro_valid", "BOOLEAN", jsvalue.Value{}},
	},
	"irrigation_events": {
		{"event_uuid", "TEXT", jsvalue.Value{}},
		{"created_at", "TIMESTAMP", jsvalue.Value{}},
		{"action", "TEXT", jsvalue.Value{}},
		{"reason", "TEXT", jsvalue.Value{}},
		{"aggregate_kpa", "REAL", jsvalue.Value{}},
		{"threshold_kpa", "REAL", jsvalue.Value{}},
		{"duration_minutes", "INTEGER", jsvalue.Value{}},
		{"valve_deveui", "TEXT", jsvalue.Value{}},
		{"payload_json", "JSON", jsvalue.Value{}},
	},
}

// BuildCanonicalColumns encodes every declared column of the row with its
// hash type. Missing row members encode as null.
func BuildCanonicalColumns(table string, row jsvalue.Value) ([]Column, error) {
	spec, ok := tableColumns[table]
	if !ok {
		return nil, errors.New("Error: unsupported history table " + table)
	}
	columns := make([]Column, len(spec))
	copy(columns, spec)
	for i, column := range columns {
		value, err := encodeValue(column.Type, row.Get(column.Name))
		if err != nil {
			return nil, err
		}
		columns[i].Value = value
	}
	return columns, nil
}

// HashHistoryRow is the hashVersion 1 payload hash of one row.
func HashHistoryRow(table, historyKey string, row jsvalue.Value) (string, error) {
	columns, err := BuildCanonicalColumns(table, row)
	if err != nil {
		return "", err
	}
	list := jsvalue.Arr()
	for _, column := range columns {
		entry := jsvalue.Arr(jsvalue.Str(column.Name), jsvalue.Str(column.Type), column.Value)
		list.List = append(list.List, entry)
	}
	input, err := jsvalue.Stringify(jsvalue.Obj(
		jsvalue.Property("hashVersion", jsvalue.Num(1)),
		jsvalue.Property("tableName", jsvalue.Str(table)),
		jsvalue.Property("historyKey", jsvalue.Str(historyKey)),
		jsvalue.Property("columns", list),
	))
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(input)
	return hex.EncodeToString(hash[:]), nil
}

// HistoryKey is the durable identity of one row within a gateway's history.
func HistoryKey(table, gatewayEui string, row jsvalue.Value) (string, error) {
	gateway := jsvalue.Upper(jsvalue.Trim(gatewayEui))
	id := row.Get("id").MustString()
	switch table {
	case "radio_uplinks":
		return "RADIO_UPLINK|" + gateway + "|" + id, nil
	case "device_data":
		return "DEVICE_DATA|" + gateway + "|" + id, nil
	case "irrigation_events":
		return "IRRIGATION_EVENT|" + row.Get("event_uuid").MustString() + "|" + id, nil
	}
	return "", errors.New("Error: unsupported history table " + table)
}

func encodeValue(hashType string, value jsvalue.Value) (jsvalue.Value, error) {
	if value.Kind == jsvalue.Undefined || value.Kind == jsvalue.Null {
		return jsvalue.Nil(), nil
	}
	switch hashType {
	case "TEXT":
		return jsvalue.Str(value.MustString()), nil
	case "INTEGER":
		return encodeInteger(value)
	case "REAL":
		return encodeReal(value)
	case "BOOLEAN":
		return encodeBoolean(value)
	case "TIMESTAMP":
		text, err := encodeTimestamp(value)
		if err != nil {
			return jsvalue.Value{}, err
		}
		return jsvalue.Str(text), nil
	case "JSON":
		return encodeJSON(value)
	}
	return jsvalue.Value{}, errors.New("Error: unsupported hash type " + hashType)
}

func encodeInteger(value jsvalue.Value) (jsvalue.Value, error) {
	if value.Kind == jsvalue.Number && !math.IsNaN(value.Num) && !math.IsInf(value.Num, 0) &&
		value.Num == math.Trunc(value.Num) && math.Abs(value.Num) <= 9007199254740991 {
		return jsvalue.Str(value.MustString()), nil
	}
	if value.Kind == jsvalue.String {
		text := jsvalue.Trim(value.MustString())
		if integerRE.MatchString(text) {
			normalized, err := normalizeInteger(text)
			if err != nil {
				return jsvalue.Value{}, err
			}
			return jsvalue.Str(normalized), nil
		}
	}
	return jsvalue.Value{}, errors.New("Error: invalid INTEGER " + value.MustString())
}

var integerRE = regexp.MustCompile(`^-?[0-9]+$`)

// normalizeInteger mirrors BigInt(text).toString(): leading zeros vanish and
// "-0" becomes "0".
func normalizeInteger(text string) (string, error) {
	negative := strings.HasPrefix(text, "-")
	digits := strings.TrimPrefix(text, "-")
	digits = strings.TrimLeft(digits, "0")
	if digits == "" {
		return "0", nil
	}
	if negative {
		return "-" + digits, nil
	}
	return digits, nil
}

func encodeReal(value jsvalue.Value) (jsvalue.Value, error) {
	number := value.MustNumber()
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return jsvalue.Value{}, errors.New("Error: invalid REAL " + value.MustString())
	}
	if number == 0 {
		number = 0 // Object.is(-0, ...) normalisation: -0 hashes as +0
	}
	return jsvalue.Str(fmt.Sprintf("%016x", math.Float64bits(number))), nil
}

func encodeBoolean(value jsvalue.Value) (jsvalue.Value, error) {
	switch {
	case value.Kind == jsvalue.Boolean && value.Bool,
		value.Kind == jsvalue.Number && value.Num == 1,
		value.Kind == jsvalue.String && value.MustString() == "1":
		return jsvalue.Bool(true), nil
	case value.Kind == jsvalue.Boolean && !value.Bool,
		value.Kind == jsvalue.Number && value.Num == 0, // -0 === 0 in JS
		value.Kind == jsvalue.String && value.MustString() == "0":
		return jsvalue.Bool(false), nil
	}
	return jsvalue.Value{}, errors.New("Error: invalid BOOLEAN " + value.MustString())
}

// encodeJSON canonicalises a JSON column: JSON.parse when the row carries
// text, then recursively sorted keys with JSON.stringify scalar rendering.
func encodeJSON(value jsvalue.Value) (jsvalue.Value, error) {
	if value.Kind == jsvalue.String {
		parsed, err := jsvalue.Parse([]byte(value.MustString()))
		if err != nil {
			return jsvalue.Value{}, errors.New("SyntaxError: Unexpected token in JSON")
		}
		value = parsed
	}
	text, err := canonicalJSON(value)
	if err != nil {
		return jsvalue.Value{}, err
	}
	return jsvalue.Str(text), nil
}

func canonicalJSON(value jsvalue.Value) (string, error) {
	switch value.Kind {
	case jsvalue.Array:
		var b strings.Builder
		b.WriteByte('[')
		for i, member := range value.List {
			if i != 0 {
				b.WriteByte(',')
			}
			text, err := canonicalJSON(member)
			if err != nil {
				return "", err
			}
			b.WriteString(text)
		}
		b.WriteByte(']')
		return b.String(), nil
	case jsvalue.Object:
		fields := make([]jsvalue.Field, len(value.Fields))
		copy(fields, value.Fields)
		for i := 1; i < len(fields); i++ {
			for j := i; j > 0 && compareKeys(fields[j-1].Key, fields[j].Key) > 0; j-- {
				fields[j-1], fields[j] = fields[j], fields[j-1]
			}
		}
		var b strings.Builder
		b.WriteByte('{')
		for i, field := range fields {
			if i != 0 {
				b.WriteByte(',')
			}
			key, err := jsvalue.Stringify(jsvalue.Value{Kind: jsvalue.String, Text: field.Key})
			if err != nil {
				return "", err
			}
			text, err := canonicalJSON(field.Value)
			if err != nil {
				return "", err
			}
			b.Write(key)
			b.WriteByte(':')
			b.WriteString(text)
		}
		b.WriteByte('}')
		return b.String(), nil
	default:
		text, err := jsvalue.Stringify(value)
		if err != nil {
			return "", err
		}
		return string(text), nil
	}
}

func compareKeys(a, b []uint16) int {
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

// localZone overrides the process timezone (jsdate.ProcessZone) in tests.
var localZone *time.Location

func encodeTimestamp(value jsvalue.Value) (string, error) {
	zone := localZone
	if zone == nil {
		zone = jsdate.ProcessZone()
	}
	instant, ok, err := value.Date(zone)
	if err != nil {
		return "", fmt.Errorf("TypeError: %w", err)
	}
	if !ok {
		return "", errors.New("Error: invalid timestamp " + value.MustString())
	}
	return jsdate.ISOString(instant), nil
}
