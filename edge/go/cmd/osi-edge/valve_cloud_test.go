package main

import (
	"errors"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"osi-edge/internal/jsvalue"
)

func TestValidPlanIncident(t *testing.T) {
	cases := map[string]bool{
		`null`: true,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN"}`:                                       true,
		`{"incident_id":"i","physical_run_reference":"r","ended":true,"state":"ENDED","ended_at":"2026-11-23T06:10:00.000Z"}`: true,
		`{"incident_id":"i","physical_run_reference":"r","ended":true,"state":"RECONCILED","ended_at":"2026-11-23 06:10:00"}`: true,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN","retry_revision":null}`:                 true,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN","retry_revision":"rev"}`:                true,
		`[]`:  false,
		`"x"`: false,
		`{"incident_id":"","physical_run_reference":"r","ended":false,"state":"OPEN"}`:                                       false,
		`{"incident_id":1,"physical_run_reference":"r","ended":false,"state":"OPEN"}`:                                        false,
		`{"incident_id":"i","physical_run_reference":"","ended":false,"state":"OPEN"}`:                                       false,
		`{"incident_id":"i","physical_run_reference":"r","ended":0,"state":"OPEN"}`:                                          false,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"open"}`:                                      false,
		`{"incident_id":"i","physical_run_reference":"r","ended":true,"state":"OPEN","ended_at":"2026-11-23T06:10:00.000Z"}`: false,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"ENDED"}`:                                     false,
		`{"incident_id":"i","physical_run_reference":"r","ended":true,"state":"ENDED"}`:                                      false,
		`{"incident_id":"i","physical_run_reference":"r","ended":true,"state":"ENDED","ended_at":"garbage"}`:                 false,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN","reconciled_at":"garbage"}`:            false,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN","reconciled_at":5}`:                    false,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN","retry_revision":"   "}`:               false,
		`{"incident_id":"i","physical_run_reference":"r","ended":false,"state":"OPEN","retry_revision":7}`:                   false,
	}
	for text, want := range cases {
		value, err := jsvalue.Parse([]byte(text))
		if err != nil {
			t.Fatal(text, err)
		}
		if got := validPlanIncident(value); got != want {
			t.Errorf("validPlanIncident(%s) = %v, want %v", text, got, want)
		}
		control := jsvalue.Obj(jsvalue.Property("mode", jsvalue.Str("FIXED")), jsvalue.Property("incident", value))
		err = validatePlanControl(control)
		if (err == nil) != want {
			t.Errorf("validatePlanControl(incident %s) = %v", text, err)
		}
		if err != nil && (!errors.Is(err, errPlanControlMalformed) || err.Error() != "conditional_incident_malformed") {
			t.Errorf("incident refusal %v is not parseIncident's", err)
		}
	}
	if err := validatePlanControl(jsvalue.Obj(jsvalue.Property("mode", jsvalue.Str("FIXED")))); err != nil {
		t.Errorf("a control without incident is refused: %v", err)
	}
}

func TestManualValveFailureDetail(t *testing.T) {
	rpc := status.Error(codes.Unavailable, "synthetic enqueue outage")
	for _, c := range []struct {
		phase string
		err   error
		want  string
	}{
		{"invalid_device_eui", errInvalidValveEUI, "device_eui must be a 16-character hexadecimal EUI"},
		{"valve_busy", nil, "valve has an active or unresolved command"},
		{"UNKNOWN", rpc, "synthetic enqueue outage"},
		{"UNKNOWN", errors.Join(nil, valveRPCError{message: valveRPCMessage(rpc), cause: rpc}), "synthetic enqueue outage"},
		{"enqueue_rejected", status.Error(codes.InvalidArgument, "bad frame"), "bad frame"},
		{"UNKNOWN", nil, "STREGA transport did not accept the command"},
	} {
		if got := manualValveFailureDetail(c.phase, c.err); got != c.want {
			t.Errorf("manualValveFailureDetail(%s, %v) = %q, want %q", c.phase, c.err, got, c.want)
		}
	}
	wrapped := valveRPCError{message: "synthetic enqueue outage", cause: rpc}
	if status.Code(wrapped) != codes.Unavailable {
		t.Errorf("valveRPCError hides the status code")
	}
}

func TestLedgerReplayStatus(t *testing.T) {
	for result, want := range map[string]string{"APPLIED": "ACKED", "CONFLICT": "CONFLICT", "FAILED_RETRYABLE": "FAILED_RETRYABLE",
		"UNKNOWN": "UNKNOWN", "REJECTED_PERMANENT": "NACKED", "NACKED": "NACKED", "EXPIRED": "NACKED", "": "NACKED"} {
		if got := ledgerReplayStatus(result); got != want {
			t.Errorf("ledgerReplayStatus(%q) = %q, want %q", result, got, want)
		}
	}
}
