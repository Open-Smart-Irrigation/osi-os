package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"time"

	"osi-edge/internal/jsvalue"
)

func (b *backend) correctLateValveOnce(ctx context.Context, now time.Time) error {
	recent := valveISO(now.Add(-24 * time.Hour))
	rows, err := b.db.QueryContext(ctx, `SELECT e.expectation_id,e.transport_json,e.commanded_duration_seconds,
		i.schedule_uuid,i.command_id,i.attempted_at,s.fire_at,s.duration_minutes,d.deveui,d.user_id,d.irrigation_zone_id
		FROM devices d CROSS JOIN valve_actuation_expectations e INDEXED BY idx_valve_act_exp_device_eui ON e.device_eui=d.deveui
		JOIN valve_once_dispatch_intents i ON i.command_id=e.command_id JOIN valve_schedules s ON s.schedule_uuid=i.schedule_uuid
		WHERE e.commanded_at>=? AND julianday(e.commanded_at)>=julianday(?) AND i.state='SKIPPED' AND s.kind='ONCE'
		AND s.once_state='SKIPPED' AND s.deleted_at IS NULL AND d.deleted_at IS NULL
		AND json_extract(CASE WHEN json_valid(e.transport_json) THEN e.transport_json ELSE '{}' END,'$.once_settlement')='uncertain'
		AND COALESCE(julianday(json_extract(CASE WHEN json_valid(e.transport_json) THEN e.transport_json ELSE '{}' END,'$.once_confirm_by')),
		julianday(COALESCE(i.attempted_at,json_extract(CASE WHEN json_valid(e.transport_json) THEN e.transport_json ELSE '{}' END,'$.attempted_at'),s.fire_at))+3.0/24.0)
		+ e.commanded_duration_seconds/86400.0>=julianday(?)`, recent[:10], recent, valveISO(now))
	if err != nil {
		return err
	}
	defer rows.Close()
	var candidates []valveOnceIntent
	for rows.Next() {
		var r valveOnceIntent
		if err := rows.Scan(&r.expectation, &r.transport, &r.seconds, &r.uuid, &r.command, &r.attempted,
			&r.fireAt, &r.duration, &r.valve.eui, &r.valve.user, &r.valve.zone); err != nil {
			return err
		}
		r.id = r.uuid.jsString()
		candidates = append(candidates, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range candidates {
		if err := b.correctLateValveOnceIntent(ctx, r, now, recent); err != nil {
			log.Printf("late one-time correction %s: %v", r.expectation.String, err)
		}
	}
	return nil
}

func (b *backend) correctLateValveOnceIntent(ctx context.Context, row valveOnceIntent, now time.Time, recent string) error {
	transport, err := valveStoredJSON(row.transport.String)
	if err != nil {
		return err
	}
	if valveInstant(transport.Get("once_confirm_by").MustString()).IsZero() {
		var raw sql.NullString
		err := b.db.QueryRowContext(ctx, `SELECT payload_json FROM irrigation_events INDEXED BY idx_irrig_events_created_at
			WHERE created_at>=? AND created_at<? AND julianday(created_at) BETWEEN julianday(?) AND julianday(?)
			AND action='SKIP' AND reason='one_time_uncertain' AND valve_deveui=?
			AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.schedule_uuid')=?
			AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.fire_at')=?
			ORDER BY created_at DESC LIMIT 1`, recent[:10], valveISO(now.Add(24 * time.Hour))[:10], recent,
			valveISO(now), row.valve.eui, row.uuidArg(), row.fireAt).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if audit, err := valveStoredJSON(raw.String); err == nil && !valveInstant(audit.Get("confirm_by").MustString()).IsZero() {
			transport.Set(jsvalue.Property("once_confirm_by", audit.Get("confirm_by")))
			transport.Set(jsvalue.Property("once_interval_minutes", audit.Get("interval")))
		}
	}
	deadline, err := b.valveOnceConfirmation(ctx, row, &transport, now)
	if err != nil {
		return err
	}
	// workers.js correctLateOnceOpens: the attempted frame's duration when
	// there is one, else Number(stored duration_minutes), so a REAL corrects
	// with its fraction and only this candidate is affected. A value that is
	// not a finite number ends this candidate (end is NaN).
	minutes := storedValue{row.duration}.number()
	row.logged = row.duration
	if _, _, frameMinutes, ok := valveOnceFrame(row, transport); ok {
		row.minutes, minutes, row.logged = frameMinutes, float64(frameMinutes), nil
	}
	endMS := float64(deadline.at.UnixMilli()) + minutes*60000
	if math.IsNaN(endMS) || math.IsInf(endMS, 0) || float64(now.UnixMilli()) > endMS {
		return nil
	}
	end := deadline.at.Add(time.Duration(minutes * float64(time.Minute)))
	attempted, _ := valveAckInstant(deadline.attempted)
	observed, err := b.valveOnceObservation(ctx, row, attempted, end)
	if err != nil || observed.id == "" {
		return err
	}
	return b.finalizeLateValveOnce(ctx, row, transport, deadline, observed, now)
}

func (b *backend) finalizeLateValveOnce(ctx context.Context, row valveOnceIntent, transport jsvalue.Value, deadline valveOnceDeadline, observed valveOnceObserved, now time.Time) error {
	// The JS correction finalises through store.js updateSchedule, which
	// refuses a key that is not 16 hex digits before its transaction commits,
	// and binds the trimmed, upper-cased key: a stored key with padding
	// matches no schedule row, while the proof, event and log writes go on.
	scope, valid := normalizeValveDispatchEUI(row.valve.eui)
	if !valid {
		return errInvalidValveEUI
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// workers.js re-reads the candidate under the writer: the schedule and
	// its intent must still be SKIPPED.
	var still int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM valve_schedules WHERE schedule_uuid=? AND once_state='SKIPPED'
		AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM valve_once_dispatch_intents WHERE schedule_uuid=? AND state='SKIPPED')`,
		row.uuidArg(), row.uuidArg()).Scan(&still)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE valve_schedules SET once_state='FIRED',once_fired_at=?,
		sync_version=COALESCE(sync_version,0)+1,updated_at=datetime('now') WHERE schedule_uuid=? AND UPPER(device_eui)=?
		AND once_state='SKIPPED' AND deleted_at IS NULL`, row.fireAt, row.uuidArg(), scope); err != nil {
		return err
	}
	transport.Set(jsvalue.Property("proof", jsvalue.Str("observed_open")))
	if _, err := tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
		valveJSON(transport), row.expectation.String); err != nil {
		return err
	}
	if row.valve.user.Valid && row.valve.zone.Valid {
		payload := jsvalue.Obj(
			jsvalue.Property("schedule_uuid", row.uuidJSON()),
			jsvalue.Property("fire_at", jsvalue.Str(row.fireAt)),
			jsvalue.Property("expectation_id", jsvalue.Str(observed.id)),
			jsvalue.Property("proof", jsvalue.Str("observed_open")),
			jsvalue.Property("message", jsvalue.Str("Valve reported open")),
			jsvalue.Property("observed_open_at", jsvalue.Str(valveISO(observed.at))),
			jsvalue.Property("attempted_at", jsvalue.Str(deadline.attempted)),
		)
		if err := recordValveOnceEvent(ctx, tx, row, "one_time_open_reported_late", payload, observed.id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO actuator_log(deveui,irrigation_zone_id,action,duration_minutes,reason,created_at)
		SELECT ?,?,'OPEN_FOR_DURATION',?,?,? WHERE NOT EXISTS(SELECT 1 FROM actuator_log WHERE reason=?)`, row.valve.eui,
		zoneDouble(row.valve.zone), row.writtenMinutes(), row.marker(), valveISO(now), row.marker()); err != nil {
		return err
	}
	return tx.Commit()
}

func recordValveOnceEvent(ctx context.Context, tx *farmTx, row valveOnceIntent, reason string, payload jsvalue.Value, observedID string) error {
	if observedID != "" {
		var id int64
		var raw sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT id,payload_json FROM irrigation_events
			WHERE action='IRRIGATE' AND valve_deveui=? AND json_extract(CASE WHEN json_valid(payload_json)
			THEN payload_json ELSE '{}' END,'$.expectation_id')=? LIMIT 1`, row.valve.eui, observedID).Scan(&id, &raw)
		if err == nil {
			merged, err := valveStoredJSON(raw.String)
			if err != nil {
				return err
			}
			for _, field := range payload.Fields {
				merged.Set(field)
			}
			_, err = tx.ExecContext(ctx, "UPDATE irrigation_events SET reason=?,duration_minutes=?,payload_json=? WHERE id=?",
				reason, row.writtenMinutes(), valveJSON(merged), id)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO irrigation_events(user_id,irrigation_zone_id,action,reason,duration_minutes,valve_deveui,payload_json)
		SELECT ?,?,'IRRIGATE',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM irrigation_events WHERE action='IRRIGATE'
		AND reason=? AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.schedule_uuid')=?)`,
		row.valve.user, zoneDouble(row.valve.zone), reason, row.writtenMinutes(), row.valve.eui, valveJSON(payload), reason, row.id)
	return err
}
