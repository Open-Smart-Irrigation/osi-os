package main

import (
	"context"
	"strings"
	"testing"

	"osi-edge/internal/jsvalue"
)

func bufferValue(data []byte) jsvalue.Value {
	list := make([]jsvalue.Value, len(data))
	for i, b := range data {
		list[i] = jsvalue.Num(float64(b))
	}
	return jsvalue.Obj(jsvalue.Property("type", jsvalue.Str("Buffer")), jsvalue.Property("data", jsvalue.Arr(list...)))
}

// parsePending's key.slice(prefix length), then String(...).toUpperCase().
func TestPendingPlanDevice(t *testing.T) {
	for _, c := range []struct {
		name string
		key  jsvalue.Value
		want string
	}{
		{"ordinary", jsvalue.Str("valve_snapshot_pending:a840410000000001"), "A840410000000001"},
		{"upper-case prefix", jsvalue.Str("VALVE_SNAPSHOT_PENDING:0840410000000021"), "0840410000000021"},
		{"wildcard prefix", jsvalue.Str("valveXsnapshotXpending:0840410000000021"), "0840410000000021"},
		{"blob", bufferValue([]byte("valve_snapshot_pending:a840410000000024")), "A840410000000024"},
		{"blob invalid utf-8", bufferValue(append([]byte("valve_snapshot_pending:a"), 0xff)), "A�"},
		{"astral before cut", jsvalue.Str("valve_snapshot_pending\U0001F600a1"), "�A1"},
		{"prefix only", jsvalue.Str("valve_snapshot_pending:"), ""},
	} {
		if got := pendingPlanDevice(c.key); got != c.want {
			t.Errorf("%s: pendingPlanDevice = %q, want %q", c.name, got, c.want)
		}
	}
}

// The marker list matches a BLOB key as the gateway's LIKE does, and keeps
// ORDER BY key's storage-class order: TEXT keys first, then BLOB keys.
func TestPendingPlansListMatchesBlobKeys(t *testing.T) {
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `INSERT INTO app_settings(key,value,updated_at) VALUES
		(CAST('valve_snapshot_pending:A840410000000001' AS BLOB),'{}','2026-01-01T00:00:00.000Z'),
		('valve_snapshot_pending:B840410000000002','{}','2026-01-01T00:00:00.000Z'),
		('VALVE_SNAPSHOT_PENDING:0840410000000003','{}','2026-01-01T00:00:00.000Z'),
		('valve_snapshot_emitted:A840410000000001','{}','2026-01-01T00:00:00.000Z')`); err != nil {
		t.Fatal(err)
	}
	rows, err := queryZones(ctx, db, pendingPlansSQL)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, row := range rows {
		key := row.Get("key")
		if data, ok := storedBufferBytes(key); ok {
			got = append(got, "blob:"+string(data))
			continue
		}
		got = append(got, key.MustString())
	}
	want := "VALVE_SNAPSHOT_PENDING:0840410000000003,valve_snapshot_pending:B840410000000002,blob:valve_snapshot_pending:A840410000000001"
	if strings.Join(got, ",") != want {
		t.Errorf("listed %q\nwant   %s", got, want)
	}
	if got := pendingPlanDevice(rows[2].Get("key")); got != "A840410000000001" {
		t.Errorf("BLOB marker device = %q", got)
	}
}
