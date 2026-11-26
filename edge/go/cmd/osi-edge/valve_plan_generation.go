package main

import (
	"context"
	"log"
	"slices"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/jsvalue"
)

func pendingFixedValveTransition(transition jsvalue.Value) bool {
	id := transition.Get("transition_id")
	return transition.Get("state").MustString() == "PENDING" &&
		transition.Get("from").MustString() == "GEN1" && transition.Get("to").MustString() == "GEN2" &&
		id.Kind == jsvalue.String && id.Truthy()
}

func preparedFixedValveTransition(transition jsvalue.Value) bool {
	revision := transition.Get("plan_revision")
	return revision.Kind == jsvalue.String && revision.Truthy() && len(transition.Get("required_push_ids").List) > 0
}

func (b *backend) reconcileValveGeneration(ctx context.Context, eui, currentProfile string) error {
	settings, err := planSettings(ctx, b.db, eui)
	if err != nil || settings.Get("strega_generation").MustString() != "GEN2" {
		return err
	}
	targetProfile := envValveValue("CHIRPSTACK_PROFILE_STREGA_GEN2")
	if targetProfile == "" {
		log.Printf("valve %s GEN2 profile is unset", eui)
		return nil
	}
	schedules, err := queryZones(ctx, b.db, planRowsSQL, eui)
	if err != nil {
		return err
	}
	conditional, err := planScheduleMode(ctx, b.db, schedules)
	if err != nil {
		return err
	}
	control, err := loadValveControl(ctx, b.db, eui)
	if err != nil {
		return err
	}
	if err := validatePlanControl(control); err != nil {
		return err
	}
	now := time.Now()
	transition := control.Get("fixed_generation_transition")
	fixedPending := !conditional && pendingFixedValveTransition(transition)
	if fixedPending {
		// push.js prepareFixedGenerationTransition runs under withValveWriter,
		// whose normalizeDevice refuses a non-16-hex key before any write.
		if _, valid := normalizeValveDispatchEUI(eui); !valid {
			return errInvalidValveEUI
		}
		// Bind the exact set before any provisioning or queue I/O.
		transition, err = b.prepareFixedValveTransition(ctx, eui, now)
		if err != nil {
			return err
		}
	} else if currentProfile == targetProfile {
		if !conditional {
			return nil
		}
		needs, err := b.conditionalGenerationNeedsWork(ctx, eui, control)
		if err != nil || !needs {
			return err
		}
	}
	// valve-ack-fn builds the client once reconciliation is needed, before
	// the profile swap and the transition or clear sends; a throw there
	// ends the reconciliation (its catch warns).
	if err := chirpstackClientConfigError(); err != nil {
		return err
	}
	if currentProfile != targetProfile {
		radio, err := openValveRadio()
		if err != nil {
			return err
		}
		defer radio.conn.Close()
		swapped, problem := radio.setDeviceProfile(ctx, eui, targetProfile)
		if problem != nil {
			return problem.err
		}
		if !swapped {
			return nil
		}
	}
	if fixedPending && transition.Get("state").MustString() != "SUPERSEDED" {
		return b.sendFixedValveTransition(ctx, eui, transition, now)
	}
	if conditional {
		if control.Get("mode").MustString() == "CONDITIONAL" && control.Get("generation").MustString() == "GEN2" &&
			control.Get("desired_revision").Truthy() && len(control.Get("required_push_ids").List) > 0 {
			return b.sendConditionalPlanClear(ctx, eui, control, now)
		}
		_, err := b.compileConditionalClear(ctx, eui, "resend", now)
		return err
	}
	_, _, err = b.queueFixedPlan(ctx, eui, "UTC", now)
	return err
}

func (b *backend) conditionalGenerationNeedsWork(ctx context.Context, eui string, control jsvalue.Value) (bool, error) {
	if control.Get("mode").MustString() != "CONDITIONAL" || control.Get("generation").MustString() != "GEN2" ||
		!control.Get("desired_revision").Truthy() {
		return true, nil
	}
	if control.Get("readiness").Get("state").MustString() == "READY" {
		return false, nil
	}
	ids := control.Get("required_push_ids")
	if len(ids.List) == 0 {
		return true, nil
	}
	rows, err := requiredPlanRows(ctx, b.db, eui, ids)
	if err != nil || len(rows) != len(ids.List) {
		return false, err
	}
	for _, row := range rows {
		if badPlanACK(row) {
			return false, nil
		}
	}
	for _, row := range rows {
		phase, uncertain := planClearEvidence(row)
		if phase != "" {
			if uncertain {
				return true, nil
			}
			continue
		}
		switch row.Get("state").MustString() {
		case "QUEUED":
			return true, nil
		case "FAILED":
			if slices.Contains([]string{"enqueue_failed", "enqueue_failed_before_acceptance", "enqueue_rejected",
				"flush_failed", "no_ack_24h", "transport_failed", "transport_uncertain"}, row.Get("error").MustString()) {
				return true, nil
			}
		}
	}
	return false, nil
}

func (b *backend) prepareFixedValveTransition(ctx context.Context, eui string, now time.Time) (jsvalue.Value, error) {
	var transition jsvalue.Value
	err := b.db.withImmediateTx(ctx, func(tx *farmConn) error {
		p := jsvalue.Property
		control, err := loadValveControl(ctx, tx, eui)
		if err != nil {
			return err
		}
		transition = control.Get("fixed_generation_transition")
		if !pendingFixedValveTransition(transition) {
			return nil
		}
		schedules, err := queryZones(ctx, tx, planRowsSQL, eui)
		if err != nil {
			return err
		}
		if preparedFixedValveTransition(transition) {
			if !sameFixedValveSnapshot(transition, schedules, "") {
				supersedeFixedValveTransition(&control, now)
				transition = control.Get("fixed_generation_transition")
				return writePlanControl(ctx, tx, eui, control)
			}
			return nil
		}
		for _, key := range []string{"plan_revision", "required_push_ids"} {
			if v := transition.Get(key); v.Kind != jsvalue.Undefined && v.Kind != jsvalue.Null {
				return nil
			}
		}
		conditional, err := planScheduleMode(ctx, tx, schedules)
		if err != nil || conditional {
			return err
		}
		frames, err := fixedPlanFrames(ctx, tx, eui, true)
		if err != nil {
			return err
		}
		frames = append(frames, planPush{purpose: "CLOCK_SYNC", port: 13, data: []byte{1}})
		if err := supersedePlanPushes(ctx, tx, eui); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM app_settings WHERE key=?", pendingValvePlan+eui); err != nil {
			return err
		}
		ids, err := insertPlanPushes(ctx, tx, eui, frames, jsvalue.Value{})
		if err != nil {
			return err
		}
		at := valveISO(now)
		transition.Set(p("plan_revision", jsvalue.Str(uuid.NewString())))
		transition.Set(p("required_push_ids", jsvalue.Arr(ids...)))
		transition.Set(p("prepared_at", jsvalue.Str(at)))
		transition.Set(p("source_schedule_snapshot", fixedValveSnapshot(schedules, "")))
		control.Set(p("fixed_generation_transition", transition))
		if err := writePlanControl(ctx, tx, eui, control); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE valve_settings SET last_clock_sync_queued_at=?,updated_at=datetime('now') WHERE device_eui=?", at, eui)
		return err
	})
	return transition, err
}

func (b *backend) sendFixedValveTransition(ctx context.Context, eui string, transition jsvalue.Value, now time.Time) error {
	if !pendingFixedValveTransition(transition) || !preparedFixedValveTransition(transition) {
		return nil
	}
	schedules, err := queryZones(ctx, b.db, planRowsSQL, eui)
	if err != nil {
		return err
	}
	if !sameFixedValveSnapshot(transition, schedules, "") {
		control, err := loadValveControl(ctx, b.db, eui)
		if err != nil {
			return err
		}
		return b.invalidateFixedTransition(ctx, eui, "UTC", &control, now)
	}
	ids := transition.Get("required_push_ids")
	rows, err := requiredPlanRows(ctx, b.db, eui, ids)
	if err != nil || len(rows) != len(ids.List) {
		return err
	}
	orderRequiredPlanRows(rows, ids.List)
	blocked, err := planBlockingObservation(ctx, b.db, eui)
	if err != nil {
		return err
	}
	if !blocked && !slices.ContainsFunc(rows, func(row jsvalue.Value) bool {
		_, uncertain := planClearEvidence(row)
		return uncertain
	}) {
		flush, err := b.flushPlanQueue(ctx, eui, "fixed_generation_transition", now)
		if err != nil {
			return err
		}
		if err := b.db.withImmediateTx(ctx, func(tx *farmConn) error {
			return supersedePlanClock(ctx, tx, eui, planFlushResult{id: flush.id})
		}); err != nil {
			return err
		}
		if !flush.ok {
			return flush.failure()
		}
	}
	radio, err := openValveRadio()
	if err != nil {
		return err
	}
	defer radio.conn.Close()
	for _, row := range rows {
		if terminalPlanACK(row) {
			continue
		}
		if _, uncertain := planClearEvidence(row); uncertain {
			continue
		}
		if _, err := enqueuePlanPush(ctx, b.db, radio, eui, row); err != nil {
			log.Printf("valve %s GEN2 transition push: %v", eui, err)
		}
	}
	return b.applyFixedValveTransition(ctx, eui, transition)
}

func (b *backend) applyFixedValveTransition(ctx context.Context, eui string, prepared jsvalue.Value) error {
	return b.db.withImmediateTx(ctx, func(tx *farmConn) error {
		control, err := loadValveControl(ctx, tx, eui)
		if err != nil {
			return err
		}
		current := control.Get("fixed_generation_transition")
		if !pendingFixedValveTransition(current) || !preparedFixedValveTransition(current) ||
			!valveEffectValuesEqual(current.Get("transition_id"), prepared.Get("transition_id")) ||
			!valveEffectValuesEqual(current.Get("plan_revision"), prepared.Get("plan_revision")) ||
			valveJSON(current.Get("required_push_ids")) != valveJSON(prepared.Get("required_push_ids")) {
			return nil
		}
		ids := current.Get("required_push_ids")
		rows, err := requiredPlanRows(ctx, tx, eui, ids)
		if err != nil || len(rows) != len(ids.List) {
			return err
		}
		for _, row := range rows {
			phase, _ := planClearEvidence(row)
			if row.Get("state").MustString() != "ACKED" && phase != "ACCEPTED" {
				return nil
			}
		}
		p := jsvalue.Property
		current.Set(p("state", jsvalue.Str("APPLIED")))
		current.Set(p("applied_at", jsvalue.Str(valveISO(time.Now()))))
		control.Set(p("fixed_generation_transition", current))
		return writePlanControl(ctx, tx, eui, control)
	})
}
