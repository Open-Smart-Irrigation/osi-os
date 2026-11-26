package main

import (
	"context"
	"testing"

	"osi-edge/internal/ingest"
	"osi-edge/internal/jsvalue"
)

func TestKiwiIngestProfileAndDurableKey(t *testing.T) {
	t.Setenv("CHIRPSTACK_PROFILE_KIWI", "configured-kiwi")
	t.Setenv("CHIRPSTACK_APP_FIELD_TESTER", "field-test")
	b := testKiwiBackend(t)
	first := b
	restarted := &backend{db: b.db}

	deliveries := []struct {
		description string
		backend     *backend
		body        string
	}{
		{"unknown profile", first, `{"deviceInfo":{"devEui":"sample","deviceProfileName":"SDI12"},"object":{"input5_frequency":485}}`},
		{"field tester app", first, `{"deviceInfo":{"devEui":"sample","deviceProfileName":"KIWI","applicationId":"Field-Test"},"object":{"input5_frequency":485}}`},
		{"legacy alias and configured profile", first, `{"deduplicationId":"x","deviceInfo":{"devEui":" sample ","deviceProfileId":"configured-kiwi"},"time":"2025-01-02T03:04:05.123456789+02:00","fPort":99,"object":{"watermark1_frequency":"","input5_frequency":"485","input6_frequency":6431}}`},
		{"repeat in memory", first, `{"deduplicationId":"x","devEui":"sample","deviceProfileName":"KIWI","object":{"input5_frequency":6500}}`},
		{"repeat after restart", restarted, `{"deduplicationId":"x","devEui":"sample","deviceProfileName":"KIWI","object":{"input5_frequency":6500}}`},
	}
	for _, delivery := range deliveries {
		err := (&kiwiIngest{}).handle(delivery.backend, context.Background(), ingest.Uplink{Payload: []byte(delivery.body)})
		if err != nil {
			t.Fatalf("%s: %v", delivery.description, err)
		}
	}
	var count int
	if err := b.db.QueryRow("SELECT count(*) FROM device_data").Scan(&count); err != nil || count != 1 {
		t.Fatalf("device_data count = %d, err = %v", count, err)
	}
	var canonical1, legacy1, canonical2, legacy2 float64
	var stamp string
	if err := b.db.QueryRow("SELECT swt_1, swt_wm1, swt_2, swt_wm2, recorded_at FROM device_data").
		Scan(&canonical1, &legacy1, &canonical2, &legacy2, &stamp); err != nil {
		t.Fatal(err)
	}
	if canonical1 != 100 || legacy1 != 100 || canonical2 != 0 || legacy2 != 0 || stamp != "2025-01-02T01:04:05.123Z" {
		t.Errorf("got SWT %v/%v and %v/%v at %s", canonical1, legacy1, canonical2, legacy2, stamp)
	}
}

func TestCloverHistoryProfilesAndDates(t *testing.T) {
	t.Setenv("CHIRPSTACK_PROFILE_CLOVER", "configured-clover")
	t.Setenv("CHIRPSTACK_APP_FIELD_TESTER", "field-test")
	b := testKiwiBackend(t)
	handler := &kiwiIngest{}
	ctx := t.Context()
	for i, in := range []struct {
		body string
		want string
	}{
		{`{"deviceInfo":{"devEui":"sample","deviceProfileId":"configured-clover"},"time":"2026-11-20 00:00:00 UTC","fCnt":1,"object":{"light_intensity":1}}`, "2026-11-20T00:00:00.000Z"},
		{`{"deviceInfo":{"devEui":"sample","deviceProfileName":"Cloud Clover"},"time":"2026-11-20Z","fCnt":2,"object":{"light_intensity":2}}`, "2026-11-20T00:00:00.000Z"},
		{`{"deviceInfo":{"devEui":"sample","deviceProfileId":"46bdcc01-86db-41bd-bbf8-78cc439edae5"},"time":"2026-11-19T23:00:00-01:00","fCnt":3,"object":{"light_intensity":3}}`, "2026-11-20T00:00:00.000Z"},
		{`{"deviceInfo":{"devEui":"sample","deviceProfileId":"configured-clover","applicationId":"FIELD-TEST"},"time":"2026-11-20Z","fCnt":4,"object":{"light_intensity":4}}`, ""},
	} {
		uplink := ingest.Uplink{Payload: []byte(in.body)}
		if err := handler.handle(b, ctx, uplink); err != nil {
			t.Fatal(err)
		}
		// Replay without the in-memory cache so SQLite must deduplicate.
		if err := handler.handle(&backend{db: b.db}, ctx, uplink); err != nil {
			t.Fatal(err)
		}
		var count int
		var recordedAt, key string
		if err := b.db.QueryRow("SELECT count(*), coalesce(max(recorded_at), ''), coalesce(max(uplink_key), '') FROM device_data WHERE light_lux = ?", i+1).
			Scan(&count, &recordedAt, &key); err != nil {
			t.Fatal(err)
		}
		if in.want == "" {
			if count != 0 {
				t.Errorf("step %d: field tester wrote history", i+1)
			}
			continue
		}
		event, err := jsvalue.Parse(uplink.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if wantKey := ingest.EventKey("kiwi", event); count != 1 || recordedAt != in.want || wantKey == "" || key != wantKey {
			t.Errorf("step %d: got %d rows at %q with frame key %q", i+1, count, recordedAt, key)
		}
	}
}

func testKiwiBackend(t *testing.T) *backend {
	t.Helper()
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE devices (deveui TEXT PRIMARY KEY);
		CREATE TABLE device_data (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			deveui TEXT NOT NULL REFERENCES devices(deveui),
			swt_wm1 REAL, swt_wm2 REAL, swt_1 REAL, swt_2 REAL, light_lux REAL,
			ambient_temperature REAL, relative_humidity REAL, recorded_at TEXT, uplink_key TEXT
		);
		CREATE UNIQUE INDEX device_data_key ON device_data (deveui, uplink_key) WHERE uplink_key IS NOT NULL;
		INSERT INTO devices (deveui) VALUES ('SAMPLE');
	`)
	if err != nil {
		t.Fatal(err)
	}
	return &backend{db: db}
}

// Review confirm-kiwi: the driver misrounds subnormal decimal text, so a
// subnormal reading must store the correctly rounded double, as the gateway's
// SQLite does for the flow's literal.
func TestKiwiSubnormalReadingStoresCorrectDouble(t *testing.T) {
	b := testKiwiBackend(t)
	body := `{"deviceInfo":{"devEui":"sample","deviceProfileName":"KIWI"},"object":{"light_intensity":"1e-309","ambient_temperature":"-1e-310","relative_humidity":21.5}}`
	if err := (&kiwiIngest{}).handle(b, context.Background(), ingest.Uplink{Payload: []byte(body)}); err != nil {
		t.Fatal(err)
	}
	var light, temperature, humidity float64
	if err := b.db.QueryRow("SELECT light_lux, ambient_temperature, relative_humidity FROM device_data").Scan(&light, &temperature, &humidity); err != nil {
		t.Fatal(err)
	}
	if light != 1e-309 || temperature != -1e-310 || humidity != 21.5 {
		t.Errorf("stored %v, %v, %v", light, temperature, humidity)
	}
	// Review confirm-kiwi-subnormal: the oracle's long-double conversion at
	// and below the normal boundary (paired steps exact-0 and exact-3).
	for input, want := range map[string]float64{
		"2.2262937736711384e-308": 2.2262937736711384e-308,
		"4.74981731392289e-309":   4.749817313922888e-309,
		"-4.74981731392289e-309":  -4.749817313922888e-309,
	} {
		if got := kiwiSQLNumber(jsvalue.Num(jsvalue.Str(input).MustNumber())); got != want {
			t.Errorf("%s bound as %v, want %v", input, got, want)
		}
	}
}
