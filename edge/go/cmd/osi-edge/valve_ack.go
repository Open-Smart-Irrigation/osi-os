package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/ingest"
	"osi-edge/internal/jsvalue"
)

type valveACK struct {
	purpose string
	port    int
	weekday any
	status  sql.NullInt64
}

func valveHexACK(v jsvalue.Value) sql.NullInt64 {
	s := v.MustString()
	if v.Kind != jsvalue.String || len(s) != 2 || strings.IndexFunc(s, func(r rune) bool {
		return !strings.ContainsRune("0123456789abcdefABCDEF", r)
	}) >= 0 {
		return sql.NullInt64{}
	}
	n, err := strconv.ParseInt(s, 16, 64)
	return sql.NullInt64{Int64: n, Valid: err == nil}
}

func interpretValveACK(raw []byte, decoded jsvalue.Value) (acks []valveACK, promote, receipt bool) {
	for _, key := range []string{"Schl_Port", "Schl_status_Port", "RTC_Port", "Ack_Port"} {
		if decoded.Get(key).Kind != jsvalue.Undefined {
			receipt = true
		}
	}
	if port := decoded.Get("Schl_Port").MustNumber(); port >= 14 && port <= 20 && port == float64(int(port)) {
		acks = append(acks, valveACK{"WEEKDAY_PLAN", int(port), int(port) - 14, valveHexACK(decoded.Get("Schl_status"))})
	}
	if decoded.Get("Schl_status_Port").MustNumber() == 21 {
		acks = append(acks, valveACK{"SCHEDULER_STATUS", 21, nil, valveHexACK(decoded.Get("Schl_status_ack"))})
	}
	if port := decoded.Get("RTC_Port").MustNumber(); port == 12 || port == 13 {
		acks = append(acks, valveACK{"CLOCK_SYNC", int(port), nil, valveHexACK(decoded.Get("RTC_status"))})
	}
	if port := decoded.Get("Ack_Port"); valveWhole(port, 1, 1<<32) {
		status := decoded.Get("Ack_Value")
		return appendValveGen2ACK(acks, int(port.Num), sql.NullInt64{Int64: int64(status.Num), Valid: valveWhole(status, 0, 255)}), true, receipt
	}
	if len(raw) < 8 || raw[5] != 6 {
		return acks, false, receipt
	}
	if len(acks) > 0 {
		return acks, false, true
	}
	for _, digit := range raw[:3] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", rune(digit)) {
			return acks, false, true
		}
	}
	port := valveHexACK(jsvalue.Str(string(raw[6:8])))
	if port.Valid && port.Int64 > 0 {
		var status sql.NullInt64
		if len(raw) >= 10 {
			status = valveHexACK(jsvalue.Str(string(raw[8:10])))
		}
		acks = appendValveGen2ACK(acks, int(port.Int64), status)
	}
	return acks, true, true
}

func appendValveGen2ACK(acks []valveACK, port int, status sql.NullInt64) []valveACK {
	switch port {
	case 25:
		return append(acks, valveACK{"DAYMASK_PLAN", port, nil, status})
	case 21:
		return append(acks, valveACK{"SCHEDULER_STATUS", port, nil, status})
	case 12, 13:
		return append(acks, valveACK{"CLOCK_SYNC", port, nil, status})
	}
	return acks
}

func (b *backend) recordValveACK(ctx context.Context, event jsvalue.Value, received time.Time) (err error) {
	defer jsvalue.CatchConversion(&err)
	eui := jsvalue.Upper(zoneFallback(event.Get("deviceInfo").Get("devEui"), event.Get("devEui")).OrEmpty().MustString())
	raw, _ := base64.StdEncoding.DecodeString(event.Get("data").OrEmpty().MustString())
	decoded := event.Get("object")
	port := event.Get("fPort")
	if len(decoded.Fields) == 0 && len(decoded.List) == 0 {
		decoded = decodeValveGen1(event.Get("data"), jsvalue.Num(port.MustNumber()))
	}
	if eui == "" {
		return nil
	}
	acks, promote, receipt := interpretValveACK(raw, decoded)
	if !receipt {
		return nil
	}
	// The function node constructs the handleUplink arguments before the
	// worker accepts an ACK. The worker itself does not use the fPort.
	port.MustNumber()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if key := ingest.EventKey("strega-ack", event); key != "" {
		result, err := tx.ExecContext(ctx, `INSERT INTO uplink_effect_receipts(deveui,uplink_key,effect)
			VALUES (?,?,'strega-ack') ON CONFLICT DO NOTHING`, eui, key)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			if err := tx.Commit(); err != nil {
				return err
			}
			b.reconcileValveACKProfile(ctx, eui, event)
			return nil
		}
	}
	at := valveISO(received)
	if v := event.Get("time"); v.Truthy() {
		at = v.MustString()
	}
	control, err := loadValveControl(ctx, tx, eui)
	if err != nil {
		return err
	}
	generation := "GEN1"
	err = tx.QueryRowContext(ctx, "SELECT strega_generation FROM valve_settings WHERE device_eui=?", eui).Scan(&generation)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if promote && generation != "GEN2" {
		control.Set(jsvalue.Property("fixed_generation_transition", jsvalue.Obj(
			jsvalue.Property("transition_id", jsvalue.Str(uuid.NewString())),
			jsvalue.Property("from", jsvalue.Str(generation)),
			jsvalue.Property("to", jsvalue.Str("GEN2")),
			jsvalue.Property("state", jsvalue.Str("PENDING")),
			jsvalue.Property("promoted_at", jsvalue.Str(at)),
		)))
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO valve_settings(device_eui) VALUES (?)", eui); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE valve_settings SET strega_generation='GEN2',
			sync_version=COALESCE(sync_version,0)+1,updated_at=datetime('now') WHERE device_eui=?`, eui); err != nil {
			return err
		}
		if err := writePlanControl(ctx, tx, eui, control); err != nil {
			return err
		}
		generation = "GEN2"
	}
	planACK, planMatched := false, false
	for _, ack := range acks {
		isPlan := ack.purpose == "WEEKDAY_PLAN" || ack.purpose == "DAYMASK_PLAN"
		ackGeneration := generation
		if v := control.Get("generation"); isPlan && v.Truthy() {
			ackGeneration = v.MustString()
		}
		matched, err := settleValvePushACK(ctx, tx, eui, jsvalue.Upper(ackGeneration), at, ack, control)
		planACK = planACK || isPlan
		planMatched = planMatched || (isPlan && matched)
		if err != nil {
			return err
		}
		if matched && ack.purpose == "CLOCK_SYNC" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO valve_settings(device_eui,last_clock_sync_acked_at) VALUES (?,?)
				ON CONFLICT(device_eui) DO UPDATE SET last_clock_sync_acked_at=excluded.last_clock_sync_acked_at, updated_at=datetime('now')`, eui, at); err != nil {
				return err
			}
		}
	}
	if planACK {
		if err := markValveClearReady(ctx, tx, eui, generation, control, at); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if planMatched {
		b.emitValveRuntime(ctx, eui)
	}
	if generation == "GEN2" {
		b.reconcileValveACKProfile(ctx, eui, event)
	}
	return nil
}

func settleValvePushACK(ctx context.Context, tx *farmTx, eui, generation, stamp string, ack valveACK, control jsvalue.Value) (bool, error) {
	at := valveInstant(stamp)
	if at.IsZero() {
		return false, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT push_id,state,error,payload_hex,transport_json FROM valve_schedule_pushes
		WHERE UPPER(device_eui)=? AND purpose=? AND fport=? AND (? IS NULL OR weekday=?)
		AND state IN ('QUEUED','SUPERSEDED','FAILED','LOST') AND acked_at IS NULL ORDER BY rowid`,
		eui, ack.purpose, ack.port, ack.weekday, ack.weekday)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	type candidate struct {
		id, payload string
		transport   jsvalue.Value
	}
	var matches []candidate
	for rows.Next() {
		var id, state, payload string
		var raw sql.NullString
		var problem storedValue
		if err := rows.Scan(&id, &state, &problem, &payload, &raw); err != nil {
			return false, err
		}
		if state == "FAILED" && !valvePushLostStored(state, problem) {
			continue
		}
		transport, err := valveStoredJSON(raw.String)
		if err != nil {
			continue
		}
		switch transport.Get("phase").MustString() {
		case "ATTEMPTED", "ACCEPTED", "UNKNOWN":
		default:
			continue
		}
		attempted := valveInstant(transport.Get("attempted_at").MustString())
		if attempted.IsZero() || at.Before(attempted) || at.Sub(attempted) > 24*time.Hour ||
			valveACKProvenUndelivered(transport, control) {
			continue
		}
		matches = append(matches, candidate{id, payload, transport})
	}
	if err := rows.Err(); err != nil || len(matches) == 0 {
		return false, err
	}
	first := matches[0]
	if len(matches) > 1 && !(first.transport.Get("phase").MustString() == "ACCEPTED" &&
		first.transport.Get("queue_id").Truthy() && !first.transport.Get("invalidated_by_flush").Truthy()) {
		_, err := tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET ack_status=?, acked_at=?, error='ack_ambiguous' WHERE push_id=?", ack.status, stamp, first.id)
		if err != nil {
			return false, err
		}
		_, err = tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET error='ack_ambiguous' WHERE push_id=?", matches[1].id)
		return false, err
	}
	var pendingJSON sql.NullString
	err = tx.QueryRowContext(ctx, "SELECT value FROM app_settings WHERE key=?", "valve_snapshot_pending:"+eui).Scan(&pendingJSON)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	pendingSnapshot, _ := valveStoredJSON(pendingJSON.String)
	for _, pending := range pendingSnapshot.Get("push_ids").List {
		if pending.MustString() == first.id {
			return false, nil
		}
	}
	isPlan := ack.purpose == "WEEKDAY_PLAN" || ack.purpose == "DAYMASK_PLAN"
	isConditional := false
	if isPlan {
		for _, required := range control.Get("required_push_ids").List {
			isConditional = isConditional || required.MustString() == first.id
		}
	}
	positive := ack.status.Valid && ack.status.Int64 == 0 && (ack.purpose == "WEEKDAY_PLAN" || ack.purpose == "CLOCK_SYNC")
	if isConditional {
		payload := strings.TrimPrefix(jsvalue.Upper(first.payload), "0X")
		if generation == "GEN2" {
			positive = ack.purpose == "DAYMASK_PLAN" && ack.status.Valid && ack.status.Int64 == 1 && payload == "80"
		} else {
			positive = ack.purpose == "WEEKDAY_PLAN" && ack.status.Valid && ack.status.Int64 == 0 && payload == strings.Repeat("FF", 24)
		}
	} else if generation == "GEN2" {
		expected := int64(1)
		if ack.purpose == "SCHEDULER_STATUS" {
			payload := strings.TrimPrefix(first.payload, "0x")
			switch payload {
			case "30":
				expected = 0
			case "31":
				expected = 1
			case "32":
				expected = 2
			default:
				expected = -1
			}
		}
		positive = ack.status.Valid && ack.status.Int64 == expected
	} else if ack.purpose == "SCHEDULER_STATUS" {
		_, err := tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET ack_status=?, error='ack_protocol_unverified' WHERE push_id=?", ack.status, first.id)
		return false, err
	}
	if !positive {
		_, err := tx.ExecContext(ctx, `UPDATE valve_schedule_pushes SET state=CASE WHEN state='SUPERSEDED' THEN state ELSE 'FAILED' END,
			ack_status=?, acked_at=?, error='negative_ack' WHERE push_id=?`, ack.status, stamp, first.id)
		return false, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE valve_schedule_pushes SET state='ACKED', ack_status=?, acked_at=?, error=NULL WHERE push_id=?", ack.status, stamp, first.id)
	return err == nil, err
}

func valveACKProvenUndelivered(transport, control jsvalue.Value) bool {
	id := transport.Get("queue_id")
	if !id.Truthy() {
		return false
	}
	unsent := transport.Get("unsent_in_snapshot")
	first := transport.Get("first_invalidated_by_flush")
	if first.Kind != jsvalue.Undefined && first.Kind != jsvalue.Null && unsent.Kind == jsvalue.Boolean {
		return unsent.Bool
	}
	if !transport.Get("invalidated_by_flush").Truthy() {
		return false
	}
	for _, flush := range control.Get("flushes").List {
		if flush.Get("status").MustString() != "COMPLETE" && flush.Get("result_status").MustString() != "COMPLETE" {
			continue
		}
		for _, item := range flush.Get("captured_snapshot").List {
			for _, key := range []string{"id", "queue_id", "queueId"} {
				if item.Get(key).MustString() == id.MustString() && !item.Get("isPending").Truthy() && !item.Get("is_pending").Truthy() {
					return true
				}
			}
		}
	}
	return false
}

func markValveClearReady(ctx context.Context, tx *farmTx, eui, generation string, control jsvalue.Value, at string) error {
	revision, ids := control.Get("desired_revision"), control.Get("required_push_ids")
	expectedGeneration := control.Get("generation")
	if !revision.Truthy() || len(ids.List) == 0 || (expectedGeneration.Truthy() && expectedGeneration.MustString() != generation) {
		return nil
	}
	rows, err := requiredPlanRows(ctx, tx, eui, ids)
	if err != nil || len(rows) != len(ids.List) {
		return err
	}
	for _, row := range rows {
		if row.Get("state").MustString() != "ACKED" {
			return nil
		}
	}
	p := jsvalue.Property
	control.Set(p("readiness", planClearReadiness(revision, "READY", "all_current_clear_acked")))
	if err := reconcileValveIncident(ctx, tx, eui, &control, at); err != nil {
		return err
	}
	return writePlanControl(ctx, tx, eui, control)
}

func (b *backend) reconcileValveACKProfile(ctx context.Context, eui string, event jsvalue.Value) {
	current := jsvalue.Trim(event.Get("deviceInfo").Get("deviceProfileId").OrEmpty().MustString())
	if err := b.reconcileValveGeneration(ctx, eui, current); err != nil {
		log.Printf("valve ACK profile %s: %v", eui, err)
	}
}
