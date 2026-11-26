package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"slices"
	"time"
	"unicode/utf16"

	"google.golang.org/grpc/status"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

const pendingValvePlan = "valve_snapshot_pending:"
const emittedValvePlan = "valve_snapshot_emitted:"

// pendingPlansSQL is store.js listSnapshotPending. The gateway's sqlite3
// matches a BLOB key with LIKE as text; modernc is built with
// SQLITE_LIKE_DOESNT_MATCH_BLOBS, so the key is cast first. ORDER BY key still
// sorts by storage class (TEXT keys before BLOB keys), as on the gateway.
const pendingPlansSQL = "SELECT key,value FROM app_settings WHERE CAST(key AS TEXT) LIKE 'valve_snapshot_pending:%' ORDER BY key"
const planPushPurposes = "('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS')"
const planRowsSQL = "SELECT * FROM valve_schedules WHERE UPPER(device_eui)=? AND deleted_at IS NULL ORDER BY kind,start_time,fire_at"

func (b *backend) createValveSchedule(ctx context.Context, eui string, fallback storedValue, session auth.Session, scoped bool, row jsvalue.Value, now time.Time) (jsvalue.Value, error) {
	p := jsvalue.Property
	kind := row.Get("kind").MustString()
	var state any
	if kind == "WEEKLY" {
		existing, err := queryZones(ctx, b.db, planRowsSQL, eui)
		if err != nil {
			return jsvalue.Value{}, err
		}
		if plan := compileValvePlan(append(existing, row)); len(plan.errors) > 0 {
			return jsvalue.Value{}, plan.conflict(false)
		}
	} else {
		state = "PENDING"
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return jsvalue.Value{}, err
	}
	defer tx.Rollback()
	tz, err := authorizeValveSchedule(ctx, tx, eui, session, scoped)
	if err != nil {
		return jsvalue.Value{}, err
	}
	// row.timezone = freshDevice.zone_timezone || tzFallback, bound as read.
	timezone := timezoneChain(tz, fallback)
	row.Set(p("timezone", timezone.json()))
	_, err = tx.ExecContext(ctx, `INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,
		start_time,fire_at,duration_minutes,timezone,enabled,once_state) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		row.Get("schedule_uuid").MustString(), eui, kind, scheduleSQLValue(row.Get("label")), scheduleSQLValue(row.Get("weekdays_mask")),
		scheduleSQLValue(row.Get("start_time")), scheduleSQLValue(row.Get("fire_at")), row.Get("duration_minutes").Num,
		timezone.bindJS(), row.Get("enabled").Num, state)
	if err != nil {
		return jsvalue.Value{}, err
	}
	schedules, err := queryZones(ctx, tx, planRowsSQL, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	conditional, err := planScheduleMode(ctx, tx, schedules)
	if err != nil {
		return jsvalue.Value{}, err
	}
	if err := invalidatePlanLifecycle(ctx, tx, eui, now); err != nil {
		return jsvalue.Value{}, err
	}
	if err := tx.Commit(); err != nil {
		return jsvalue.Value{}, err
	}
	var count int
	var waitsFor jsvalue.Value
	if kind == "WEEKLY" {
		if conditional {
			count, err = b.compileConditionalClear(ctx, eui, "conversion", now)
		} else {
			count, waitsFor, err = b.queueFixedPlan(ctx, eui, fallback.jsString(), now)
		}
		if err != nil {
			return jsvalue.Value{}, err
		}
	}
	return jsvalue.Obj(p("schedule", row), p("pushes_queued", jsvalue.Num(float64(count))),
		p("conversion_waits_for", waitsFor)), nil
}

func scheduleSQLValue(v jsvalue.Value) any {
	switch v.Kind {
	case jsvalue.String:
		return v.MustString()
	case jsvalue.Number:
		return v.Num
	default:
		return nil
	}
}

func (b *backend) queueValvePlanResend(ctx context.Context, eui, fallback string, now time.Time) (int, jsvalue.Value, error) {
	var waits jsvalue.Value
	control, err := loadValveControl(ctx, b.db, eui)
	if err != nil {
		return 0, waits, err
	}
	if err := validatePlanControl(control); err != nil {
		return 0, waits, err
	}
	if control.Get("mode").MustString() == "LIFECYCLE_CLEAR" {
		count, err := b.resendLifecycleClear(ctx, eui, control, now)
		return count, waits, err
	}
	schedules, err := queryZones(ctx, b.db, planRowsSQL, eui)
	if err != nil {
		return 0, waits, err
	}
	conditional, err := planScheduleMode(ctx, b.db, schedules)
	if err != nil {
		return 0, waits, err
	}
	if conditional {
		count, err := b.compileConditionalClear(ctx, eui, "resend", now)
		return count, waits, err
	}
	return b.queueFixedPlan(ctx, eui, fallback, now)
}

func fixedPlanFrames(ctx context.Context, db scheduleQueryer, eui string, leavingConditional bool) ([]planPush, error) {
	schedules, err := queryZones(ctx, db, planRowsSQL, eui)
	if err != nil {
		return nil, err
	}
	plan := compileValvePlan(schedules)
	if len(plan.errors) > 0 {
		return nil, plan.conflict(true)
	}
	settings, err := planSettings(ctx, db, eui)
	if err != nil {
		return nil, err
	}
	var status byte
	switch jsvalue.Upper(settings.Get("scheduler_status").MustString()) {
	case "ACTIVE":
		status = '0'
	case "SKIP_TODAY":
		status = '1'
	case "DEACTIVATED":
		status = '2'
	default:
		return nil, scheduleRefusal(422, "invalid_status", "invalid_status")
	}
	pushes := []planPush{{purpose: "SCHEDULER_STATUS", port: 21, data: []byte{status}}}
	if !leavingConditional {
		var hasPlan bool
		err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM valve_schedules WHERE UPPER(device_eui)=? AND kind='WEEKLY')
			OR EXISTS(SELECT 1 FROM valve_schedule_pushes WHERE UPPER(device_eui)=? AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN'))`,
			eui, eui).Scan(&hasPlan)
		if err != nil || !hasPlan {
			return pushes, err
		}
	}
	flag := jsvalue.Lower(jsvalue.Trim(scheduleGatewaySetting(ctx, db, "valve_gen2_snapshot_clear_prefix")))
	clearPrefix := slices.Contains([]string{"1", "true", "yes", "on"}, flag)
	return append(pushes, weekdayFrames(plan.days, settings.Get("strega_generation").MustString(), clearPrefix)...), nil
}

func (b *backend) queueFixedPlan(ctx context.Context, eui, fallback string, now time.Time) (int, jsvalue.Value, error) {
	var waits jsvalue.Value
	control, err := loadValveControl(ctx, b.db, eui)
	if err != nil {
		return 0, waits, err
	}
	leavingConditional := control.Get("mode").MustString() == "CONDITIONAL" || control.Get("desired_revision").Truthy()
	if err := b.invalidateFixedTransition(ctx, eui, fallback, &control, now); err != nil {
		return 0, waits, err
	}
	if leavingConditional {
		conflict, err := b.planConversionConflict(ctx, eui, now)
		if err != nil {
			return 0, waits, err
		}
		reason := "fixed_mode"
		if conflict.Truthy() {
			reason = "fixed_mode_pending_open"
			waits = conflict
		}
		setFixedPlanMode(&control, reason)
		if err := b.savePlanControl(ctx, eui, control); err != nil {
			return 0, waits, err
		}
	}
	if _, err := fixedPlanFrames(ctx, b.db, eui, leavingConditional); err != nil {
		return 0, waits, err
	}
	blocked, err := planBlockingObservation(ctx, b.db, eui)
	if err != nil {
		return 0, waits, err
	}
	var flushed planFlushResult
	if !blocked {
		flushed, err = b.flushPlanQueue(ctx, eui, "plan_push", now)
		if err != nil {
			return 0, waits, err
		}
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, waits, err
	}
	defer tx.Rollback()
	pushes, err := fixedPlanFrames(ctx, tx, eui, leavingConditional)
	if err != nil {
		return 0, waits, err
	}
	if err := supersedePlanPushes(ctx, tx, eui); err != nil {
		return 0, waits, err
	}
	if flushed.ok || flushed.id != "" {
		if err := supersedePlanClock(ctx, tx, eui, flushed); err != nil {
			return 0, waits, err
		}
	}
	ids, err := insertPlanPushes(ctx, tx, eui, pushes, jsvalue.Value{})
	if err != nil {
		return 0, waits, err
	}
	stamp := jsvalue.Str(valveISO(now))
	first := stamp
	var raw sql.NullString
	err = tx.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key=?", pendingValvePlan+eui).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, waits, err
	}
	if prior, err := valveStoredJSON(raw.String); err == nil {
		first = zoneFallback(prior.Get("first_edited_at"), zoneFallback(prior.Get("edited_at"), stamp))
	}
	p := jsvalue.Property
	pending := jsvalue.Obj(p("edited_at", stamp), p("first_edited_at", first), p("push_ids", jsvalue.Arr(ids...)))
	if err := setPlanMarker(ctx, tx, pendingValvePlan+eui, pending); err != nil {
		return 0, waits, err
	}
	if err := emitPlanRuntime(ctx, tx, eui, time.Now()); err != nil {
		log.Printf("valve snapshot runtime: %v", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, waits, err
	}
	return len(ids), waits, flushed.failure()
}

func setPlanMarker(ctx context.Context, tx *farmTx, key string, value jsvalue.Value) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO app_settings(key,value,updated_at)
		VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, valveJSON(value))
	return err
}

func supersedePlanPushes(ctx context.Context, tx planWriter, eui string) error {
	_, err := tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=? AND state='QUEUED' AND purpose IN "+planPushPurposes, eui)
	return err
}

func planBlockingObservation(ctx context.Context, db scheduleQueryer, eui string) (bool, error) {
	rows, err := queryZones(ctx, db, `SELECT reconciliation_state,transport_json FROM valve_actuation_expectations
		WHERE UPPER(device_eui)=? AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')`, eui)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		state, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		if err != nil || row.Get("reconciliation_state").MustString() == "PENDING_OBSERVATION" ||
			state.Get("physical_run").Kind != jsvalue.Undefined && state.Get("physical_run").Kind != jsvalue.Null {
			return true, nil
		}
	}
	return false, nil
}

func (b *backend) emitPendingValvePlans(ctx context.Context, now time.Time) error {
	pending, err := queryZones(ctx, b.db, pendingPlansSQL)
	if err != nil {
		return err
	}
	var radio *valveRadio
	defer func() {
		if radio != nil {
			radio.conn.Close()
		}
	}()
	for _, row := range pending {
		raw := row.Get("value").MustString()
		pendingPlan, _ := valveStoredJSON(raw)
		eui := pendingPlanDevice(row.Get("key"))
		edited := valveInstant(pendingPlan.Get("edited_at").MustString())
		first := valveInstant(zoneFallback(pendingPlan.Get("first_edited_at"), pendingPlan.Get("edited_at")).MustString())
		capReached := !first.IsZero() && now.Sub(first) >= 5*time.Minute
		if age := now.Sub(edited); !capReached && !edited.IsZero() && age < 30*time.Second && age >= -30*time.Second {
			continue
		}
		if !capReached {
			blocked, err := planBlockingObservation(ctx, b.db, eui)
			if err != nil {
				return err
			}
			if blocked {
				continue
			}
		}
		if radio == nil {
			// push.js: a transport that cannot be built leaves this and
			// every later snapshot pending (transportDown) and the tick
			// goes on.
			if configErr := chirpstackClientConfigError(); configErr != nil {
				log.Printf("valve snapshots stay pending: %v", configErr)
				return nil
			}
			radio, err = openValveRadio()
			if err != nil {
				return err
			}
		}
		// push.js emitPendingSnapshots: withValveWriter(eui) throws before the
		// pending marker is taken, and the tick sends no further snapshot.
		if _, valid := normalizeValveDispatchEUI(eui); !valid {
			return fmt.Errorf("valve snapshot %s: %w", eui, errInvalidValveEUI)
		}
		rows, err := takeValvePlan(ctx, b.db, eui, raw, pendingPlan.Get("push_ids").List)
		if err != nil {
			return err
		}
		for i, row := range rows {
			phase, sendErr := enqueuePlanPush(ctx, b.db, radio, eui, row)
			if phase != "ACCEPTED" {
				lostErr := b.markValvePlanLost(ctx, eui, rows[i:])
				return errors.Join(sendErr, lostErr, errors.New("valve snapshot enqueue ended in "+phase))
			}
		}
	}
	return nil
}

// pendingPlanDevice is parsePending's key.slice(SNAPSHOT_PENDING_PREFIX.length)
// followed by emitPendingSnapshots' String(p.device_eui).toUpperCase(). The
// slice cuts at the prefix length whatever the key's first characters are
// (LIKE is case-insensitive and its _ matches any character): a TEXT key in
// UTF-16 units, a BLOB key (a Buffer) in bytes, decoded as UTF-8 by String().
func pendingPlanDevice(key jsvalue.Value) string {
	n := len(pendingValvePlan)
	if data, ok := storedBufferBytes(key); ok {
		if len(data) <= n {
			return ""
		}
		return jsvalue.Upper(string(jsvalue.DecodeUTF8(data[n:])))
	}
	units := utf16.Encode([]rune(key.MustString()))
	if len(units) <= n {
		return ""
	}
	return jsvalue.Upper(string(utf16.Decode(units[n:])))
}

// storedBufferBytes reads back the bytes of a BLOB that queryZones turned into
// the Buffer object node-sqlite3 hands the flows.
func storedBufferBytes(v jsvalue.Value) ([]byte, bool) {
	if v.Kind != jsvalue.Object || v.Get("type").Kind != jsvalue.String || v.Get("type").MustString() != "Buffer" {
		return nil, false
	}
	list := v.Get("data").List
	data := make([]byte, len(list))
	for i, b := range list {
		data[i] = byte(b.Num)
	}
	return data, true
}

// takeValvePlan is emitPendingSnapshots' transaction: getSnapshotPending and
// clearSnapshotPending address the marker by SNAPSHOT_PENDING_PREFIX + eui,
// not by the listed key, so a listed key in another case or storage class
// (a BLOB) clears and sends nothing unless that TEXT marker holds the same
// value.
func takeValvePlan(ctx context.Context, db *farmDB, eui, raw string, pendingIDs []jsvalue.Value) ([]jsvalue.Value, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	deleted, err := tx.ExecContext(ctx, "DELETE FROM app_settings WHERE key=? AND value=?", pendingValvePlan+eui, raw)
	if err != nil {
		return nil, err
	}
	if n, err := deleted.RowsAffected(); n == 0 || err != nil {
		return nil, err
	}
	rows, err := queryZones(ctx, tx, `SELECT push_id,fport,payload_hex,transport_json FROM valve_schedule_pushes
		WHERE UPPER(device_eui)=? AND state='QUEUED' AND push_id IN (SELECT value FROM json_each(?))
		ORDER BY rowid`, eui, valveJSON(jsvalue.Arr(pendingIDs...)))
	if err != nil {
		return nil, err
	}
	rows = slices.DeleteFunc(rows, func(row jsvalue.Value) bool {
		state, _ := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		phase := state.Get("phase")
		return (phase.Kind == jsvalue.String && phase.Truthy()) ||
			state.Get("lifecycle_clear_revision").Kind == jsvalue.String
	})
	if len(rows) > 0 {
		ids := make([]jsvalue.Value, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.Get("push_id"))
		}
		p := jsvalue.Property
		emitted := jsvalue.Obj(p("emitted_at", jsvalue.Str(valveISO(time.Now()))), p("push_ids", jsvalue.Arr(ids...)))
		if err := setPlanMarker(ctx, tx, emittedValvePlan+eui, emitted); err != nil {
			return nil, err
		}
	}
	return rows, tx.Commit()
}

func enqueuePlanPush(ctx context.Context, db *farmDB, radio *valveRadio, eui string, row jsvalue.Value) (string, error) {
	device, valid := normalizeValveDispatchEUI(eui)
	if !valid {
		return "invalid_device_eui", errInvalidValveEUI
	}
	id, port := row.Get("push_id").MustString(), uint32(row.Get("fport").Num)
	frame, err := hex.DecodeString(row.Get("payload_hex").MustString())
	if err != nil {
		return "enqueue_failed_before_acceptance", err
	}
	raw := row.Get("transport_json").OrEmpty().MustString()
	state, err := valveStoredJSON(raw)
	if err != nil || state.Get("phase").Truthy() {
		return "write_failed", errors.Join(err, errors.New("plan push no longer claimable"))
	}
	valveAttemptAt(&state, time.Now(), false)
	result, err := db.ExecContext(ctx, `UPDATE valve_schedule_pushes SET transport_json=?
		WHERE push_id=? AND state='QUEUED' AND COALESCE(transport_json,'')=?`, valveJSON(state), id, raw)
	if err != nil {
		return "write_failed", err
	}
	if n, err := result.RowsAffected(); n != 1 || err != nil {
		return "write_failed", errors.Join(err, errors.New("plan push no longer claimable"))
	}
	phase, _, problem := radio.enqueueValveFrame(ctx, device, port, frame, &state)
	if st, ok := status.FromError(problem); problem != nil && ok && phase == "UNKNOWN" {
		state.Set(jsvalue.Property("error", jsvalue.Str(st.Message())))
	}
	_, err = db.ExecContext(ctx, "UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?", valveJSON(state), id)
	return phase, errors.Join(problem, err)
}

func (b *backend) markValvePlanLost(ctx context.Context, eui string, rows []jsvalue.Value) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, row := range rows {
		if _, err := tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET state='FAILED',error='not_resent_q02c' WHERE push_id=? AND state='QUEUED'",
			row.Get("push_id").MustString()); err != nil {
			return err
		}
	}
	if err := emitPlanRuntime(ctx, tx, eui, time.Now()); err != nil {
		log.Printf("valve snapshot loss runtime: %v", err)
	}
	return tx.Commit()
}
