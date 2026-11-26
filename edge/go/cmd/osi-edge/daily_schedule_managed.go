package main

import (
	"context"
	"errors"
	"slices"
	"time"

	"osi-edge/internal/jsvalue"
)

func pauseManagedDailySchedule(ctx context.Context, tx *farmConn, zoneID float64, policyID string, now time.Time) (jsvalue.Value, error) {
	at := valveISO(now)
	paused, err := tx.ExecContext(ctx, `UPDATE irrigation_policies SET enabled=0,updated_at=?,sync_version=COALESCE(sync_version,0)+1
		WHERE policy_uuid=? AND enabled=1 AND deleted_at IS NULL`, at, policyID)
	if err != nil {
		return jsvalue.Value{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE irrigation_occurrences SET state='SKIPPED',decision='SKIPPED',
		decision_reason='legacy_schedule_disabled',decision_at=?,updated_at=?
		WHERE policy_uuid=? AND state IN ('PENDING','CLAIMED')`, at, at, policyID); err != nil {
		return jsvalue.Value{}, err
	}
	disabled, err := tx.ExecContext(ctx, `UPDATE irrigation_schedules SET enabled=0,updated_at=?,sync_version=COALESCE(sync_version,0)+1
		WHERE irrigation_zone_id=? AND enabled=1 AND deleted_at IS NULL`, at, zoneID)
	if err != nil {
		return jsvalue.Value{}, err
	}
	policyChanges, err := paused.RowsAffected()
	if err != nil {
		return jsvalue.Value{}, err
	}
	legacyChanges, err := disabled.RowsAffected()
	if err != nil {
		return jsvalue.Value{}, err
	}
	policy, err := readPlanBindingRow(ctx, tx, "SELECT * FROM irrigation_policies WHERE policy_uuid=?", jsvalue.Str(policyID))
	if err != nil {
		return jsvalue.Value{}, err
	}
	valves, err := queryZones(ctx, tx, `SELECT UPPER(vs.device_eui) AS eui
		FROM valve_schedules vs JOIN devices d ON UPPER(d.deveui)=UPPER(vs.device_eui)
		WHERE vs.condition_policy_uuid=? AND vs.deleted_at IS NULL AND d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL
		GROUP BY UPPER(vs.device_eui) ORDER BY MIN(vs.schedule_uuid)`, policyID)
	if err != nil {
		return jsvalue.Value{}, err
	}

	p := jsvalue.Property
	var clears []jsvalue.Value
	for _, valve := range valves {
		eui := valve.Get("eui").MustString()
		binding, err := readValveLifecycleBinding(ctx, tx, eui, jsvalue.Str(policyID), nil, true)
		if err != nil {
			return jsvalue.Value{}, err
		}
		live := binding.Get("live_schedule_snapshot").List
		// A schedule from a different authority fences the clear for this valve.
		if len(live) == 0 || slices.ContainsFunc(live, func(schedule jsvalue.Value) bool {
			return schedule.Get("condition_policy_uuid").MustString() != policyID
		}) {
			continue
		}
		control, err := prepareLifecyclePlanClear(ctx, tx, eui, binding, "lifecycle_clear", now)
		if err != nil && errors.Is(err, errPlanControlMalformed) {
			return jsvalue.Value{}, scheduleRefusal(500, err.Error(), err.Error())
		}
		if err != nil {
			return jsvalue.Value{}, err
		}
		clears = append(clears, jsvalue.Obj(p("pending", jsvalue.Bool(true)), p("device_eui", jsvalue.Str(eui)),
			p("revision", control.Get("desired_revision")), p("reason", jsvalue.Str("transport_unavailable"))))
	}
	changed := 0.0
	if policyChanges != 0 || legacyChanges != 0 {
		changed = 1
	}
	return jsvalue.Obj(p("message", jsvalue.Str("Managed conditional policy paused; legacy schedule disabled")),
		p("disabledSchedules", jsvalue.Num(changed)), p("policy", policy), p("clear_results", jsvalue.Arr(clears...))), nil
}
