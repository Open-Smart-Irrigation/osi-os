package main

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"slices"

	"osi-edge/internal/jsvalue"
)

var errClaimControlMalformed = errors.New("conditional_control_malformed")

// The claim holds the valve writer and its transaction while replacing the
// lifecycle authority. Any malformed control rolls back the binding change.
func supersedeClaimLifecycle(ctx context.Context, tx *farmTx, eui, now string) error {
	var raw sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=?", eui).Scan(&raw); err != nil {
		return err
	}
	control, err := valveStoredJSON(raw.String)
	if err != nil {
		return errClaimControlMalformed
	}
	if err := validateClaimControl(control); err != nil {
		return err
	}
	if !claimOneOf(control.Get("mode"), "LIFECYCLE_CLEAR") {
		return nil
	}
	lifecycle := control.Get("lifecycle_clear")
	lifecycle.Set(jsvalue.Property("state", jsvalue.Str("SUPERSEDED")))
	lifecycle.Set(jsvalue.Property("superseded_at", jsvalue.Str(now)))
	lifecycle.Set(jsvalue.Property("superseded_reason", jsvalue.Str("claim_changed")))
	setFixedPlanMode(&control, "lifecycle_clear_superseded")
	control.Set(jsvalue.Property("lifecycle_clear", lifecycle))
	return writePlanControl(ctx, tx, eui, control)
}

func validateClaimControl(control jsvalue.Value) error {
	for _, key := range []string{"opaque", "flushes", "required_push_ids", "predecessor_push_ids"} {
		value := control.Get(key)
		if value.Kind != jsvalue.Undefined && value.Kind != jsvalue.Array {
			return errClaimControlMalformed
		}
		if key == "required_push_ids" || key == "predecessor_push_ids" {
			for _, id := range value.List {
				if id.Kind != jsvalue.String || len(id.Text) == 0 {
					return errClaimControlMalformed
				}
			}
		}
	}
	if readiness := control.Get("readiness"); readiness.Kind != jsvalue.Undefined && readiness.Kind != jsvalue.Object {
		return errClaimControlMalformed
	}
	if !validClaimIncident(control.Get("incident")) {
		return errors.New("conditional_incident_malformed")
	}
	lifecycle := control.Get("lifecycle_clear")
	if lifecycle.Kind != jsvalue.Undefined && !validClaimLifecycle(lifecycle) {
		return errClaimControlMalformed
	}
	if claimOneOf(control.Get("mode"), "LIFECYCLE_CLEAR") &&
		(lifecycle.Kind != jsvalue.Object || !claimOneOf(control.Get("desired_revision"), lifecycle.Get("revision").MustString())) {
		return errClaimControlMalformed
	}
	return nil
}

func validClaimIncident(incident jsvalue.Value) bool {
	if nullish(incident).Kind == jsvalue.Null {
		return true
	}
	id := incident.Get("incident_id")
	ref := incident.Get("physical_run_reference")
	state := incident.Get("state")
	ended := incident.Get("ended")
	if incident.Kind != jsvalue.Object || id.Kind != jsvalue.String || len(id.Text) == 0 ||
		ref.Kind != jsvalue.String || len(ref.Text) == 0 || ended.Kind != jsvalue.Boolean ||
		!claimOneOf(state, "OPEN", "ENDED", "RECONCILED") || ended.Bool == claimOneOf(state, "OPEN") {
		return false
	}
	if at := incident.Get("ended_at"); ended.Bool && (at.Kind != jsvalue.String || valveInstant(at.MustString()).IsZero()) {
		return false
	}
	if at := incident.Get("reconciled_at"); nullish(at).Kind != jsvalue.Null &&
		(at.Kind != jsvalue.String || valveInstant(at.MustString()).IsZero()) {
		return false
	}
	return claimNullableString(incident.Get("retry_revision"))
}

func validClaimLifecycle(value jsvalue.Value) bool {
	version := value.Get("v")
	if value.Kind != jsvalue.Object || version.Kind != jsvalue.Number || version.Num != 1 ||
		!claimNonemptyString(value.Get("revision")) || !claimOneOf(value.Get("state"), "PENDING", "READY", "SUPERSEDED") ||
		!claimNonemptyString(value.Get("reason")) || !claimNonemptyString(value.Get("prepared_at")) ||
		!claimOneOf(value.Get("generation"), "GEN1", "GEN2") {
		return false
	}
	device := value.Get("device")
	eui := jsOrText(device.Get("device_eui"))
	if device.Kind != jsvalue.Object || !hex16.MatchString(eui) || !claimOneOf(device.Get("type_id"), "STREGA_VALVE") ||
		!claimNonnegativeInteger(device.Get("row_id")) || !claimNullableInteger(device.Get("user_id")) ||
		!claimNullableInteger(device.Get("irrigation_zone_id")) || !claimNullableString(device.Get("deleted_at")) {
		return false
	}
	zone := value.Get("zone")
	if zone.Kind != jsvalue.Null && (zone.Kind != jsvalue.Object || !claimNonemptyString(zone.Get("zone_uuid")) ||
		!claimNonnegativeInteger(zone.Get("sync_version")) || !claimNullableString(zone.Get("deleted_at"))) {
		return false
	}
	policy := value.Get("policy")
	if policy.Kind != jsvalue.Null && (policy.Kind != jsvalue.Object || !claimNonemptyString(policy.Get("policy_uuid")) ||
		!claimNonnegativeInteger(policy.Get("sync_version")) || !claimNullableString(policy.Get("deleted_at")) ||
		!claimIntegerFlag(policy.Get("enabled"))) {
		return false
	}
	for _, key := range []string{"retired_schedules", "live_schedule_snapshot"} {
		schedules := value.Get(key)
		if schedules.Kind != jsvalue.Array {
			return false
		}
		for _, schedule := range schedules.List {
			if !validClaimSchedule(schedule, eui) {
				return false
			}
		}
	}
	return true
}

func validClaimSchedule(schedule jsvalue.Value, eui string) bool {
	weekdays := schedule.Get("weekdays_mask")
	duration := schedule.Get("duration_minutes")
	if schedule.Kind != jsvalue.Object || !claimOneOf(schedule.Get("device_eui"), eui) ||
		!claimNonemptyString(schedule.Get("schedule_uuid")) || !claimOneOf(schedule.Get("kind"), "WEEKLY", "ONCE") ||
		!claimNullableInteger(weekdays) || weekdays.Num > 127 ||
		duration.Kind != jsvalue.Number || math.IsNaN(duration.Num) || math.IsInf(duration.Num, 0) || duration.Num < 0 ||
		!claimNonemptyString(schedule.Get("timezone")) || !claimIntegerFlag(schedule.Get("enabled")) ||
		!claimNonnegativeInteger(schedule.Get("sync_version")) {
		return false
	}
	for _, key := range []string{"label", "start_time", "fire_at", "once_state", "once_fired_at", "deleted_at", "condition_policy_uuid", "effective_from"} {
		if !claimNullableString(schedule.Get(key)) {
			return false
		}
	}
	return true
}

func claimOneOf(value jsvalue.Value, choices ...string) bool {
	return value.Kind == jsvalue.String && slices.Contains(choices, value.MustString())
}

func claimNonemptyString(value jsvalue.Value) bool {
	return value.Kind == jsvalue.String && value.TrimmedString().Truthy()
}

func claimNullableString(value jsvalue.Value) bool {
	return nullish(value).Kind == jsvalue.Null || claimNonemptyString(value)
}

func claimNonnegativeInteger(value jsvalue.Value) bool {
	return value.Kind == jsvalue.Number && value.Num >= 0 && !math.IsInf(value.Num, 0) && math.Trunc(value.Num) == value.Num
}

func claimNullableInteger(value jsvalue.Value) bool {
	return nullish(value).Kind == jsvalue.Null || claimNonnegativeInteger(value)
}

func claimIntegerFlag(value jsvalue.Value) bool {
	return value.Kind == jsvalue.Number && (value.Num == 0 || value.Num == 1)
}
