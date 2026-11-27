package main

import (
	"context"
	"errors"
	"log"
	"slices"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/status"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

// A disabled weekly edit can leave the existing conditional mode in place.
// Persist its replacement clear before trying the transport.
func (b *backend) compileConditionalClear(ctx context.Context, eui, reason string, now time.Time) (int, error) {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	settings, err := planSettings(ctx, tx, eui)
	if err != nil {
		return 0, err
	}
	control, err := loadValveControl(ctx, tx, eui)
	if err != nil {
		return 0, err
	}
	prior, err := queryZones(ctx, tx, "SELECT push_id FROM valve_schedule_pushes WHERE UPPER(device_eui)=? AND state<>'ACKED' AND purpose IN "+planPushPurposes+" ORDER BY rowid", eui)
	if err != nil {
		return 0, err
	}
	predecessors := make([]jsvalue.Value, 0, len(prior))
	for _, row := range prior {
		predecessors = append(predecessors, row.Get("push_id"))
	}
	if err := supersedePlanPushes(ctx, tx, eui); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_settings WHERE key=?", pendingValvePlan+eui); err != nil {
		return 0, err
	}
	generation := settings.Get("strega_generation")
	frames := weekdayFrames([7][]planWindow{}, generation.MustString(), false)
	ids, err := insertPlanPushes(ctx, tx, eui, frames, jsvalue.Value{})
	if err != nil {
		return 0, err
	}
	p := jsvalue.Property
	revision := jsvalue.Str(uuid.NewString())
	control.Set(p("mode", jsvalue.Str("CONDITIONAL")))
	control.Set(p("generation", generation))
	control.Set(p("desired_revision", revision))
	control.Set(p("required_push_ids", jsvalue.Arr(ids...)))
	control.Set(p("predecessor_push_ids", jsvalue.Arr(predecessors...)))
	control.Set(p("readiness", planClearReadiness(revision, "PENDING", "awaiting_clear_ack")))
	control.Set(p("prepared_at", jsvalue.Str(valveISO(now))))
	control.Set(p("reason", jsvalue.Str(reason)))
	if incident := control.Get("incident"); reason == "retry" && incident.Kind == jsvalue.Object {
		incident.Set(p("retry_revision", revision))
		control.Set(p("incident", incident))
	}
	if err := writePlanControl(ctx, tx, eui, control); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}

	err = b.sendConditionalPlanClear(ctx, eui, control, now)
	return len(ids), err
}

func planClearReadiness(revision jsvalue.Value, state, reason string) jsvalue.Value {
	p := jsvalue.Property
	return jsvalue.Obj(p("state", jsvalue.Str(state)), p("revision", revision), p("reason", jsvalue.Str(reason)))
}

func requiredPlanRows(ctx context.Context, db scheduleQueryer, eui string, ids jsvalue.Value) ([]jsvalue.Value, error) {
	return queryZones(ctx, db, `SELECT push_id,fport,payload_hex,state,error,transport_json FROM valve_schedule_pushes
		WHERE UPPER(device_eui)=? AND push_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`, eui, valveJSON(ids))
}

func orderRequiredPlanRows(rows, ids []jsvalue.Value) {
	order := make(map[string]int, len(ids))
	for i, id := range ids {
		order[id.MustString()] = i
	}
	slices.SortStableFunc(rows, func(a, b jsvalue.Value) int {
		return order[a.Get("push_id").MustString()] - order[b.Get("push_id").MustString()]
	})
}

func planClearEvidence(row jsvalue.Value) (phase string, uncertain bool) {
	raw := row.Get("transport_json").OrEmpty().MustString()
	if raw == "" {
		return "", row.Get("state").MustString() != "QUEUED"
	}
	state, err := valveStoredJSON(raw)
	if err != nil {
		return "", true
	}
	if state.Get("lifecycle_clear_revision").Kind == jsvalue.String && !state.Get("phase").Truthy() {
		return "", row.Get("state").MustString() != "QUEUED"
	}
	phase = state.Get("phase").MustString()
	return phase, phase != "enqueue_failed_before_acceptance" && phase != "enqueue_rejected"
}

func clearPlanPushClaimable(row jsvalue.Value) bool {
	phase, uncertain := planClearEvidence(row)
	return phase == "" && !uncertain && !terminalPlanACK(row)
}

func terminalPlanACK(row jsvalue.Value) bool {
	return row.Get("state").MustString() == "ACKED" || badPlanACK(row)
}

func badPlanACK(row jsvalue.Value) bool {
	return slices.Contains([]string{"negative_ack", "malformed_ack", "ack_protocol_unverified"}, row.Get("error").MustString())
}

func preacceptancePlanFailure(row jsvalue.Value) bool {
	phase, _ := planClearEvidence(row)
	return phase == "enqueue_failed_before_acceptance" || phase == "enqueue_rejected"
}

func (b *backend) sendConditionalPlanClear(ctx context.Context, eui string, control jsvalue.Value, now time.Time) error {
	schedules, err := queryZones(ctx, b.db, planRowsSQL, eui)
	if err != nil {
		return err
	}
	conditional, err := planScheduleMode(ctx, b.db, schedules)
	if err != nil || !conditional {
		return err
	}
	ids := control.Get("required_push_ids")
	rows, err := requiredPlanRows(ctx, b.db, eui, ids)
	if err != nil || len(rows) != len(ids.List) {
		return err
	}
	if !slices.ContainsFunc(rows, clearPlanPushClaimable) {
		return nil
	}
	p := jsvalue.Property
	revision := control.Get("desired_revision")
	conflict, err := b.planConversionConflict(ctx, eui, now)
	if err != nil {
		return err
	}
	if conflict.Truthy() {
		blocked := planClearReadiness(revision, "BLOCKED", "active_conflict")
		blocked.Set(p("command_id", conflict))
		control.Set(p("readiness", blocked))
		return b.savePlanControl(ctx, eui, control)
	}
	blocked, err := planBlockingObservation(ctx, b.db, eui)
	if err != nil {
		return err
	}
	uncertain := slices.ContainsFunc(rows, func(row jsvalue.Value) bool {
		_, unsure := planClearEvidence(row)
		return unsure
	})
	if !blocked && !uncertain {
		flush, err := b.flushPlanQueue(ctx, eui, "conditional_clear", now)
		if err != nil {
			return err
		}
		control, err = loadValveControl(ctx, b.db, eui)
		if err != nil {
			return err
		}
		reconcile, err := b.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer reconcile.Rollback()
		// Only clocks captured by this clear are superseded here.
		if err := supersedePlanClock(ctx, reconcile, eui, planFlushResult{id: flush.id}); err != nil {
			return err
		}
		if err := reconcile.Commit(); err != nil {
			return err
		}
		if problem := flush.failure(); problem != nil {
			control.Set(p("readiness", planClearReadiness(revision, "FAILED", "flush_failed")))
			control.Set(p("flush_failure", jsvalue.Obj(p("phase", jsvalue.Str("UNKNOWN")), p("error", jsvalue.Str(flush.problem.Error())))))
			return errors.Join(problem, b.savePlanControl(ctx, eui, control))
		}
	}
	return b.sendPlanClearRows(ctx, eui, control, rows)
}

func (b *backend) sendPlanClearRows(ctx context.Context, eui string, control jsvalue.Value, rows []jsvalue.Value) error {
	p := jsvalue.Property
	revision := control.Get("desired_revision")
	radio, err := openValveRadio()
	if err != nil {
		return scheduleRefusal(503, "transport_uncertain", "Valve transport did not confirm the write")
	}
	defer radio.conn.Close()
	var failure *scheduleError
	rejected := control.Get("mode").MustString() == "LIFECYCLE_CLEAR" && slices.ContainsFunc(rows, preacceptancePlanFailure)
	for _, row := range rows {
		if !clearPlanPushClaimable(row) {
			continue
		}
		phase, problem := enqueuePlanPush(ctx, b.db, radio, eui, row)
		if phase == "ACCEPTED" {
			continue
		}
		code := phase
		if phase == "UNKNOWN" {
			code = "transport_uncertain"
		} else {
			rejected = true
		}
		if failure == nil {
			details := jsvalue.Obj(p("push_id", row.Get("push_id")), p("accepted", jsvalue.Bool(false)),
				p("phase", jsvalue.Str(phase)), p("queue_id", jsvalue.Nil()), p("error", planEnqueueError(phase, problem)))
			failure = &scheduleError{status: 503, code: code, message: "Valve transport did not confirm the write", details: details}
		}
	}
	readiness := planClearReadiness(revision, "PENDING", "awaiting_clear_ack")
	if rejected {
		readiness = planClearReadiness(revision, "FAILED", "enqueue_failed")
	}
	control.Set(p("readiness", readiness))
	if err := b.savePlanControl(ctx, eui, control); err != nil {
		return err
	}
	if failure != nil {
		return failure
	}
	return nil
}

func planEnqueueError(phase string, err error) jsvalue.Value {
	p := jsvalue.Property
	code, provenance := phase, "local_preflight"
	switch phase {
	case "UNKNOWN":
		code, provenance = "enqueue_unknown", "post_start_unknown"
	case "enqueue_rejected":
		provenance = "chirpstack_enqueue_preacceptance"
	case "enqueue_failed_before_acceptance":
	default:
		return jsvalue.Obj()
	}
	detail := jsvalue.Obj(p("step", jsvalue.Str("enqueueDownlink")), p("code", jsvalue.Str(code)),
		p("classification", jsvalue.Str(phase)), p("accepted", jsvalue.Bool(false)), p("queue_id", jsvalue.Nil()),
		p("provenance", jsvalue.Str(provenance)))
	if st, ok := status.FromError(err); err != nil && ok {
		detail.Set(p("grpcCode", jsvalue.Num(float64(st.Code()))))
	}
	return detail
}

// emitPendingConditionalPlans is push.js emitPendingClears. The first pass
// reads and validates every stored control and fails the whole valve tick on
// a malformed one, as parseControl's throw does, before anything is sent. The
// second pass sends each candidate; a candidate's failure, including the
// withValveWriter EUI refusal, is logged and the next candidate still runs.
func (b *backend) emitPendingConditionalPlans(ctx context.Context, now time.Time) error {
	rows, err := queryZones(ctx, b.db, `SELECT device_eui,conditional_control_json FROM valve_settings
		WHERE conditional_control_json IS NOT NULL AND conditional_control_json<>''`)
	if err != nil {
		log.Printf("valve pending clears unreadable: %v", err)
		return nil
	}
	type candidate struct {
		eui, mode string
		control   jsvalue.Value
		required  []jsvalue.Value
		retry     bool
	}
	var candidates []candidate
	for _, row := range rows {
		control, err := valveStoredJSON(row.Get("conditional_control_json").MustString())
		if err != nil {
			return errPlanControlMalformed
		}
		if err := validatePlanControl(control); err != nil {
			return err
		}
		mode := control.Get("mode").MustString()
		if (mode != "CONDITIONAL" && mode != "LIFECYCLE_CLEAR") || !control.Get("desired_revision").Truthy() {
			continue
		}
		if mode == "LIFECYCLE_CLEAR" && control.Get("lifecycle_clear").Get("state").MustString() == "SUPERSEDED" {
			continue
		}
		stage := control.Get("readiness").Get("state").MustString()
		ids := control.Get("required_push_ids")
		if stage == "READY" || stage == "INVALID" || len(ids.List) == 0 {
			continue
		}
		eui := row.Get("device_eui").MustString()
		required, err := requiredPlanRows(ctx, b.db, eui, ids)
		if err != nil {
			return err
		}
		if slices.ContainsFunc(required, func(row jsvalue.Value) bool {
			phase, uncertain := planClearEvidence(row)
			return phase == "" && !uncertain
		}) {
			candidates = append(candidates, candidate{eui: eui, mode: mode, control: control, required: required})
			continue
		}
		prepared, valid := jsdate.Parse(control.Get("prepared_at").OrEmpty().MustString(), dailyScheduleLocation())
		if slices.ContainsFunc(required, preacceptancePlanFailure) && (!valid || now.Sub(prepared) >= 30*time.Minute) {
			candidates = append(candidates, candidate{eui: eui, mode: mode, control: control, required: required, retry: true})
		}
	}
	// push.js emitPendingClears: with candidates, a transport that cannot be
	// built sends nothing and writes nothing (ensure() before the loop).
	if configErr := chirpstackClientConfigError(); len(candidates) > 0 && configErr != nil {
		log.Printf("valve pending clears not sent: %v", configErr)
		return nil
	}
	for _, c := range candidates {
		eui := c.eui
		if _, valid := normalizeValveDispatchEUI(jsvalue.Upper(eui)); !valid {
			log.Printf("valve %s pending clear: %v", eui, errInvalidValveEUI)
			continue
		}
		if !c.retry {
			var err error
			if c.mode == "LIFECYCLE_CLEAR" {
				err = b.sendPendingLifecycleClear(ctx, eui, c.control, c.required, now)
			} else {
				err = b.sendConditionalPlanClear(ctx, eui, c.control, now)
			}
			if err != nil {
				log.Printf("valve %s pending clear: %v", eui, err)
			}
			continue
		}
		if c.mode == "LIFECYCLE_CLEAR" {
			if _, err := b.resendLifecycleClear(ctx, eui, c.control, now); err != nil {
				log.Printf("valve %s lifecycle clear retry: %v", eui, err)
			}
			continue
		}
		modeRows, err := queryZones(ctx, b.db, planRowsSQL, eui)
		if err == nil {
			var conditional bool
			conditional, err = planScheduleMode(ctx, b.db, modeRows)
			if err == nil && conditional {
				_, err = b.compileConditionalClear(ctx, eui, "retry", now)
			}
		}
		if err != nil {
			log.Printf("valve %s clear retry: %v", eui, err)
		}
	}
	return nil
}
