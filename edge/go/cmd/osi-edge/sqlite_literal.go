package main

import (
	"database/sql"
	"math"
	"strconv"
	"strings"

	"osi-edge/internal/jsvalue"
)

// sqliteNumberLiteral returns what SQLite 3.44.2 makes of `${n}` embedded in
// SQL text, as the shipped flows build their statements: String(n) spelled
// with only digits and within int64 is an integer literal; any other spelling
// (fraction, exponent, int64 overflow) goes through sqlite3AtoF, whose long
// double differs by architecture (sqlite344Real). A leading minus is SQL
// unary negation of the positive literal. Non-numbers pass through unchanged.
func sqliteNumberLiteral(value any) any {
	n, ok := value.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) {
		return value
	}
	negative := math.Signbit(n) && n != 0
	text := jsvalue.Num(math.Abs(n)).MustString()
	if !strings.ContainsAny(text, ".e") {
		if i, err := strconv.ParseInt(text, 10, 64); err == nil {
			if negative {
				return -i
			}
			return i
		}
	}
	real := sqlite344Real(text)
	if negative {
		real = -real
	}
	return real
}

// sqliteNumberText is `${n}` in SQL text as a placeholder and its argument.
// String(NaN), 'Infinity' and '-Infinity' are not number literals: SQLite
// reads them as column names, so they stay in the text and the statement
// fails as the flow's does ("no such column: NaN").
func sqliteNumberText(n float64) (string, []any) {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return jsvalue.Num(n).MustString(), nil
	}
	return "?", []any{sqliteNumberLiteral(n)}
}

// actuatorLogZone is `${z}` in run-log-adapters.js buildActuatorLog:
// Number(ctx.zone_id) when finite and positive, spelled into the INSERT, else
// NULL. Zone 123456789012345696 is logged as 123456789012345700.
func actuatorLogZone(zone sql.NullInt64) any {
	if !zone.Valid || zone.Int64 <= 0 {
		return nil
	}
	return sqliteNumberLiteral(float64(zone.Int64))
}

// zoneDouble is a zone id the JS read back from node-sqlite3 as a double and
// binds again: zone 123456789012345700 is bound as 123456789012345696, so a
// lookup by it misses and a write stores 123456789012345696.
func zoneDouble(zone sql.NullInt64) any {
	if !zone.Valid {
		return nil
	}
	return float64(zone.Int64)
}
