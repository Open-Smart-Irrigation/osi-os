package main

import (
	"database/sql"
	"strings"
	"testing"

	"osi-edge/internal/jsvalue"
)

func parseValue(t *testing.T, text string) jsvalue.Value {
	t.Helper()
	value, err := jsvalue.Parse([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestNormalizeEntityName(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    string
		reason  string
		wantErr bool
	}{
		{name: "missing", input: `null`, wantErr: true, reason: "name_empty"},
		{name: "empty", input: `"   "`, wantErr: true, reason: "name_empty"},
		{name: "nonstring", input: `42`, wantErr: true, reason: "name_invalid_unicode"},
		{name: "lone surrogate", input: "\"row\\ud800one\"", wantErr: true, reason: "name_invalid_unicode"},
		{name: "control", input: "\"row\\u0007bell\"", wantErr: true, reason: "name_control_characters"},
		{name: "trimmed", input: "\"\\u00a0 Kiwi row 1 \\u2028\"", want: "Kiwi row 1"},
		{name: "allowed punctuation", input: `"Row #2 — North / East"`, want: "Row #2 — North / East"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeEntityName(parseValue(t, tc.input))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				if err.code != tc.reason {
					t.Fatalf("reason = %q, want %q", err.code, tc.reason)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeEntityNameTooLong(t *testing.T) {
	text := `"` + strings.Repeat("a", 101) + `"`
	_, err := normalizeEntityName(parseValue(t, text))
	if err == nil || err.code != "name_too_long" {
		t.Fatalf("expected name_too_long, got %v", err)
	}
	text = `"` + strings.Repeat("\\ud83d\\ude00", 50) + `"`
	if _, err := normalizeEntityName(parseValue(t, text)); err != nil {
		t.Fatalf("50 surrogate pairs are 50 code points: %v", err)
	}
}

func TestCollectModuleWrites(t *testing.T) {
	writes, problem := collectModuleWrites(parseValue(t, `{"journalModuleEnabled": false, "gatewayTimezone": "Europe/Zurich"}`))
	if problem != nil {
		t.Fatal(problem)
	}
	if len(writes) != 1 || writes[0].setting.key != "journal_module_enabled" || writes[0].boolean {
		t.Fatalf("unexpected writes %+v", writes)
	}
	if _, problem := collectModuleWrites(parseValue(t, `{"dataModuleEnabled": "yes"}`)); problem == nil || problem.status != 422 {
		t.Fatal("expected 422 for non-boolean module flag")
	}
	writes, problem = collectModuleWrites(parseValue(t, `{"networkModuleEnabled": "auto"}`))
	if problem != nil || len(writes) != 1 || writes[0].text != "auto" {
		t.Fatalf("network auto should be accepted: %+v %v", writes, problem)
	}
	if _, problem := collectModuleWrites(parseValue(t, `{"journalModuleEnabled": "auto"}`)); problem == nil {
		t.Fatal("journal auto must be refused")
	}
}

func TestModuleDefaultsWire(t *testing.T) {
	body, err := jsvalue.Stringify(moduleDefaults())
	if err != nil {
		t.Fatal(err)
	}
	want := `{"dataModuleEnabled":true,"networkModuleEnabled":false,"gatewayHubModuleEnabled":true,"journalModuleEnabled":true}`
	if string(body) != want {
		t.Fatalf("moduleDefaults = %s, want %s", body, want)
	}
}

func TestValidateTimezone(t *testing.T) {
	if _, problem := validateTimezone(jsvalue.Value{}, "gatewayTimezone"); problem == nil || problem.status != 422 || problem.message != "gatewayTimezone is required" {
		t.Fatalf("missing timezone: %+v", problem)
	}
	if _, problem := validateTimezone(jsvalue.Str("Not/AZone"), "gatewayTimezone"); problem == nil || problem.message != "gatewayTimezone must be a valid IANA time zone" {
		t.Fatalf("invalid timezone: %+v", problem)
	}
	got, problem := validateTimezone(jsvalue.Str(" Europe/Zurich "), "gatewayTimezone")
	if problem != nil || got != "Europe/Zurich" {
		t.Fatalf("valid timezone: %q %+v", got, problem)
	}
	if _, problem := validateTimezone(jsvalue.Num(0), "gatewayTimezone"); problem == nil || problem.message != "gatewayTimezone is required" {
		t.Fatalf("zero is falsy like JS: %+v", problem)
	}
}

func TestResolveTimezoneClassification(t *testing.T) {
	if _, ok := resolveTimezone(sql.NullString{}); ok {
		t.Fatal("empty is unassigned_default, not classified")
	}
	zone, ok := resolveTimezone(sql.NullString{String: "Europe/Zurich", Valid: true})
	if !ok || zone.basis != "zone" || zone.timezone != "Europe/Zurich" {
		t.Fatalf("region name: %+v", zone)
	}
	abbrev, ok := resolveTimezone(sql.NullString{String: "CET", Valid: true})
	if !ok || abbrev.basis != "abbreviation" {
		t.Fatalf("abbreviation: %+v", abbrev)
	}
	invalid, ok := resolveTimezone(sql.NullString{String: "Not/AZone", Valid: true})
	if !ok || invalid.basis != "invalid" || invalid.timezone != "UTC" {
		t.Fatalf("invalid: %+v", invalid)
	}
}

func TestParseRecordedAtMs(t *testing.T) {
	cases := []struct {
		text  string
		want  string
		valid bool
	}{
		{text: "2026-11-20T23:30:00.000Z", want: "2026-11-20T23:30:00Z", valid: true},
		{text: "2026-11-20 23:30:00", want: "2026-11-20T23:30:00Z", valid: true},
		{text: "2026-11-20 23:30:00.25", want: "2026-11-20T23:30:00.25Z", valid: true},
		{text: "\ufeff2026-07-20 23:30\ufeff", want: "2026-07-20T23:30:00Z", valid: true},
		{text: "2026-07-21T23:30Z", want: "2026-07-21T23:30:00Z", valid: true},
		{text: "2026-07-21T23:30+0130", want: "2026-07-21T22:00:00Z", valid: true},
		{text: "2026-11-20T23:30:00.123456789Z", want: "2026-11-20T23:30:00.123Z", valid: true},
		{text: "", valid: false},
	}
	for _, tc := range cases {
		stamp, ok := parseRecordedAtMs(jsvalue.Str(tc.text))
		if ok != tc.valid {
			t.Fatalf("%s valid=%t want %t", tc.text, ok, tc.valid)
		}
		if ok && stamp.UTC().Format("2006-01-02T15:04:05.999Z") != tc.want {
			t.Fatalf("%s parsed to %s want %s", tc.text, stamp.UTC(), tc.want)
		}
	}
}

func TestHex32AndDeviceTypes(t *testing.T) {
	if !hex32("00112233445566778899AABBCCDDEEFF") {
		t.Fatal("valid key rejected")
	}
	for _, bad := range []string{"001122334455", "00112233445566778899aabbccddeeff", "00112233445566778899AABBCCDDEEXX", ""} {
		if hex32(bad) {
			t.Fatalf("invalid key accepted: %q", bad)
		}
	}
	for _, typeID := range []string{"KIWI_SENSOR", "STREGA_VALVE", "RAK10701_FIELD_TESTER"} {
		if !validDeviceTypes[typeID] {
			t.Fatalf("%s should be valid", typeID)
		}
	}
	if validDeviceTypes["NOPE_SENSOR"] {
		t.Fatal("unknown type accepted")
	}
}

func TestScopedPublicMessageMapping(t *testing.T) {
	if (&scopeProblem{404, "zone not found"}).publicMessage() != "Device not found" {
		t.Fatal("404s map to Device not found")
	}
	if (&scopeProblem{403, "insufficient role"}).publicMessage() != "Forbidden" {
		t.Fatal("403s map to Forbidden")
	}
	if (&scopeProblem{401, "Unauthorized"}).publicMessage() != "Unauthorized" {
		t.Fatal("other statuses keep their message")
	}
}

func TestInterpretStoredModule(t *testing.T) {
	network := moduleSettings[1]
	if interpretStoredModule(network, false, false) {
		t.Fatal("auto default without field tester is false")
	}
	if !interpretStoredModule(network, false, true) {
		t.Fatal("auto default with field tester is true")
	}
	if !interpretStoredModule(moduleSettings[0], false, false) {
		t.Fatal("shipped default true")
	}
}

func TestNameUpdateDeadline(t *testing.T) {
	if nameUpdateDeadlineMS() != 5000 {
		t.Fatalf("default name update deadline = %v", nameUpdateDeadlineMS())
	}
	t.Setenv("OSI_CHIRPSTACK_GRPC_DEADLINE_MS", "2000")
	if nameUpdateDeadlineMS() != 2000 {
		t.Fatal("general deadline caps the name update budget")
	}
	t.Setenv("OSI_CHIRPSTACK_GRPC_DEADLINE_MS", "9000")
	if nameUpdateDeadlineMS() != 5000 {
		t.Fatal("name update deadline is capped at 5000")
	}
}

func TestLoneSurrogateVariants(t *testing.T) {
	if _, err := normalizeEntityName(parseValue(t, "\"\\ud800\"")); err == nil || err.code != "name_invalid_unicode" {
		t.Fatalf("high surrogate alone: %v", err)
	}
	if _, err := normalizeEntityName(parseValue(t, "\"\\udc00\"")); err == nil || err.code != "name_invalid_unicode" {
		t.Fatalf("low surrogate alone: %v", err)
	}
}
