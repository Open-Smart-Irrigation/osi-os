package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/jstimezone"
	"osi-edge/internal/jsvalue"
)

func TestZoneConfigOutboxPayloadMatchesCassette(t *testing.T) {
	for _, example := range []struct {
		mode, flag, timezone string
	}{
		{"unscoped", "0", "Europe/Zurich"},
		{"scoped", "1", "UTC"},
	} {
		t.Run(example.mode, func(t *testing.T) {
			// Raw payload_json from zones/zone-config-ok, including SQLite's
			// trailing .0 on integral REAL values and the nested key order.
			want := readFixture(t, "testdata/zone-config-outbox-"+example.mode+".json")
			fixedIDs, err := jsvalue.Parse(want)
			if err != nil {
				t.Fatal(err)
			}
			const secret = "synthetic-zone-test-secret"
			t.Setenv("AUTH_TOKEN_SECRET", secret)
			t.Setenv("OSI_SCOPED_ACCESS", example.flag)
			db, err := openDB(copySeed(t, t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			ctx := context.Background()
			exec := func(statement string, args ...any) {
				t.Helper()
				if _, err := db.ExecContext(ctx, statement, args...); err != nil {
					t.Fatal(err)
				}
			}
			gateway := fixedIDs.Get("gateway_device_eui").ToString()
			exec(`INSERT INTO users(id,username,password_hash,created_at,user_uuid)
				VALUES(1,'farmer','synthetic-unused','2026-11-23T00:00:00.000Z',?)`, fixedIDs.Get("user").Get("user_uuid").ToString())
			exec(`INSERT INTO irrigation_zones(id,user_id,name,zone_uuid,gateway_device_eui,timezone,sync_version,notes)
				VALUES(1,1,'Field A prime',?,?,?,3,'Unlinked')`, fixedIDs.Get("zone_uuid").ToString(), gateway, example.timezone)
			exec(`INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at)
				VALUES('cloud',1,?,'2026-11-23T00:00:00.000Z')
				ON CONFLICT(peer_node) DO UPDATE SET linked=1,gateway_device_eui=excluded.gateway_device_eui`, gateway)

			token, err := auth.Issue(secret, jsvalue.Num(1), jsvalue.Str("farmer"), jsvalue.Obj(), time.Now().UnixMilli())
			if err != nil {
				t.Fatal(err)
			}
			b := &backend{db: db}
			for _, update := range []struct {
				kind string
				body string
				want []byte
			}{
				{
					"outbox",
					`{"cropType":"apple","variety":"Gala","soilType":"loam","irrigationMethod":"drip","areaM2":2500.5,
					"irrigationEfficiencyPct":85,"schedulingMode":"local","weatherSource":"open_meteo","phenologicalStage":"mid_season",
					"stageStartedOn":"2026-03-15","notes":"North block"}`,
					want,
				},
				{
					"precision",
					`{"areaM2":"1.2345678901234567","irrigationEfficiencyPct":85.00000000000001}`,
					readFixture(t, "testdata/zone-config-precision-"+example.mode+".json"),
				},
			} {
				req := httptest.NewRequest(http.MethodPut, "/api/irrigation-zones/1/config", strings.NewReader(update.body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+token)
				res := httptest.NewRecorder()
				b.ServeHTTP(res, req)
				if res.Code != http.StatusOK {
					t.Fatalf("%s PUT config status = %d, body = %q", update.kind, res.Code, res.Body)
				}

				var got string
				if err := db.QueryRowContext(ctx, `SELECT payload_json FROM sync_outbox
					WHERE aggregate_type='ZONE' AND op='ZONE_CONFIG_UPSERTED' ORDER BY rowid DESC LIMIT 1`).Scan(&got); err != nil {
					t.Fatal(err)
				}
				if got != string(update.want) {
					t.Fatalf("%s stored payload differs from Node-RED\n got: %s\nwant: %s", update.kind, got, update.want)
				}
			}
		})
	}
}

func TestZoneStageDateUsesLocalDay(t *testing.T) {
	now := time.Date(2026, time.January, 2, 2, 0, 0, 0, time.UTC)
	for _, example := range []struct{ tz, date string }{
		{"america/port_of_spain", "2026-01-01"},
		{"-0330", "2026-01-02"},
		{"+14:00", "2026-01-02"},
		{"systemv/pst8pdt", "2026-01-01"},
		{"No/Such_Zone", "2026-01-02"},
	} {
		if got := now.In(jstimezone.Location(example.tz)).Format(time.DateOnly); got != example.date {
			t.Errorf("zone-local date in %q = %s, want %s", example.tz, got, example.date)
		}
	}
}

func TestZoneCalendarUsesNodeAsuncionOffset(t *testing.T) {
	now := time.Date(2026, time.July, 20, 3, 25, 0, 0, time.UTC)
	if got := now.In(jstimezone.Location("America/Asuncion")).Format(time.DateOnly); got != "2026-07-19" {
		t.Fatalf("farm day in Asuncion = %s, want 2026-07-19", got)
	}
}

func TestZoneRealConversion(t *testing.T) {
	for _, test := range []struct {
		decimal string
		stored  float64
	}{
		{"5e-308", 5e-308},
		{"2.1e-302", 2.0999999999999999e-302},
		{"1.9999999999999999e-292", 1.9999999999999999e-292},
		{"3.7462495045835465e-292", 3.7462495045835465e-292},
		{"3.141592653589793", 3.141592653589793},
	} {
		if got := sqlite344Real(test.decimal); got != test.stored {
			t.Errorf("SQLite 3.44.2 conversion of %s = %.17g, want %.17g", test.decimal, got, test.stored)
		}
	}
}

func TestNodeTimezoneVectors(t *testing.T) {
	raw, err := os.ReadFile("../../internal/jstimezone/zones_iana.vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct{ Cases [][3]string }
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Cases) < 1200 {
		t.Fatalf("incomplete Node timezone corpus: %d cases", len(corpus.Cases))
	}
	for _, entry := range corpus.Cases {
		name, canonical, trimmedCanonical := entry[0], entry[1], entry[2]
		if got := jstimezone.Canonical(name); got != canonical {
			t.Errorf("canonical timezone for %q = %q, want %q", name, got, canonical)
		}
		if canonical != "" {
			if got := jstimezone.Location(name).String(); got != canonical {
				t.Errorf("location for %q = %q, want %q", name, got, canonical)
			}
		}
		value, problem := validateTimezone(jsvalue.Str(name), "gatewayTimezone")
		if trimmedCanonical == "" {
			if problem == nil {
				t.Errorf("settings accepted %q as %q", name, value)
			}
		} else if problem != nil || value != jsvalue.Trim(name) {
			t.Errorf("settings timezone for %q = %q, error %v", name, value, problem)
		}
	}
}

func TestSystemVCalendarOffsets(t *testing.T) {
	for _, example := range []struct {
		instant string
		offset  int
	}{
		{"2026-04-26T09:59:59Z", -8},
		{"2026-04-26T10:00:00Z", -7},
		{"2026-10-25T08:59:59Z", -7},
		{"2026-10-25T09:00:00Z", -8},
	} {
		instant, err := time.Parse(time.RFC3339, example.instant)
		if err != nil {
			t.Fatal(err)
		}
		_, offset := instant.In(jstimezone.Location("SystemV/PST8PDT")).Zone()
		if offset != example.offset*3600 {
			t.Errorf("SystemV/PST8PDT at %s = %d seconds, want %d", example.instant, offset, example.offset*3600)
		}
	}
}

func TestWeeklyValveProjectionUsesIntlTimezones(t *testing.T) {
	now := time.Date(2026, time.November, 23, 21, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		zone string
		want int
	}{
		{"europe/zurich", 5},
		{"unrecognized/fixture", 6},
	} {
		at := nextWeeklyValveRun(now, jstimezone.Location(tc.zone), 127, 6, 0)
		want := time.Date(2026, time.November, 24, tc.want, 0, 0, 0, time.UTC)
		if !at.Equal(want) {
			t.Errorf("%q projected %s, want %s", tc.zone, at, want)
		}
	}
}
