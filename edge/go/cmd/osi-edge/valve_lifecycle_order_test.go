package main

import (
	"context"
	"slices"
	"strings"
	"testing"

	"osi-edge/internal/jsvalue"
)

// push.js lifecycleScheduleSort is a stable localeCompare sort. The expected
// order below is Node 22's ['...'].sort((a, b) => a.localeCompare(b)) for
// UUID-shaped values that differ only in case: lower case first.
func TestLifecycleScheduleOrderMatchesLocaleCompare(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "CREATE TABLE valve_schedules(schedule_uuid TEXT UNIQUE, device_eui TEXT, deleted_at TEXT)"); err != nil {
		t.Fatal(err)
	}
	inserted := []string{
		"0B8F6A3E-6C1A-4F61-9A43-2F1D8B3E9C21",
		"1a000000-0000-4000-8000-000000000000",
		"0b8F6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
		"0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
		"0B8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
	}
	for _, id := range inserted {
		if _, err := db.ExecContext(ctx, "INSERT INTO valve_schedules VALUES (?, 'A840410000000001', NULL)", id); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := queryZones(ctx, db, "SELECT schedule_uuid FROM valve_schedules WHERE UPPER(device_eui)=? AND deleted_at IS NULL"+
		" ORDER BY schedule_uuid COLLATE NOCASE, schedule_uuid DESC", "A840410000000001")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, row := range rows {
		got = append(got, row.Get("schedule_uuid").MustString())
	}
	want := []string{
		"0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
		"0b8F6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
		"0B8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
		"0B8F6A3E-6C1A-4F61-9A43-2F1D8B3E9C21",
		"1a000000-0000-4000-8000-000000000000",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("order = %q\nwant    %q", got, want)
	}
}

// The order below is Node 20.18.3's (the oracle's, ICU 75.1, locale en-US)
// [...].sort((a, b) => a.localeCompare(b)) for values outside the UUID
// alphabet: a leading NUL or BOM is ignorable, punctuation and spaces sort
// before digits, digits before letters.
func TestLifecycleScheduleSortIsLocaleCompare(t *testing.T) {
	want := []string{
		"\u0009ceaa2200-0000-4000-8000-000000000002",
		"\u00a0lead",
		"[bracket",
		"~tilde",
		"0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21",
		"10",
		"9",
		"a_b",
		"a-b",
		"ab",
		"ceaa2200 0000",
		"ceaa2200_0000",
		"ceaa2200-0000-4000-8000-000000000001",
		"Ceaa2200-0000-4000-8000-000000000001",
		"CEAA2200-0000-4000-8000-000000000001",
		"ceaa2200.0000",
		"\ufefffeff",
		"\u0000synthetic-review-weekly",
		"synthetic-review-weekly2",
		"zz-e",
		"zz-\u00e9",
		"zz-f",
	}
	rows := make([]jsvalue.Value, len(want))
	for i := range want {
		rows[i] = jsvalue.Obj(jsvalue.Property("schedule_uuid", jsvalue.Str(want[len(want)-1-i])))
	}
	lifecycleScheduleSort(rows)
	for i, row := range rows {
		if got := row.Get("schedule_uuid").MustString(); got != want[i] {
			t.Fatalf("position %d = %q, want %q", i, got, want[i])
		}
	}
}

// A schedule_uuid holding a lone surrogate (a JS string can; String() keeps
// it) sorts as Node 20.18.3 sorts it: below U+FFFD, above ASCII, and apart
// from another lone surrogate. ['�', '\udc00', '\ud800', 'a'].sort(
// (a, b) => a.localeCompare(b)) is ['a', '\ud800', '\udc00', '�'].
func TestLifecycleScheduleSortKeepsLoneSurrogates(t *testing.T) {
	text := func(units ...uint16) jsvalue.Value { return jsvalue.Value{Kind: jsvalue.String, Text: units} }
	row := func(id jsvalue.Value) jsvalue.Value { return jsvalue.Obj(jsvalue.Property("schedule_uuid", id)) }
	rows := []jsvalue.Value{row(text(0xFFFD)), row(text(0xDC00)), row(text(0xD800)), row(text('a'))}
	lifecycleScheduleSort(rows)
	var got [][]uint16
	for _, r := range rows {
		got = append(got, r.Get("schedule_uuid").Text)
	}
	want := [][]uint16{{'a'}, {0xD800}, {0xDC00}, {0xFFFD}}
	for i := range want {
		if len(got[i]) != 1 || got[i][0] != want[i][0] {
			t.Fatalf("order %x, want %x", got, want)
		}
	}
}

// Reachability of a lone surrogate into lifecycleScheduleSort: the sorted
// keys are always schedule_uuid values read back from SQLite, and the TEXT
// decode never yields one. node-sqlite3 on Node 20.18.3 reads these rows as
// the code units below (runs/icu-parity/r2/reach-node.txt); a JS string with a
// lone surrogate is stored as EF BF BD.
func TestStoredScheduleTextHasNoLoneSurrogates(t *testing.T) {
	db, err := openTestFarmDB(nodeTextDriver, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "CREATE TABLE valve_schedules(schedule_uuid TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO valve_schedules VALUES (CAST(X'EDA080' AS TEXT)), (CAST(X'61EDB08062' AS TEXT)), (CAST(X'EFBFBD' AS TEXT))"); err != nil {
		t.Fatal(err)
	}
	rows, err := queryZones(ctx, db, "SELECT schedule_uuid FROM valve_schedules ORDER BY rowid")
	if err != nil {
		t.Fatal(err)
	}
	want := [][]uint16{{0xFFFD, 0xFFFD, 0xFFFD}, {'a', 0xFFFD, 0xFFFD, 0xFFFD, 'b'}, {0xFFFD}}
	if len(rows) != len(want) {
		t.Fatalf("%d rows", len(rows))
	}
	for i, row := range rows {
		got := row.Get("schedule_uuid").Text
		if !slices.Equal(got, want[i]) {
			t.Errorf("row %d: code units %x, node-sqlite3 %x", i, got, want[i])
		}
	}
}
