package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/chirpstack/chirpstack/api/go/v4/api"
	"github.com/google/uuid"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

const valveOnceEligible = `s.kind='ONCE' AND s.once_state='PENDING' AND s.enabled=1
	AND s.deleted_at IS NULL AND d.deleted_at IS NULL`

type valveOnceIntent struct {
	// id is String(schedule_uuid); uuid is the stored value, which the
	// one-time path binds back as node-sqlite3 does (a BLOB stays a BLOB, so
	// a BLOB schedule_uuid still joins its intent) and JSON payloads write
	// as JSON.stringify does.
	uuid                              storedValue
	id, command, state, fireAt        string
	minutes, seconds                  int
	attempted, expectation, transport sql.NullString
	valve                             valveDevice
	// duration is the stored valve_schedules.duration_minutes as scanned;
	// minutes stays 0 when it is not an integer from 1 to 255.
	duration any
	// logged, when set, is the stored duration the late correction writes
	// as it is (row.duration_minutes in workers.js), REAL fraction included.
	logged any
}

// writtenMinutes is the duration_minutes a one-time event or log row gets.
func (r valveOnceIntent) writtenMinutes() any {
	if r.logged != nil {
		return r.logged
	}
	return r.minutes
}

// storedMinutes is the duration the SKIP event logs: JS writes the stored
// value as it is, so a refused REAL keeps its fraction.
func (r valveOnceIntent) storedMinutes() any {
	if r.minutes != 0 || r.duration == nil {
		return r.minutes
	}
	return r.duration
}

func (r valveOnceIntent) marker() string { return "one_time_open:" + r.id + ":" + r.fireAt }

// uuidArg binds the schedule's stored uuid; a row built without one binds id.
func (r valveOnceIntent) uuidArg() any {
	if r.uuid.raw != nil {
		return r.uuid.arg()
	}
	return r.id
}

// uuidJSON is the schedule_uuid a one-time event payload writes.
func (r valveOnceIntent) uuidJSON() jsvalue.Value {
	if r.uuid.raw != nil {
		return r.uuid.json()
	}
	return jsvalue.Str(r.id)
}

func (b *backend) valveOnceTick(ctx context.Context) error {
	valveWriter.Lock()
	defer valveWriter.Unlock()
	now := time.Now()
	if err := b.correctLateValveOnce(ctx, now); err != nil {
		log.Printf("late one-time correction: %v", err)
	}
	_, err := b.db.ExecContext(ctx, `UPDATE valve_once_dispatch_intents SET state='UNKNOWN', updated_at=datetime('now')
		WHERE state='ATTEMPTED' AND attempted_at IS NOT NULL AND julianday(attempted_at)<julianday('now','-1 second')`)
	if err != nil {
		return err
	}
	rows, err := b.db.QueryContext(ctx, `SELECT s.schedule_uuid, s.device_eui FROM valve_schedules s
		JOIN devices d ON d.deveui=s.device_eui WHERE `+valveOnceEligible+` AND s.fire_at<=?
		AND NOT EXISTS (SELECT 1 FROM valve_once_dispatch_intents i WHERE i.schedule_uuid=s.schedule_uuid)
		ORDER BY s.fire_at`, valveISO(now))
	if err != nil {
		return err
	}
	defer rows.Close()
	type due struct {
		id  storedValue
		eui string
	}
	var schedules []due
	for rows.Next() {
		var r due
		if err := rows.Scan(&r.id, &r.eui); err != nil {
			return err
		}
		schedules = append(schedules, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range schedules {
		_, err := b.db.ExecContext(ctx, `INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state)
			VALUES (?,?,?,'PENDING') ON CONFLICT(schedule_uuid) DO NOTHING`, r.id.arg(), r.eui, uuid.NewString())
		if err != nil {
			return err
		}
	}
	intents, err := b.valveOnceIntents(ctx, now)
	if err != nil {
		return err
	}
	queues := make(map[string]valveOnceQueue)
	for _, intent := range intents {
		if err := b.processValveOnce(ctx, intent, now, queues); err != nil {
			log.Printf("one-time dispatch %s: %v", intent.id, err)
		}
	}
	return nil
}

func (b *backend) valveOnceIntents(ctx context.Context, now time.Time) ([]valveOnceIntent, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT i.schedule_uuid,i.command_id,i.state,i.attempted_at,s.fire_at,
		s.duration_minutes,d.deveui,d.user_id,d.irrigation_zone_id,d.current_state,d.updated_at,
		e.expectation_id,e.transport_json,COALESCE(e.commanded_duration_seconds,0)
		FROM valve_once_dispatch_intents i JOIN valve_schedules s ON s.schedule_uuid=i.schedule_uuid
		JOIN devices d ON d.deveui=s.device_eui LEFT JOIN valve_actuation_expectations e ON e.command_id=i.command_id
		WHERE `+valveOnceEligible+` AND s.fire_at<=? AND i.state IN ('PENDING','ATTEMPTED','UNKNOWN','SENT')
		ORDER BY i.created_at,i.schedule_uuid`, valveISO(now))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var intents []valveOnceIntent
	for rows.Next() {
		var row valveOnceIntent
		if err := rows.Scan(&row.uuid, &row.command, &row.state, &row.attempted, &row.fireAt, &row.duration,
			&row.valve.eui, &row.valve.user, &row.valve.zone, &row.valve.state, &row.valve.updated,
			&row.expectation, &row.transport, &row.seconds); err != nil {
			return nil, err
		}
		row.id = row.uuid.jsString()
		// dispatch.js durationMinutes refuses one schedule, not the tick:
		// Number(value) must be an integer from 1 to 255. INTEGER affinity
		// stores an integral REAL as an integer, so only int64 can pass.
		if minutes, ok := row.duration.(int64); ok && minutes >= 1 && minutes <= 255 {
			row.minutes = int(minutes)
		}
		intents = append(intents, row)
	}
	return intents, rows.Err()
}

func (b *backend) processValveOnce(ctx context.Context, row valveOnceIntent, now time.Time, queues map[string]valveOnceQueue) error {
	var loggedAt string
	err := b.db.QueryRowContext(ctx, `SELECT created_at FROM actuator_log WHERE action='OPEN_FOR_DURATION'
		AND reason=? ORDER BY id LIMIT 1`, row.marker()).Scan(&loggedAt)
	if err == nil {
		tx, err := b.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, "DELETE FROM valve_once_dispatch_intents WHERE schedule_uuid=? AND state='PENDING'", row.uuidArg()); err != nil {
			return err
		}
		if err := setValveOnceSchedule(ctx, tx, row, "FIRED", loggedAt); err != nil {
			return err
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	state, err := valveStoredJSON(row.transport.String)
	if err != nil {
		return err
	}
	phase := state.Get("phase").MustString()
	if phase == "ACCEPTED" && state.Get("queue_id").Truthy() {
		// workers.js sends an accepted replay through executeValveAttempt,
		// whose normalizeDevice refuses a malformed key: the intent goes UNKNOWN.
		_, validEUI := normalizeValveDispatchEUI(row.valve.eui)
		if !validEUI || !valveOnceSnapshotMatches(state, row.valve.eui, row.minutes) {
			_, err := b.db.ExecContext(ctx, "UPDATE valve_once_dispatch_intents SET state='UNKNOWN',updated_at=datetime('now') WHERE schedule_uuid=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN')", row.uuidArg())
			return errors.Join(err, errors.New("accepted one-time reservation has no matching effect snapshot"))
		}
		return b.finalizeValveOnce(ctx, row, now, "receipt", "", "")
	}
	if phase == "ATTEMPTED" || phase == "UNKNOWN" || state.Get("attempted_at").Truthy() || state.Get("attempt_receipt").Truthy() {
		return b.settleUncertainValveOnce(ctx, row, state, now, queues)
	}
	// workers.js: Date.parse(fire_at) is NaN for an unreadable stamp, which is
	// neither past the grace window nor late, so the claim goes on to dispatch.
	fire, fireParsed := jsdate.Parse(row.fireAt, dailyScheduleLocation())
	cutoff := valveInstant(state.Get("effect_snapshot").Get("queue_expires_at").MustString())
	if fireParsed && now.Sub(fire) > 10*time.Minute || !cutoff.IsZero() && !now.Before(cutoff) {
		return b.skipValveOnce(ctx, row, state, now, "missed", nil)
	}
	// executeValveAttempt reserves with commanded_at = fire_at || now. A
	// non-empty stamp its reservation cannot read (parseInstant: ISO, or the
	// SQLite form with seconds) throws before any write; like an invalid
	// stored duration or an EUI the dispatcher rejects, the intent goes
	// UNKNOWN and the next tick retries it.
	anchor, anchorText := now, valveISO(now)
	if row.fireAt != "" {
		anchor, anchorText = valveEffectInstant(jsvalue.Str(row.fireAt)), row.fireAt
	}
	phase = "invalid_duration"
	var dispatchErr error
	switch {
	case anchor.IsZero():
		phase = "invalid_timestamp"
	case row.minutes != 0:
		phase, _, dispatchErr = b.dispatchValve(ctx, row.valve, row.command, valveOpen, row.minutes,
			valveDispatchOptions{scheduleID: row.id, scheduleArg: row.uuidArg(), fireAt: anchor, fireAtText: anchorText, existingID: row.expectation.String})
	}
	if phase == "ACCEPTED" {
		if dispatchErr != nil {
			log.Printf("one-time receipt %s: %v", row.id, dispatchErr)
		}
		return b.finalizeValveOnce(ctx, row, now, "receipt", "", "")
	}
	_, err = b.db.ExecContext(ctx, `UPDATE valve_once_dispatch_intents SET state='UNKNOWN',updated_at=datetime('now')
		WHERE schedule_uuid=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN')`, row.uuidArg())
	return errors.Join(err, dispatchErr, fmt.Errorf("transport result %s", phase))
}

// setValveOnceSchedule is store.js updateSchedule, whose scheduleScope
// refuses a key that is not 16 hex digits; the caller's transaction then
// rolls back every write it made with it. The scope it binds is the trimmed,
// upper-cased key, so a stored key with padding (`\tKEY\t`) matches no row
// and the schedule stays as it is, while the caller's other writes go on.
func setValveOnceSchedule(ctx context.Context, tx *farmTx, row valveOnceIntent, state string, firedAt any) error {
	scope, valid := normalizeValveDispatchEUI(row.valve.eui)
	if !valid {
		return fmt.Errorf("updateSchedule: %w", errInvalidValveEUI)
	}
	_, err := tx.ExecContext(ctx, `UPDATE valve_schedules SET once_state=?,once_fired_at=COALESCE(?,once_fired_at),
		sync_version=COALESCE(sync_version,0)+1,updated_at=datetime('now') WHERE schedule_uuid=? AND UPPER(device_eui)=?
		AND once_state='PENDING' AND deleted_at IS NULL`, state, firedAt, row.uuidArg(), scope)
	return err
}

func (b *backend) finalizeValveOnce(ctx context.Context, row valveOnceIntent, now time.Time, proof, queueID, observedID string) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stored sql.NullString
	// workers.js finalizeOnceAccepted reads the expectation by command_id
	// alone: a stored key with padding (the dispatch wrote the expectation
	// under the trimmed key) still gets its proof.
	err = tx.QueryRowContext(ctx, `SELECT transport_json,commanded_duration_seconds FROM valve_actuation_expectations
		WHERE command_id=?`, row.command).Scan(&stored, &row.seconds)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		transport, err := valveStoredJSON(stored.String)
		if err != nil {
			return err
		}
		if queueID != "" {
			transport.Set(jsvalue.Property("queue_id", jsvalue.Str(queueID)))
		}
		transport.Set(jsvalue.Property("proof", jsvalue.Str(proof)))
		if _, err := tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE command_id=?",
			valveJSON(transport), row.command); err != nil {
			return err
		}
		if _, _, minutes, ok := valveOnceFrame(row, transport); ok {
			row.minutes = minutes
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE valve_once_dispatch_intents SET state='SENT',updated_at=datetime('now')
		WHERE schedule_uuid=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN','SENT')`, row.uuidArg()); err != nil {
		return err
	}
	if err := setValveOnceSchedule(ctx, tx, row, "FIRED", row.fireAt); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO actuator_log(deveui,irrigation_zone_id,action,duration_minutes,reason,created_at)
		SELECT ?,?,'OPEN_FOR_DURATION',?,?,? WHERE NOT EXISTS (SELECT 1 FROM actuator_log WHERE reason=?)`,
		row.valve.eui, zoneDouble(row.valve.zone), row.minutes, row.marker(), valveISO(now), row.marker()); err != nil {
		return err
	}
	if row.valve.user.Valid && row.valve.zone.Valid {
		payload := jsvalue.Obj(
			jsvalue.Property("schedule_uuid", row.uuidJSON()),
			jsvalue.Property("command_id", jsvalue.Str(row.command)),
			jsvalue.Property("fire_at", jsvalue.Str(row.fireAt)),
			jsvalue.Property("proof", jsvalue.Str(proof)),
		)
		if observedID != "" {
			payload.Set(jsvalue.Property("expectation_id", jsvalue.Str(observedID)))
			payload.Set(jsvalue.Property("message", jsvalue.Str("Valve reported open")))
		}
		if err := recordValveOnceEvent(ctx, tx, row, "one_time_open", payload, observedID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (b *backend) skipValveOnce(ctx context.Context, row valveOnceIntent, state jsvalue.Value, now time.Time, reason string, deadline *valveOnceDeadline) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE valve_once_dispatch_intents SET state='SKIPPED',updated_at=datetime('now')
		WHERE schedule_uuid=? AND command_id=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN','SENT')`, row.uuidArg(), row.command)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return err
	}
	if row.expectation.Valid {
		state.Set(jsvalue.Property("once_settlement", jsvalue.Str(reason)))
		if _, err := tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
			valveJSON(state), row.expectation.String); err != nil {
			return err
		}
	}
	if err := setValveOnceSchedule(ctx, tx, row, "SKIPPED", nil); err != nil {
		return err
	}
	if row.valve.user.Valid && row.valve.zone.Valid {
		payload := jsvalue.Obj(jsvalue.Property("schedule_uuid", row.uuidJSON()), jsvalue.Property("fire_at", jsvalue.Str(row.fireAt)))
		var created any
		if deadline != nil {
			phase := state.Get("phase").OrEmpty().MustString()
			if phase == "" {
				phase = row.state
			}
			payload.Set(jsvalue.Property("attempted_at", jsvalue.Str(deadline.attempted)))
			payload.Set(jsvalue.Property("confirm_by", jsvalue.Str(deadline.text)))
			payload.Set(jsvalue.Property("interval", jsvalue.Num(deadline.interval)))
			payload.Set(jsvalue.Property("phase", jsvalue.Str(phase)))
			payload.Set(jsvalue.Property("note", jsvalue.Str("Enqueue was attempted but not confirmed.")))
			created = valveISO(now)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO irrigation_events
			(user_id,irrigation_zone_id,action,reason,duration_minutes,valve_deveui,payload_json,created_at)
			VALUES (?,?,'SKIP',?,?,?,?,COALESCE(?,datetime('now')))`, row.valve.user, zoneDouble(row.valve.zone), "one_time_"+reason,
			row.storedMinutes(), row.valve.eui, valveJSON(payload), created); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type valveOnceDeadline struct {
	at        time.Time
	text      string
	attempted string
	interval  float64
}

func valveAckInstant(raw string) (time.Time, bool) {
	if !strings.Contains(raw, "T") {
		raw = strings.Replace(raw, " ", "T", 1) + "Z"
	}
	return jsdate.Parse(raw, dailyScheduleLocation())
}

func savedValveOnceDeadline(state jsvalue.Value, attempted string) (valveOnceDeadline, bool) {
	text, interval := state.Get("once_confirm_by"), state.Get("once_interval_minutes")
	if text.Kind == jsvalue.String && interval.Kind == jsvalue.Number && !math.IsInf(interval.Num, 0) && !math.IsNaN(interval.Num) {
		if at, valid := valveAckInstant(text.MustString()); valid {
			return valveOnceDeadline{at: at, text: text.MustString(), attempted: attempted, interval: interval.Num}, true
		}
	}
	return valveOnceDeadline{}, false
}

func (b *backend) valveOnceConfirmation(ctx context.Context, row valveOnceIntent, state *jsvalue.Value, now time.Time) (valveOnceDeadline, error) {
	attempted := row.attempted.String
	if attempted == "" {
		attempted = state.Get("attempted_at").OrEmpty().MustString()
	}
	if attempted == "" {
		attempted = row.fireAt
	}
	if saved, valid := savedValveOnceDeadline(*state, attempted); valid {
		return saved, nil
	}
	anchor, valid := valveAckInstant(attempted)
	asOf := anchor
	if !valid {
		asOf = now
		anchor, valid = valveAckInstant(row.fireAt)
	}
	if !valid {
		return valveOnceDeadline{}, errors.New("one-time confirmation needs an attempt or fire time")
	}
	// store.js recentUplinkTimes: the text bounds (the since date and the
	// next day) drop a recorded_at that julianday() alone would admit, such
	// as a Julian day number in text, before LIMIT 10 takes its rows.
	since := valveISO(asOf.Add(-48 * time.Hour))
	rows, err := b.db.QueryContext(ctx, `SELECT recorded_at FROM device_data WHERE deveui=?
		AND recorded_at >= ? AND recorded_at < ?
		AND julianday(recorded_at) BETWEEN julianday(?) AND julianday(?) ORDER BY julianday(recorded_at) DESC LIMIT 10`,
		row.valve.eui, since[:10], valveISO(asOf.Add(24 * time.Hour))[:10], since, valveISO(asOf))
	if err != nil {
		return valveOnceDeadline{}, err
	}
	defer rows.Close()
	var gaps []time.Duration
	var previous time.Time
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return valveOnceDeadline{}, err
		}
		report, valid := valveAckInstant(raw)
		if !valid {
			continue
		}
		if !previous.IsZero() && previous.Sub(report) >= 30*time.Second {
			gaps = append(gaps, previous.Sub(report))
		}
		previous = report
	}
	if err := rows.Err(); err != nil {
		return valveOnceDeadline{}, err
	}
	interval := 10.0
	if len(gaps) >= 2 {
		slices.Sort(gaps)
		interval = float64(gaps[len(gaps)/2]) / float64(time.Minute)
		if len(gaps)%2 == 0 {
			interval = (interval + float64(gaps[len(gaps)/2-1])/float64(time.Minute)) / 2
		}
	}
	deadline := anchor.Add(time.Duration(math.Min(180, math.Max(15, 2*interval+5)) * float64(time.Minute)))
	text := valveISO(deadline)
	if row.expectation.Valid {
		_, err := b.db.ExecContext(ctx, `UPDATE valve_actuation_expectations SET transport_json=json_set(transport_json,
			'$.once_confirm_by',?,'$.once_interval_minutes',?) WHERE expectation_id=? AND json_valid(transport_json)
			AND json_extract(transport_json,'$.once_confirm_by') IS NULL`, text, interval, row.expectation.String)
		if err != nil {
			return valveOnceDeadline{}, err
		}
		var raw sql.NullString
		err = b.db.QueryRowContext(ctx, "SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?", row.expectation.String).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return valveOnceDeadline{}, err
		}
		if saved, err := valveStoredJSON(raw.String); err == nil {
			if confirmation, valid := savedValveOnceDeadline(saved, attempted); valid {
				*state = saved
				return confirmation, nil
			}
		}
	}
	return valveOnceDeadline{at: deadline, text: text, attempted: attempted, interval: interval}, nil
}

func valveOnceFrame(row valveOnceIntent, state jsvalue.Value) (port uint32, frame []byte, minutes int, ok bool) {
	snapshot := state.Get("effect_snapshot")
	if !snapshot.Truthy() {
		snapshot = state.Get("attempt")
	}
	if snapshot.Truthy() {
		seconds := snapshot.Get("encoded_duration_seconds").MustNumber()
		fport := snapshot.Get("fPort").MustNumber()
		if !valveWhole(jsvalue.Num(fport), 1, 255) || seconds <= 0 || !valveWhole(jsvalue.Num(seconds), 1, 255*3600) {
			return 0, nil, 0, false
		}
		var err error
		frame, err = hex.DecodeString(snapshot.Get("bytes_hex").MustString())
		if err != nil || len(frame) == 0 {
			frame, err = base64.StdEncoding.DecodeString(snapshot.Get("data").MustString())
		}
		return uint32(fport), frame, int(seconds) / 60, err == nil && len(frame) > 0
	}
	if row.seconds <= 0 || row.seconds%60 != 0 || row.seconds/60 > 255 {
		return 0, nil, 0, false
	}
	return 2, []byte{0x41, byte(row.seconds / 60)}, row.seconds / 60, true
}

func valveOnceSnapshotMatches(transport jsvalue.Value, eui string, minutes int) bool {
	snapshot := transport.Get("effect_snapshot")
	return minutes > 0 && minutes <= 255 && snapshot.Get("effect_class").MustString() == "SELF_CLOSING_OPEN" &&
		validReleasableValveEffect(snapshot, "SELF_CLOSING_OPEN") &&
		snapshot.Get("device_eui").MustString() == eui && snapshot.Get("provenance").Get("encoder").MustString() == "strega-v1" &&
		snapshot.Get("data").MustString() == base64.StdEncoding.EncodeToString([]byte{0x41, byte(minutes)}) &&
		snapshot.Get("explicit_expiry_at").Kind == jsvalue.Null && !transport.Get("explicit_expiry_at").Truthy()
}

type valveOnceQueue struct {
	items              []*api.DeviceQueueItem
	started, completed time.Time
}

func readValveOnceQueue(ctx context.Context, eui string) valveOnceQueue {
	radio, err := openValveRadioLazy()
	if err != nil {
		log.Printf("one-time queue %s: %v", eui, err)
		return valveOnceQueue{}
	}
	defer radio.conn.Close()
	started := time.Now()
	items, err := radio.readValveQueue(ctx, eui)
	if err != nil {
		log.Printf("one-time queue %s: %v", eui, err)
		return valveOnceQueue{}
	}
	for _, item := range items {
		if item.GetFPort() == 0 || item.GetFPort() > 255 || len(item.GetData()) == 0 {
			return valveOnceQueue{}
		}
	}
	return valveOnceQueue{items, started, time.Now()}
}

func (b *backend) settleUncertainValveOnce(ctx context.Context, row valveOnceIntent, state jsvalue.Value, now time.Time, queues map[string]valveOnceQueue) error {
	// workers.js readQueue takes withValveWriter(device_eui) first, which
	// refuses a malformed key before the queue read or any write.
	if _, valid := normalizeValveDispatchEUI(row.valve.eui); !valid {
		return errInvalidValveEUI
	}
	queue, seen := queues[row.valve.eui]
	if !seen {
		queue = readValveOnceQueue(ctx, row.valve.eui)
		queues[row.valve.eui] = queue
		if err := b.recordValveQueueAbsence(ctx, row.valve.eui, queue); err != nil {
			return err
		}
	}
	if row.expectation.Valid {
		var raw sql.NullString
		if err := b.db.QueryRowContext(ctx, "SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?", row.expectation.String).Scan(&raw); err != nil {
			return err
		}
		var err error
		state, err = valveStoredJSON(raw.String)
		if err != nil {
			return err
		}
	}
	deadline, err := b.valveOnceConfirmation(ctx, row, &state, now)
	if err != nil {
		return err
	}
	port, frame, minutes, validFrame := valveOnceFrame(row, state)
	if validFrame {
		row.minutes = minutes
	}
	anchor, _ := valveAckInstant(deadline.attempted)
	if observed, err := b.valveOnceObservation(ctx, row, anchor, minValveTime(now, deadline.at)); err != nil {
		return err
	} else if observed.id != "" {
		return b.finalizeValveOnce(ctx, row, now, "observed_open", "", observed.id)
	}
	if validFrame && row.expectation.Valid && len(queue.items) > 0 {
		id, err := b.valveOnceQueueMatch(ctx, row, state, queue.items, port, frame, now)
		if err != nil {
			return err
		}
		if id != "" {
			return b.finalizeValveOnce(ctx, row, now, "queue", id, "")
		}
	}
	if now.After(deadline.at) {
		return b.skipValveOnce(ctx, row, state, now, "uncertain", &deadline)
	}
	return nil
}

func minValveTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

type valveOnceObserved struct {
	id string
	at time.Time
}

func (b *backend) valveOnceObservation(ctx context.Context, row valveOnceIntent, start, end time.Time) (valveOnceObserved, error) {
	none := valveOnceObserved{}
	var competing bool
	err := b.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM actuator_log WHERE UPPER(deveui)=?
		AND reason IS NOT ? AND (UPPER(action) IN ('OPEN','OPEN_FOR_MINUTES','TIMED_OPEN','OPEN_FOR_DURATION',
		'OPEN_FOR_DURATION_CONDITIONAL','SET_PARTIAL_OPENING','SET_FLUSHING') OR instr(UPPER(action),'SET_PARTIAL_OPENING ')=1
		OR instr(UPPER(action),'SET_FLUSHING ')=1) AND julianday(created_at) BETWEEN julianday(?) AND julianday(?))`,
		jsvalue.Upper(row.valve.eui), row.marker(), valveISO(start), valveISO(end)).Scan(&competing)
	if err != nil || competing {
		return none, err
	}
	rows, err := b.db.QueryContext(ctx, `SELECT expectation_id,command_id,trigger,reconciliation_state,observed_open_at,transport_json
		FROM valve_actuation_expectations WHERE UPPER(device_eui)=?`, jsvalue.Upper(row.valve.eui))
	if err != nil {
		return none, err
	}
	defer rows.Close()
	var observed valveOnceObserved
	for rows.Next() {
		var id, rec string
		var command, trigger, opened, raw sql.NullString
		if err := rows.Scan(&id, &command, &trigger, &rec, &opened, &raw); err != nil {
			return none, err
		}
		transport, err := valveStoredJSON(raw.String)
		at := valveInstant(opened.String)
		evidence := transport.Get("observation")
		if !valveTimeInside(at, start, end) && rec == "OBSERVED_RUNNING" {
			at = valveInstant(evidence.Get("observed_at").MustString())
		}
		if !valveTimeInside(at, start, end) {
			continue
		}
		physical := transport.Get("physical_run")
		if err != nil || observed.id != "" || command.String != row.command && (command.Valid ||
			trigger.String != "unexplained" || physical.Get("version").Num != 1 ||
			physical.Get("source").MustString() != "explicit_report" || evidence.Get("untrusted").Truthy() ||
			!evidence.Get("proof").Truthy() || evidence.Get("unattributed").MustString() == "ambiguous_owner") {
			return none, nil
		}
		observed = valveOnceObserved{id, at}
	}
	if err := rows.Err(); err != nil || observed.id == "" {
		return none, err
	}
	uncertain, err := b.onceObservationHasCompetitor(ctx, row, start, end, observed.at)
	if err != nil || uncertain {
		return none, err
	}
	return observed, nil
}

func valveTimeInside(at, start, end time.Time) bool {
	return !at.IsZero() && !at.Before(start) && !at.After(end)
}

func (b *backend) onceObservationHasCompetitor(ctx context.Context, row valveOnceIntent, start, end, observed time.Time) (bool, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT e.commanded_duration_seconds,e.commanded_at,e.observed_open_at,e.transport_json,
		i.attempted_at,o.expires_at FROM valve_actuation_expectations e LEFT JOIN valve_once_dispatch_intents i ON i.command_id=e.command_id
		LEFT JOIN irrigation_occurrences o ON o.command_id=e.command_id AND UPPER(o.device_eui)=UPPER(e.device_eui)
		WHERE UPPER(e.device_eui)=? AND (e.command_id IS NULL OR e.command_id<>?)`,
		jsvalue.Upper(row.valve.eui), row.command)
	if err != nil {
		return true, err
	}
	defer rows.Close()
	for rows.Next() {
		var commanded, open, raw, attempted, expires sql.NullString
		var seconds int
		if err := rows.Scan(&seconds, &commanded, &open, &raw, &attempted, &expires); err != nil {
			return true, err
		}
		if seconds <= 0 {
			continue
		}
		other, err := valveStoredJSON(raw.String)
		if err != nil {
			return true, nil
		}
		phase := other.Get("phase").OrEmpty().MustString()
		if !valveOnceAttempted(other) && !other.Get("attempt_receipt").Truthy() &&
			!(other.Get("attempted_at").Truthy() && phase != "" && phase != "INTENT" && phase != "SNAPSHOT") {
			continue
		}
		var first time.Time
		for _, stamp := range []string{other.Get("attempt_trusted_at").MustString(), other.Get("attempted_at").MustString(), attempted.String} {
			at := valveInstant(stamp)
			if valveTimeInside(at, start, end) {
				return true, nil
			}
			if first.IsZero() {
				first = at
			}
		}
		if first.IsZero() {
			first = valveInstant(commanded.String)
		}
		if valveTimeInside(first, start, end) {
			return true, nil
		}
		if first.IsZero() || !first.Before(start) || first.After(observed) || valveOnceTransportResolved(other, start) {
			continue
		}
		opened := valveInstant(open.String)
		if opened.IsZero() {
			opened = valveInstant(other.Get("observation").Get("observed_at").MustString())
		}
		if !opened.IsZero() && opened.Before(start) {
			continue
		}
		if expiry := valveOnceAppliedExpiry(other, expires); expiry.IsZero() || expiry.After(observed) {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return true, err
	}
	control, err := loadValveControl(ctx, b.db, row.valve.eui)
	if err != nil {
		return true, err
	}
	for _, other := range control.Get("opaque").List {
		expiry := valveOnceAppliedExpiry(other, sql.NullString{})
		if valveOpaqueMayOpen(other) && !valveOnceTransportResolved(other, start) &&
			(expiry.IsZero() || expiry.After(observed)) {
			attempted := valveInstant(other.Get("attempted_at").MustString())
			if attempted.IsZero() || !attempted.After(end) {
				return true, nil
			}
		}
	}
	return false, nil
}

func valveOnceAppliedExpiry(state jsvalue.Value, occurrence sql.NullString) time.Time {
	if occurrence.Valid {
		return valveInstant(occurrence.String)
	}
	if snapshot := state.Get("effect_snapshot"); snapshot.Truthy() {
		return valveInstant(snapshot.Get("explicit_expiry_at").MustString())
	}
	if state.Get("captured_by_flush").Truthy() {
		if at := valveInstant(state.Get("expiresAt").MustString()); !at.IsZero() {
			return at
		}
		return valveInstant(state.Get("expires_at").MustString())
	}
	return valveInstant(state.Get("explicit_expiry_at").MustString())
}

func valveOnceAttempted(state jsvalue.Value) bool {
	phase := state.Get("phase").MustString()
	return phase == "ATTEMPTED" || phase == "UNKNOWN" || phase == "ACCEPTED"
}

func valveOnceTransportResolved(state jsvalue.Value, before time.Time) bool {
	phase := state.Get("phase").MustString()
	if phase == "enqueue_rejected" || phase == "enqueue_failed_before_acceptance" ||
		state.Get("cancelled_unsent_at").Truthy() || state.Get("cancelled_before_send_at").Truthy() ||
		state.Get("first_invalidated_by_flush").Truthy() && state.Get("unsent_in_snapshot").Bool {
		return true
	}
	start := valveInstant(state.Get("queue_absent_read_started_at").MustString())
	complete := valveInstant(state.Get("queue_absent_read_completed_at").MustString())
	return valveQueueAbsenceEligible(state, start, complete) && (before.IsZero() || !complete.After(before))
}

func valveOpaqueMayOpen(item jsvalue.Value) bool {
	port := item.Get("fPort")
	if port.Kind == jsvalue.Undefined || port.Kind == jsvalue.Null {
		port = item.Get("fport")
	}
	number := port.MustNumber()
	if math.IsNaN(number) || number == 0 || number == 28 {
		return true
	}
	payload, _ := base64.StdEncoding.DecodeString(item.Get("data").OrEmpty().MustString())
	if number == 27 {
		return len(payload) == 0 || payload[0] == 0x31
	}
	return number == 2 && (len(payload) == 0 || payload[0] == 0x21 || payload[0] == 0x41 || payload[0] == 0x81)
}

func (b *backend) valveOnceQueueMatch(ctx context.Context, row valveOnceIntent, state jsvalue.Value, queue []*api.DeviceQueueItem, port uint32, frame []byte, now time.Time) (string, error) {
	otherIDs := make(map[string]bool)
	rows, err := b.db.QueryContext(ctx, `SELECT transport_json,o.expires_at FROM valve_actuation_expectations e
		LEFT JOIN irrigation_occurrences o ON o.command_id=e.command_id AND UPPER(o.device_eui)=UPPER(e.device_eui)
		WHERE UPPER(e.device_eui)=? AND (e.command_id IS NULL OR e.command_id<>?)`, jsvalue.Upper(row.valve.eui), row.command)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var raw, expires sql.NullString
		if err := rows.Scan(&raw, &expires); err != nil {
			return "", err
		}
		other, err := valveStoredJSON(raw.String)
		if err != nil {
			return "", nil
		}
		if id := other.Get("queue_id"); id.Truthy() {
			key, err := id.CoerceString()
			if err != nil {
				return "", err
			}
			otherIDs[key] = true
			continue
		}
		applied := valveOnceAppliedExpiry(other, expires)
		if valveOnceAttempted(other) && !valveOnceTransportResolved(other, time.Time{}) && (applied.IsZero() || applied.After(now)) {
			return "", nil
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	control, err := loadValveControl(ctx, b.db, row.valve.eui)
	if err != nil {
		return "", err
	}
	encoded := base64.StdEncoding.EncodeToString(frame)
	for _, other := range control.Get("opaque").List {
		if other.Kind != jsvalue.Object {
			return "", nil
		}
		if id := other.Get("queue_id"); id.Truthy() {
			key, err := id.CoerceString()
			if err != nil {
				return "", err
			}
			otherIDs[key] = true
			continue
		}
		if payload := other.Get("data"); payload.Truthy() && (payload.Kind != jsvalue.String || payload.MustString() != encoded) {
			continue
		}
		expiry := valveOnceAppliedExpiry(other, sql.NullString{})
		if valveOpaqueMayOpen(other) && valveOnceAttempted(other) && !valveOnceTransportResolved(other, time.Time{}) &&
			(expiry.IsZero() || expiry.After(now)) {
			return "", nil
		}
	}
	storedID := state.Get("queue_id")
	for _, item := range queue {
		id := item.GetId()
		if id == "" || item.GetFPort() != port || !bytes.Equal(item.GetData(), frame) {
			continue
		}
		key, err := storedID.CoerceString()
		if err != nil {
			return "", err
		}
		if (!storedID.Truthy() || key == id) && !otherIDs[id] {
			return id, nil
		}
	}
	return "", nil
}

func valveQueueAbsenceEligible(state jsvalue.Value, start, end time.Time) bool {
	if start.IsZero() || end.Before(start) {
		return false
	}
	var finished time.Time
	for _, field := range []string{"accepted_at", "unknown_at", "failed_at"} {
		if at := valveInstant(state.Get(field).MustString()); at.After(finished) {
			finished = at
		}
	}
	if finished.IsZero() {
		for _, field := range []string{"attempt_trusted_at", "attempted_at", "intent_at"} {
			if finished = valveInstant(state.Get(field).MustString()); !finished.IsZero() {
				break
			}
		}
	}
	budget := max(60000.0, valveRPCDeadlineMS())
	if timeout := state.Get("enqueue_timeout_ms"); timeout.Kind == jsvalue.Number {
		budget = max(budget, timeout.Num)
	}
	return !finished.IsZero() && float64(start.Sub(finished).Milliseconds()) >= budget
}

func (b *backend) recordValveQueueAbsence(ctx context.Context, eui string, queue valveOnceQueue) error {
	if queue.items == nil {
		return nil
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := func(state *jsvalue.Value) bool {
		if state.Get("queue_id").Truthy() || valveOnceTransportResolved(*state, time.Time{}) ||
			!valveQueueAbsenceEligible(*state, queue.started, queue.completed) {
			return false
		}
		frame := state.Get("effect_snapshot")
		if !frame.Truthy() {
			frame = state.Get("attempt")
		}
		if !frame.Truthy() {
			frame = *state
		}
		port := frame.Get("fPort").MustNumber()
		if math.IsNaN(port) {
			port = frame.Get("fport").MustNumber()
		}
		data, err := hex.DecodeString(frame.Get("bytes_hex").MustString())
		if len(data) == 0 || err != nil {
			data, err = base64.StdEncoding.DecodeString(frame.Get("data").MustString())
		}
		if err != nil || len(data) == 0 || !valveWhole(jsvalue.Num(port), 1, 255) {
			return false
		}
		for _, item := range queue.items {
			if float64(item.GetFPort()) == port && bytes.Equal(item.GetData(), data) {
				return false
			}
		}
		state.Set(jsvalue.Property("queue_absent_at", jsvalue.Str(valveISO(queue.completed))))
		state.Set(jsvalue.Property("queue_absent_read_started_at", jsvalue.Str(valveISO(queue.started))))
		state.Set(jsvalue.Property("queue_absent_read_completed_at", jsvalue.Str(valveISO(queue.completed))))
		return true
	}
	rows, err := tx.QueryContext(ctx, "SELECT expectation_id,transport_json FROM valve_actuation_expectations WHERE device_eui=?", eui)
	if err != nil {
		return err
	}
	defer rows.Close()
	type update struct{ id, json string }
	var edits []update
	for rows.Next() {
		var id string
		var raw sql.NullString
		if err := rows.Scan(&id, &raw); err != nil {
			return err
		}
		if state, err := valveStoredJSON(raw.String); err == nil && stamp(&state) {
			edits = append(edits, update{id, valveJSON(state)})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, edit := range edits {
		if _, err := tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?", edit.json, edit.id); err != nil {
			return err
		}
	}
	control, err := loadValveControl(ctx, tx, eui)
	if err != nil {
		return err
	}
	owners := control.Get("opaque").List
	changed := false
	for i := range owners {
		if stamp(&owners[i]) {
			changed = true
		}
	}
	if changed {
		if err := writeValveControl(ctx, tx, eui, control); err != nil {
			return err
		}
	}
	return tx.Commit()
}
