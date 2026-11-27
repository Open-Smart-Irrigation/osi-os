package main

import (
	"testing"
	"time"

	"osi-edge/internal/jsvalue"
)

func TestDailyDendroUsesJavaScriptCaseMappingForMode(t *testing.T) {
	zone := parseValue(t, `{
		"scheduling_mode":"ſerver_preferred",
		"shared_environment_json":"{\"water\":{\"action\":{\"code\":\"increase_20\",\"source\":\"dendro\"}}}",
		"shared_environment_received_at":"2026-01-01T00:00:00Z"
	}`)
	now := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	decision := decideDailyDendro(zone, jsvalue.Obj(), 10, false, now)
	if decision.reason != "no_dendro_recommendation" {
		t.Fatalf("long s entered server-preferred mode: %s", decision.reason)
	}
}
