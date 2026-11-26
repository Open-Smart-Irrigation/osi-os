package main

import (
	"fmt"
	"math"
	"strconv"

	"osi-edge/internal/jsvalue"
)

// Column values scanned into any keep their SQLite storage class
// (modernc: TEXT string, BLOB []byte, INTEGER int64, REAL float64, NULL nil),
// which node-sqlite3 maps to string, Buffer, number and null.

// storedText is the value when it is a JavaScript string (TEXT).
func storedText(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// storedTruthy is JavaScript truthiness of the value node-sqlite3 returns.
// A Buffer is an object, so a BLOB is truthy even when it is empty.
func storedTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case int64:
		return v != 0
	case float64:
		return v != 0 && !math.IsNaN(v)
	case string:
		return v != ""
	case bool:
		return v
	}
	return true
}

// storedValue is one column value with its SQLite storage class kept, so the
// scope and account checks can treat it as node-sqlite3 hands it to the
// flows: TEXT as a string (decoded as UTF-8 with replacement), BLOB as a
// Buffer, INTEGER and REAL as a number, NULL as null.
type storedValue struct{ raw any }

func (s *storedValue) Scan(src any) error {
	switch v := src.(type) {
	case []byte:
		s.raw = append([]byte{}, v...)
	case int64, float64, string, nil:
		s.raw = v
	case bool:
		if v {
			s.raw = int64(1)
		} else {
			s.raw = int64(0)
		}
	default:
		return fmt.Errorf("storedValue: unsupported %T", src)
	}
	return nil
}

func storedOf(raw any) storedValue { return storedValue{raw: raw} }

// truthy is JavaScript truthiness; a Buffer is truthy even when empty.
func (s storedValue) truthy() bool { return storedTruthy(s.raw) }

// notNull is `value != null`.
func (s storedValue) notNull() bool { return s.raw != nil }

// arg binds the value back as node-sqlite3 binds it: a Buffer stays a BLOB.
func (s storedValue) arg() any { return s.raw }

// text is the JavaScript string when the value is TEXT.
func (s storedValue) text() (string, bool) {
	text, ok := s.raw.(string)
	if !ok {
		return "", false
	}
	return jsvalue.DecodeUTF8(text), true
}

// is is `value === literal`: only TEXT can equal a string literal.
func (s storedValue) is(literal string) bool {
	text, ok := s.text()
	return ok && text == literal
}

// key is the Set/Map key (SameValueZero). A Buffer is an object that equals
// nothing but itself, and node-sqlite3 returns a new one on every read, so it
// has no key.
func (s storedValue) key() (string, bool) {
	switch v := s.raw.(type) {
	case nil:
		return "null", true
	case string:
		return "s:" + jsvalue.DecodeUTF8(v), true
	case int64:
		return storedNumberKey(float64(v)), true
	case float64:
		return storedNumberKey(v), true
	}
	return "", false
}

func storedNumberKey(n float64) string {
	if n == 0 {
		n = 0
	}
	return "n:" + strconv.FormatFloat(n, 'g', -1, 64)
}

// strictEqual is `a === b` between two values read from the database.
func storedStrictEqual(a, b storedValue) bool {
	left, ok := a.key()
	if !ok {
		return false
	}
	right, ok := b.key()
	return ok && left == right
}

// json is the value as JSON.stringify writes it; a Buffer becomes
// {"type":"Buffer","data":[...]}.
func (s storedValue) json() jsvalue.Value {
	switch v := s.raw.(type) {
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
		for i, b := range v {
			data[i] = jsvalue.Num(float64(b))
		}
		return jsvalue.Obj(jsvalue.Property("type", jsvalue.Str("Buffer")), jsvalue.Property("data", jsvalue.Arr(data...)))
	}
	return jsvalue.Nil()
}

// jsString is String(value): a Buffer decodes as UTF-8 with replacement.
func (s storedValue) jsString() string {
	switch v := s.raw.(type) {
	case nil:
		return "null"
	case string:
		return jsvalue.DecodeUTF8(v)
	case []byte:
		return jsvalue.DecodeUTF8(string(v))
	case int64:
		return jsvalue.Num(float64(v)).MustString()
	case float64:
		return jsvalue.Num(v).MustString()
	}
	return ""
}

// orString is String(value || fallback).
func (s storedValue) orString(fallback string) string {
	if !s.truthy() {
		return fallback
	}
	return s.jsString()
}

// number is Number(value) for a value read from the database. Number(Buffer)
// converts the Buffer through its string form.
func (s storedValue) number() float64 {
	switch v := s.raw.(type) {
	case nil:
		return 0
	case int64:
		return float64(v)
	case float64:
		return v
	}
	return jsvalue.Str(s.jsString()).MustNumber()
}

// orNull is `value || null` as it serializes: a falsy value is null, a Buffer
// is truthy even when empty and answers as Buffer JSON.
func (s storedValue) orNull() jsvalue.Value {
	if !s.truthy() {
		return jsvalue.Nil()
	}
	return s.json()
}
