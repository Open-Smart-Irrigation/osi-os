package main

import (
	"context"
	"time"

	"osi-edge/internal/jstimezone"
	"osi-edge/internal/jsvalue"
)

// The valve module resolves a timezone as `a || b || ... || 'UTC'` over
// values node-sqlite3 returns: a TEXT '' or NULL (or a number 0) falls
// through, a Buffer is truthy even when empty, and the chosen value is used
// as it is: Intl.DateTimeFormat takes String(value) (a Buffer decodes as
// UTF-8 with replacement; '' or an unknown name throws a RangeError, which
// plan.js formatter() answers with UTC), a response serializes it (a Buffer
// as {"type":"Buffer","data":[...]}) and an INSERT binds it (a Buffer as a
// BLOB).

// storedTimezoneUTC is the chain's last link, the literal 'UTC'.
var storedTimezoneUTC = storedOf("UTC")

// timezoneChain is `values[0] || values[1] || ... || 'UTC'`.
func timezoneChain(values ...storedValue) storedValue {
	for _, value := range values {
		if value.truthy() {
			return value
		}
	}
	return storedTimezoneUTC
}

// location is the zone plan.js formats with for the value: String(value),
// and UTC when Intl refuses it.
func (s storedValue) location() *time.Location {
	return jstimezone.Location(s.jsString())
}

// storedGatewaySetting is store.js getGatewaySetting: app_settings.value with
// its storage class, or null when the row or the table is missing or the read
// fails.
func storedGatewaySetting(ctx context.Context, db scheduleQueryer, key string) storedValue {
	var value storedValue
	if err := db.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key=?", key).Scan(&value); err != nil {
		return storedValue{}
	}
	return value
}

// storedOfJS is the stored value behind a column read through queryZones:
// a {"type":"Buffer","data":[...]} object is the BLOB it came from.
func storedOfJS(v jsvalue.Value) storedValue {
	switch v.Kind {
	case jsvalue.Null, jsvalue.Undefined:
		return storedValue{}
	case jsvalue.String:
		return storedOf(v.MustString())
	case jsvalue.Number:
		return storedOf(v.Num)
	case jsvalue.Object:
		if v.Get("type").Kind == jsvalue.String && v.Get("type").MustString() == "Buffer" {
			data := v.Get("data").List
			raw := make([]byte, len(data))
			for i, b := range data {
				raw[i] = byte(b.Num)
			}
			return storedOf(raw)
		}
	}
	return storedOf(v.MustString())
}

// bindJS is the value as node-sqlite3 binds what it read: TEXT as the decoded
// JavaScript string (invalid UTF-8 already replaced), a Buffer as a BLOB.
func (s storedValue) bindJS() any {
	if text, ok := s.text(); ok {
		return text
	}
	return s.raw
}
