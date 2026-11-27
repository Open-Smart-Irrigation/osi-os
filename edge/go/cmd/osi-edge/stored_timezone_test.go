package main

import (
	"testing"

	"osi-edge/internal/jsvalue"
)

// The valve timezone chain `a || b || 'UTC'` with each storage class as
// node-sqlite3 returns it, and the zone Intl formats the chosen value in.
func TestTimezoneChainStorageClasses(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	read := func(expr string) storedValue {
		var v storedValue
		if err := db.QueryRow("SELECT " + expr).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	tokyo := read("'Asia/Tokyo'")
	for _, c := range []struct {
		expr, zone, json string
	}{
		{"NULL", "Asia/Tokyo", `"Asia/Tokyo"`},
		{"''", "Asia/Tokyo", `"Asia/Tokyo"`},
		{"0", "Asia/Tokyo", `"Asia/Tokyo"`},
		{"0.0", "Asia/Tokyo", `"Asia/Tokyo"`},
		// A Buffer is truthy even when empty; Intl refuses '' and plan.js
		// formatter() falls back to UTC.
		{"x''", "UTC", `{"type":"Buffer","data":[]}`},
		{"CAST('Europe/Zurich' AS BLOB)", "Europe/Zurich", `{"type":"Buffer","data":[69,117,114,111,112,101,47,90,117,114,105,99,104]}`},
		{"x'C3FF'", "UTC", `{"type":"Buffer","data":[195,255]}`},
		{"'   '", "UTC", `"   "`},
		{"'Not/AZone'", "UTC", `"Not/AZone"`},
		{"5", "UTC", `5`},
		{"1.5", "UTC", `1.5`},
	} {
		chosen := timezoneChain(read(c.expr), tokyo)
		if got := chosen.location().String(); got != c.zone {
			t.Errorf("%s: zone %s, want %s", c.expr, got, c.zone)
		}
		if got := valveJSON(chosen.json()); got != c.json {
			t.Errorf("%s: json %s, want %s", c.expr, got, c.json)
		}
	}
	if got := timezoneChain(read("NULL"), read("''")); got.location().String() != "UTC" || valveJSON(got.json()) != `"UTC"` {
		t.Errorf("empty chain: %v", got.raw)
	}
	if blob, ok := timezoneChain(read("x''")).bindJS().([]byte); !ok || len(blob) != 0 {
		t.Errorf("empty BLOB binds as %T", timezoneChain(read("x''")).bindJS())
	}
	if text := read("CAST(x'41C3' AS TEXT)").bindJS(); text != "A�" {
		t.Errorf("invalid UTF-8 TEXT binds as %q", text)
	}
	buffer := jsvalue.Obj(jsvalue.Property("type", jsvalue.Str("Buffer")), jsvalue.Property("data", jsvalue.Arr(jsvalue.Num(65))))
	if s := storedOfJS(buffer).jsString(); s != "A" {
		t.Errorf("Buffer object string %q", s)
	}
}

// store.js isLostRow: LOST_REASONS.includes(r.error) is strict, so only a
// TEXT reason counts.
func TestValvePushLostStored(t *testing.T) {
	for _, c := range []struct {
		state  string
		reason storedValue
		lost   bool
	}{
		{"FAILED", storedOf("stale_unconfirmed"), true},
		{"FAILED", storedOf("not_resent_q02c"), true},
		{"FAILED", storedOf([]byte("stale_unconfirmed")), false},
		{"FAILED", storedValue{}, false},
		{"QUEUED", storedOf("stale_unconfirmed"), false},
	} {
		if got := valvePushLostStored(c.state, c.reason); got != c.lost {
			t.Errorf("%s %#v: lost %v, want %v", c.state, c.reason.raw, got, c.lost)
		}
	}
}
