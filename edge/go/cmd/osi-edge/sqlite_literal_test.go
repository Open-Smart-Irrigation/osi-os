package main

import (
	"database/sql"
	"fmt"
	"math"
	"testing"

	"osi-edge/internal/auth"
)

// Review confirm-ld113: values the flows embed as SQL literals, on this
// build's long double (the x86 oracle's bits on amd64).
func TestSQLiteNumberLiteral(t *testing.T) {
	if got := sqliteNumberLiteral(float64(485)); got != int64(485) {
		t.Errorf("485 -> %#v", got)
	}
	if got := sqliteNumberLiteral(float64(-30)); got != int64(-30) {
		t.Errorf("-30 -> %#v", got)
	}
	// Digit-only spellings past int64 go through sqlite3AtoF; a large integer
	// binds the integer its JS spelling names, not the double's exact value.
	if got, ok := sqliteNumberLiteral(1e20).(float64); !ok || got != 1e20 {
		t.Errorf("1e20 -> %#v", got)
	}
	if got := sqliteNumberLiteral(float64(123456789012345696)); got != int64(123456789012345700) {
		t.Errorf("123456789012345696 -> %#v", got)
	}
	if got := sqliteNumberLiteral(math.Copysign(0, -1)); got != int64(0) {
		t.Errorf("-0 -> %#v", got)
	}
	if got := sqliteNumberLiteral(math.NaN()); got == got {
		t.Errorf("NaN -> %#v", got)
	}
	if got := sqliteNumberLiteral(nil); got != nil {
		t.Errorf("nil -> %#v", got)
	}
	cases := map[float64][2]string{
		4.352696532970292e-40:   {"37c2f56b377cae16", "37c2f56b377cae15"}, // daily threshold probe
		1.8230333467945457e+123: {"59860fe43021d256", "59860fe43021d256"}, // integral, exponent spelling
		-61831.86851429741:      {"c0ee30fbcade7ef0", "c0ee30fbcade7eef"},
	}
	for n, want := range cases {
		got, ok := sqliteNumberLiteral(n).(float64)
		if !ok {
			t.Fatalf("%v not bound as REAL", n)
		}
		expect := want[0]
		if sqliteLongDoubleBits == 113 {
			expect = want[1]
		}
		if bits := fmt.Sprintf("%016x", math.Float64bits(got)); bits != expect {
			t.Errorf("%v -> %s, want %s", n, bits, expect)
		}
	}
}

// Review confirm-ids F3: 2^63 spells as 9223372036854776000, which overflows
// int64, so it is a REAL for both signs (the negative is not int64 min), and
// ±Inf and NaN pass through unchanged and stay in the statement text.
func TestSQLiteNumberLiteralEdges(t *testing.T) {
	twoPow63 := math.Ldexp(1, 63)
	if got, ok := sqliteNumberLiteral(twoPow63).(float64); !ok || got != twoPow63 {
		t.Errorf("2^63 -> %#v, want REAL 2^63", sqliteNumberLiteral(twoPow63))
	}
	if got, ok := sqliteNumberLiteral(-twoPow63).(float64); !ok || got != -twoPow63 {
		t.Errorf("-2^63 -> %#v, want REAL -2^63", sqliteNumberLiteral(-twoPow63))
	}
	// The largest double below 2^63 spells 9223372036854775000, an integer
	// literal within int64 that is not the double itself.
	below := math.Nextafter(twoPow63, 0)
	if got := sqliteNumberLiteral(below); got != int64(9223372036854775000) {
		t.Errorf("nextafter(2^63, 0) -> %#v", got)
	}
	for _, n := range []float64{math.Inf(1), math.Inf(-1)} {
		if got, ok := sqliteNumberLiteral(n).(float64); !ok || got != n {
			t.Errorf("%v -> %#v, want unchanged", n, sqliteNumberLiteral(n))
		}
	}
	for n, want := range map[float64]string{math.Inf(1): "Infinity", math.Inf(-1): "-Infinity"} {
		if text, args := sqliteNumberText(n); text != want || args != nil {
			t.Errorf("sqliteNumberText(%v) = %q %#v", n, text, args)
		}
	}
	if text, args := sqliteNumberText(math.NaN()); text != "NaN" || args != nil {
		t.Errorf("sqliteNumberText(NaN) = %q %#v", text, args)
	}
	if text, args := sqliteNumberText(123456789012345696); text != "?" || len(args) != 1 || args[0] != int64(123456789012345700) {
		t.Errorf("sqliteNumberText(123456789012345696) = %q %#v", text, args)
	}
}

// fix-ids-r2: the values the ported nodes spell or bind back.
func TestSpelledAndBoundIDs(t *testing.T) {
	for id, want := range map[float64]any{
		123456789012345696: int64(123456789012345700),
		1.5:                1.5,
		-7:                 int64(-7),
		1e21:               1e21,
	} {
		if got := legacyUserLookupID(auth.Session{UserID: id}); got != want {
			t.Errorf("legacyUserLookupID(%v) = %#v, want %#v", id, got, want)
		}
	}
	for zone, want := range map[sql.NullInt64]any{
		{}:                                       nil,
		{Int64: 0, Valid: true}:                  nil,
		{Int64: -3, Valid: true}:                 nil,
		{Int64: 5, Valid: true}:                  int64(5),
		{Int64: 123456789012345696, Valid: true}: int64(123456789012345700),
	} {
		if got := actuatorLogZone(zone); got != want {
			t.Errorf("actuatorLogZone(%v) = %#v, want %#v", zone, got, want)
		}
	}
	if got := zoneDouble(sql.NullInt64{Int64: 123456789012345700, Valid: true}); got != float64(123456789012345696) {
		t.Errorf("zoneDouble(123456789012345700) = %#v", got)
	}
	if got := zoneDouble(sql.NullInt64{}); got != nil {
		t.Errorf("zoneDouble(NULL) = %#v", got)
	}
	if jsOrZero(math.NaN()) != 0 || jsOrZero(3.5) != 3.5 {
		t.Error("jsOrZero")
	}
}
