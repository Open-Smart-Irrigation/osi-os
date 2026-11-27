package main

import (
	"context"
	"errors"
	"math"
	"slices"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/jscollate"
	"osi-edge/internal/jsvalue"
)

func validValveLifecycle(value jsvalue.Value) bool {
	if value.Kind != jsvalue.Object || !valveWhole(value.Get("v"), 1, 1) ||
		!lifecycleText(value.Get("revision")) || !lifecycleText(value.Get("reason")) ||
		!lifecycleText(value.Get("prepared_at")) ||
		!lifecycleEnum(value.Get("state"), "PENDING", "READY", "SUPERSEDED") ||
		!lifecycleEnum(value.Get("generation"), "GEN1", "GEN2") {
		return false
	}
	device := value.Get("device")
	eui := device.Get("device_eui")
	if device.Kind != jsvalue.Object || !lifecycleInteger(device.Get("row_id")) ||
		eui.Kind != jsvalue.String || !hex16.MatchString(eui.MustString()) ||
		!lifecycleEnum(device.Get("type_id"), valveType) ||
		!lifecycleOptional(device.Get("user_id"), lifecycleInteger) ||
		!lifecycleOptional(device.Get("irrigation_zone_id"), lifecycleInteger) ||
		!lifecycleOptional(device.Get("deleted_at"), lifecycleText) {
		return false
	}
	zone, policy := value.Get("zone"), value.Get("policy")
	if !validLifecycleResource(zone, "zone_uuid") || !validLifecycleResource(policy, "policy_uuid") ||
		(policy.Kind == jsvalue.Object && !valveWhole(policy.Get("enabled"), 0, 1)) {
		return false
	}
	for _, key := range []string{"retired_schedules", "live_schedule_snapshot"} {
		schedules := value.Get(key)
		if schedules.Kind != jsvalue.Array || slices.ContainsFunc(schedules.List, func(row jsvalue.Value) bool {
			return !validLifecycleSchedule(row, eui)
		}) {
			return false
		}
	}
	return true
}

func lifecycleText(value jsvalue.Value) bool {
	return value.Kind == jsvalue.String && jsvalue.Trim(value.MustString()) != ""
}

func lifecycleInteger(value jsvalue.Value) bool {
	return valveWhole(value, 0, math.MaxFloat64)
}

func lifecycleOptional(value jsvalue.Value, valid func(jsvalue.Value) bool) bool {
	return value.Kind == jsvalue.Undefined || value.Kind == jsvalue.Null || valid(value)
}

func lifecycleEnum(value jsvalue.Value, allowed ...string) bool {
	return value.Kind == jsvalue.String && slices.Contains(allowed, value.MustString())
}

func validLifecycleResource(value jsvalue.Value, id string) bool {
	return value.Kind == jsvalue.Null || (value.Kind == jsvalue.Object &&
		lifecycleText(value.Get(id)) && lifecycleInteger(value.Get("sync_version")) &&
		lifecycleOptional(value.Get("deleted_at"), lifecycleText))
}

func validLifecycleSchedule(row, eui jsvalue.Value) bool {
	minutes := row.Get("duration_minutes")
	if row.Kind != jsvalue.Object || !lifecycleText(row.Get("schedule_uuid")) ||
		!valveEffectValuesEqual(row.Get("device_eui"), eui) || !lifecycleEnum(row.Get("kind"), "WEEKLY", "ONCE") ||
		!lifecycleText(row.Get("timezone")) || !valveWhole(row.Get("enabled"), 0, 1) ||
		!lifecycleInteger(row.Get("sync_version")) || minutes.Kind != jsvalue.Number || !(minutes.Num >= 0 && minutes.Num <= math.MaxFloat64) {
		return false
	}
	mask := row.Get("weekdays_mask")
	if mask.Kind != jsvalue.Null && mask.Kind != jsvalue.Undefined && !valveWhole(mask, 0, 127) {
		return false
	}
	for _, key := range []string{"label", "start_time", "fire_at", "once_state", "once_fired_at", "deleted_at", "condition_policy_uuid", "effective_from"} {
		if !lifecycleOptional(row.Get(key), lifecycleText) {
			return false
		}
	}
	return true
}

func (b *backend) sendPendingLifecycleClear(ctx context.Context, eui string, control jsvalue.Value, rows []jsvalue.Value, now time.Time) error {
	if err := validatePlanControl(control); err != nil {
		return err
	}
	lifecycle := control.Get("lifecycle_clear")
	revision := control.Get("desired_revision")
	if control.Get("mode").MustString() != "LIFECYCLE_CLEAR" || lifecycle.Get("state").MustString() == "SUPERSEDED" {
		return nil
	}
	bindingOK, err := lifecycleValveBindingMatches(ctx, b.db, eui, lifecycle)
	if err != nil {
		return err
	}
	ids := control.Get("required_push_ids").List
	rowsValid := len(rows) == len(ids)
	for _, row := range rows {
		transport, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		if err != nil || transport.Get("lifecycle_clear_revision").MustString() != revision.MustString() {
			rowsValid = false
		}
	}
	if !bindingOK || !rowsValid {
		reason := "binding_changed"
		if bindingOK {
			reason = "required_push_set_changed"
		}
		return b.supersedeLifecycleClear(ctx, eui, control, rows, reason, now)
	}

	if !slices.ContainsFunc(rows, clearPlanPushClaimable) {
		return nil
	}

	// Preserve stored required-push order across restarts.
	orderRequiredPlanRows(rows, ids)
	conflict, err := b.planConversionConflict(ctx, eui, now)
	if err != nil {
		return err
	}
	blocked, err := planBlockingObservation(ctx, b.db, eui)
	if err != nil {
		return err
	}
	uncertain := slices.ContainsFunc(rows, func(row jsvalue.Value) bool {
		_, uncertain := planClearEvidence(row)
		return uncertain
	})
	if !conflict.Truthy() && !blocked && !uncertain {
		var unfinished jsvalue.Value
		for _, intent := range slices.Backward(control.Get("flushes").List) {
			if intent.Get("flush_id").Truthy() && !planFlushComplete(intent) {
				unfinished = intent
				break
			}
		}
		flush, err := b.executePlanFlush(ctx, eui, "lifecycle_clear", unfinished, now)
		if err != nil {
			return err
		}
		tx, err := b.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err := supersedePlanClock(ctx, tx, eui, planFlushResult{id: flush.id}); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		control, err = loadValveControl(ctx, b.db, eui)
		if err != nil {
			return err
		}
		if !flush.ok {
			p := jsvalue.Property
			detail := ""
			if flush.problem != nil {
				detail = flush.problem.Error()
			}
			control.Set(p("readiness", planClearReadiness(revision, "FAILED", "flush_failed")))
			control.Set(p("flush_failure", jsvalue.Obj(p("flush_id", jsvalue.Str(flush.id)),
				p("phase", jsvalue.Str("UNKNOWN")), p("error", jsvalue.Str(detail)))))
			return errors.Join(flush.failure(), b.savePlanControl(ctx, eui, control))
		}
	}
	current, err := loadValveControl(ctx, b.db, eui)
	if err != nil || current.Get("desired_revision").MustString() != revision.MustString() {
		return err
	}
	bindingOK, err = lifecycleValveBindingMatches(ctx, b.db, eui, lifecycle)
	if err != nil {
		return err
	}
	if !bindingOK {
		return b.supersedeLifecycleClear(ctx, eui, current, rows, "binding_changed", now)
	}
	return b.sendPlanClearRows(ctx, eui, current, rows)
}

func readPlanBindingRow(ctx context.Context, db scheduleQueryer, query string, key jsvalue.Value) (jsvalue.Value, error) {
	rows, err := queryZones(ctx, db, query, scheduleSQLValue(key))
	if err != nil || len(rows) == 0 {
		return jsvalue.Nil(), err
	}
	return rows[0], nil
}

func readValveLifecycleBinding(ctx context.Context, db scheduleQueryer, eui string, policyID jsvalue.Value, retiredIDs []jsvalue.Value, retireLive bool) (jsvalue.Value, error) {
	device, err := readPlanBindingRow(ctx, db, `SELECT id AS row_id,UPPER(deveui) AS device_eui,type_id,user_id,irrigation_zone_id,deleted_at
		FROM devices WHERE UPPER(deveui)=?`, jsvalue.Str(eui))
	if err != nil || device.Get("type_id").MustString() != valveType {
		return jsvalue.Value{}, err
	}
	settings, err := planSettings(ctx, db, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	zone, err := readPlanBindingRow(ctx, db, "SELECT zone_uuid,COALESCE(sync_version,0) AS sync_version,deleted_at FROM irrigation_zones WHERE id=?", device.Get("irrigation_zone_id"))
	if err != nil {
		return jsvalue.Value{}, err
	}
	policy, err := readPlanBindingRow(ctx, db, "SELECT policy_uuid,COALESCE(sync_version,0) AS sync_version,enabled,deleted_at FROM irrigation_policies WHERE policy_uuid=?", policyID)
	if err != nil {
		return jsvalue.Value{}, err
	}
	const columns = `SELECT schedule_uuid,UPPER(device_eui) AS device_eui,kind,label,weekdays_mask,start_time,fire_at,
		duration_minutes,timezone,enabled,once_state,once_fired_at,COALESCE(sync_version,0) AS sync_version,
		deleted_at,condition_policy_uuid,effective_from FROM valve_schedules WHERE UPPER(device_eui)=?`
	// push.js sorts both lists with lifecycleScheduleSort, a stable
	// String.prototype.localeCompare sort (lifecycleScheduleSort below). The
	// SQL order is the base: for UUID-shaped values it is already NOCASE
	// order with lower case first between values equal but for case.
	const order = " ORDER BY schedule_uuid COLLATE NOCASE, schedule_uuid DESC"
	live, err := queryZones(ctx, db, columns+" AND deleted_at IS NULL"+order, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	lifecycleScheduleSort(live)
	retired := live
	if !retireLive {
		retired, err = queryZones(ctx, db, columns+" AND schedule_uuid IN (SELECT value FROM json_each(?))"+order,
			eui, valveJSON(jsvalue.Arr(retiredIDs...)))
		if err != nil || len(retired) != len(retiredIDs) {
			return jsvalue.Value{}, err
		}
		lifecycleScheduleSort(retired)
	}
	p := jsvalue.Property
	return jsvalue.Obj(p("device", device), p("generation", settings.Get("strega_generation")), p("zone", zone),
		p("policy", policy), p("retired_schedules", jsvalue.Arr(retired...)), p("live_schedule_snapshot", jsvalue.Arr(live...))), nil
}

func lifecycleBindingKeys(binding jsvalue.Value) (jsvalue.Value, []jsvalue.Value) {
	policyID := binding.Get("policy").Get("policy_uuid")
	var retiredIDs []jsvalue.Value
	for _, schedule := range binding.Get("retired_schedules").List {
		retiredIDs = append(retiredIDs, schedule.Get("schedule_uuid"))
		if !policyID.Truthy() && schedule.Get("condition_policy_uuid").Truthy() {
			policyID = schedule.Get("condition_policy_uuid")
		}
	}
	return policyID, retiredIDs
}

func lifecycleValveBindingMatches(ctx context.Context, db scheduleQueryer, eui string, binding jsvalue.Value) (bool, error) {
	policyID, retiredIDs := lifecycleBindingKeys(binding)
	current, err := readValveLifecycleBinding(ctx, db, eui, policyID, retiredIDs, false)
	return sameValveLifecycleBinding(current, binding), err
}

func sameValveLifecycleBinding(current, saved jsvalue.Value) bool {
	for _, key := range []string{"device", "generation", "zone", "policy", "retired_schedules", "live_schedule_snapshot"} {
		value := current.Get(key)
		if value.Kind == jsvalue.Undefined || saved.Get(key).Kind == jsvalue.Undefined || valveJSON(value) != valveJSON(saved.Get(key)) {
			return false
		}
	}
	return true
}

func prepareLifecyclePlanClear(ctx context.Context, tx planWriter, eui string, binding jsvalue.Value, reason string, now time.Time) (jsvalue.Value, error) {
	if !hex16.MatchString(eui) {
		return jsvalue.Value{}, scheduleRefusal(500, "invalid_device_eui", "invalid_device_eui")
	}
	control, err := loadValveControl(ctx, tx, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	if err := validatePlanControl(control); err != nil {
		return jsvalue.Value{}, err
	}
	prior, err := queryZones(ctx, tx, "SELECT push_id,state,transport_json FROM valve_schedule_pushes WHERE UPPER(device_eui)=? AND state<>'ACKED' AND purpose IN "+planPushPurposes+" ORDER BY rowid", eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	predecessors := make([]jsvalue.Value, 0, len(prior))
	for _, row := range prior {
		id := row.Get("push_id")
		predecessors = append(predecessors, id)
		phase, uncertain := planClearEvidence(row)
		if phase == "" && !uncertain {
			if _, err := tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=? AND state='QUEUED'", id.MustString()); err != nil {
				return jsvalue.Value{}, err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_settings WHERE key=?", pendingValvePlan+eui); err != nil {
		return jsvalue.Value{}, err
	}

	p := jsvalue.Property
	revision, stamp := jsvalue.Str(uuid.NewString()), jsvalue.Str(valveISO(now))
	generation := binding.Get("generation")
	frames := weekdayFrames([7][]planWindow{}, generation.MustString(), false)
	marker := jsvalue.Obj(p("lifecycle_clear_revision", revision))
	ids, err := insertPlanPushes(ctx, tx, eui, frames, marker)
	if err != nil {
		return jsvalue.Value{}, err
	}
	lifecycle := jsvalue.Obj(p("v", jsvalue.Num(1)), p("revision", revision), p("state", jsvalue.Str("PENDING")),
		p("reason", jsvalue.Str(reason)), p("prepared_at", stamp))
	lifecycle.Fields = append(lifecycle.Fields, binding.Fields...)
	control.Set(p("mode", jsvalue.Str("LIFECYCLE_CLEAR")))
	control.Set(p("generation", generation))
	control.Set(p("desired_revision", revision))
	control.Set(p("required_push_ids", jsvalue.Arr(ids...)))
	control.Set(p("predecessor_push_ids", jsvalue.Arr(predecessors...)))
	control.Set(p("readiness", planClearReadiness(revision, "PENDING", "awaiting_clear_ack")))
	control.Set(p("prepared_at", stamp))
	control.Set(p("reason", jsvalue.Str(reason)))
	control.Set(p("lifecycle_clear", lifecycle))
	return control, writePlanControl(ctx, tx, eui, control)
}

func (b *backend) resendLifecycleClear(ctx context.Context, eui string, control jsvalue.Value, now time.Time) (int, error) {
	if err := validatePlanControl(control); err != nil {
		return 0, err
	}
	lifecycle := control.Get("lifecycle_clear")
	matches, err := lifecycleValveBindingMatches(ctx, b.db, eui, lifecycle)
	if err != nil {
		return 0, err
	}
	if !matches {
		// The oracle invalidates the binding, then answers 500 when the
		// obsolete result has no rows to count for pushes_queued.
		err := b.supersedeLifecycleClear(ctx, eui, control, nil, "binding_changed", now)
		return 0, errors.Join(errors.New("obsolete lifecycle clear"), err)
	}
	rows, err := requiredPlanRows(ctx, b.db, eui, control.Get("required_push_ids"))
	if err != nil {
		return 0, err
	}
	if slices.ContainsFunc(rows, preacceptancePlanFailure) {
		err := b.db.withImmediateTx(ctx, func(tx *farmConn) error {
			policyID, retiredIDs := lifecycleBindingKeys(lifecycle)
			binding, err := readValveLifecycleBinding(ctx, tx, eui, policyID, retiredIDs, false)
			if err != nil {
				return err
			}
			if !sameValveLifecycleBinding(binding, lifecycle) {
				return errors.New("lifecycle clear binding changed during resend")
			}
			control, err = prepareLifecyclePlanClear(ctx, tx, eui, binding, "retry", now)
			return err
		})
		if err != nil {
			return 0, err
		}
		rows, err = requiredPlanRows(ctx, b.db, eui, control.Get("required_push_ids"))
		if err != nil {
			return 0, err
		}
	}
	return len(rows), b.sendPendingLifecycleClear(ctx, eui, control, rows, now)
}

func (b *backend) supersedeLifecycleClear(ctx context.Context, eui string, control jsvalue.Value, rows []jsvalue.Value, reason string, now time.Time) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	p := jsvalue.Property
	lifecycle := control.Get("lifecycle_clear")
	lifecycle.Set(p("state", jsvalue.Str("SUPERSEDED")))
	lifecycle.Set(p("superseded_at", jsvalue.Str(valveISO(now))))
	lifecycle.Set(p("superseded_reason", jsvalue.Str(reason)))
	control.Set(p("lifecycle_clear", lifecycle))
	setFixedPlanMode(&control, "lifecycle_clear_superseded")
	if err := writePlanControl(ctx, tx, eui, control); err != nil {
		return err
	}
	for _, row := range rows {
		if clearPlanPushClaimable(row) {
			if _, err := tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=? AND state='QUEUED'",
				row.Get("push_id").MustString()); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// lifecycleScheduleSort is push.js lifecycleScheduleSort:
// String(a.schedule_uuid).localeCompare(String(b.schedule_uuid)), a stable
// sort; fixedScheduleSnapshot sorts with the same comparator. The parity
// target is the gateway's Node (small ICU 75.1, CLDR 45 root collation, as
// edge/vectors/intl-gateway.vectors.json records it); jscollate reproduces it.
func lifecycleScheduleSort(rows []jsvalue.Value) {
	type keyed struct {
		key []uint16 // String(value)'s UTF-16 code units, lone surrogates kept
		row jsvalue.Value
	}
	list := make([]keyed, len(rows))
	for i, row := range rows {
		id := row.Get("schedule_uuid")
		if raw, ok := storedBufferBytes(id); ok {
			list[i] = keyed{jsvalue.Str(string(raw)).Text, row}
		} else {
			text, err := id.StringValue()
			if err != nil {
				panic(err) // as MustString: String() throws out of the sort
			}
			list[i] = keyed{text.Text, row}
		}
	}
	slices.SortStableFunc(list, func(a, b keyed) int { return jscollate.CompareUTF16(a.key, b.key) })
	for i := range list {
		rows[i] = list[i].row
	}
}
