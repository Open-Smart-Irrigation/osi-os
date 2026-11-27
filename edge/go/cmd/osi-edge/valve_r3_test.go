package main

import (
	"context"
	"errors"
	"testing"
)

// runtime.js resolveLinkAndGateway: String(value).trim() strips JavaScript
// whitespace (tab, NBSP, BOM, line terminators) but not NEL, and Number(linked)
// decides the link.
func TestValveRuntimeGatewayJSTrim(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	for _, stmt := range []string{
		"CREATE TABLE sync_link_state(peer_node TEXT, linked, gateway_device_eui)",
		"CREATE TABLE devices(deveui TEXT, gateway_device_eui, deleted_at TEXT)",
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	set := func(linked any, link, device any) {
		t.Helper()
		for _, stmt := range []string{"DELETE FROM sync_link_state", "DELETE FROM devices"} {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				t.Fatal(err)
			}
		}
		if linked != nil {
			if _, err := db.ExecContext(ctx, "INSERT INTO sync_link_state VALUES ('cloud',?,?)", linked, link); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO devices VALUES ('A840410000000001',?,NULL)", device); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name         string
		linked       any
		link, device any
		want         string
		wantErr      bool
	}{
		{"unlinked", 0, "0016C001F1000001", "0016C001F1000009", "", false},
		{"no link row", nil, nil, "0016C001F1000009", "", false},
		{"device wins", 1, "0016C001F1000001", "0016C001F1000009", "0016C001F1000009", false},
		{"tab device falls back to link", 1, "0016C001F1000001", "\t", "0016C001F1000001", false},
		{"nbsp device, no link gateway", 1, nil, "\u00a0", "", true},
		{"bom and lf device, no link gateway", 1, nil, "\ufeff\n", "", true},
		{"nel is not whitespace", 1, nil, "\u0085", "\u0085", false},
		{"padded device stamped trimmed", 1, nil, "\t0016C001F1000009\u00a0", "0016C001F1000009", false},
		{"padded link stamped trimmed", 1, "\ufeff0016C001F1000001\u2028", nil, "0016C001F1000001", false},
		{"text linked counts", " 1 ", "0016C001F1000001", nil, "0016C001F1000001", false},
		{"real linked counts", 1.0, "0016C001F1000001", nil, "0016C001F1000001", false},
		{"linked 2 does not count", 2, "0016C001F1000001", nil, "", false},
		{"zero device gateway is falsy", 1, "0016C001F1000001", 0, "0016C001F1000001", false},
	}
	for _, c := range cases {
		set(c.linked, c.link, c.device)
		got, err := valveRuntimeGateway(ctx, db, "A840410000000001")
		if got != c.want || (err != nil) != c.wantErr {
			t.Errorf("%s: got %q, %v; want %q, error %v", c.name, got, err, c.want, c.wantErr)
		}
	}
}

// The flows' String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase().
func TestValveGatewayTopicEUI(t *testing.T) {
	for raw, want := range map[string]string{
		"":                        "UNKNOWN",
		"   ":                     "",
		"\t\u00a0":                "",
		" 0016c001f1000001\ufeff": "0016C001F1000001",
	} {
		t.Setenv("DEVICE_EUI", raw)
		if got := valveGatewayTopicEUI(); got != want {
			t.Errorf("DEVICE_EUI %q: got %q, want %q", raw, got, want)
		}
	}
}

func TestValveEncoderFault(t *testing.T) {
	phase, detail := valveEncoderFault(errors.New("context deadline exceeded"))
	if phase != "UNKNOWN" || detail != "context deadline exceeded" {
		t.Errorf("non-SQLite fault: %q %q", phase, detail)
	}
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "CREATE TABLE t(x); CREATE TRIGGER f BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT,'r3 fault'); END;"); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, "INSERT INTO t VALUES (1)")
	phase, detail = valveEncoderFault(err)
	if phase != "SQLITE_CONSTRAINT" || detail != "SQLITE_CONSTRAINT: r3 fault" {
		t.Errorf("SQLite fault: %q %q", phase, detail)
	}
}
