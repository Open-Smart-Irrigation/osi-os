package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

func init() {
	registerTimer("valve-once-tick", time.Minute, 20*time.Second, (*backend).valveOnceTick)
	registerTimer("valve-clock-tick", time.Minute, 90*time.Second, (*backend).valveClockTick)
}

func (b *backend) valveClockTick(ctx context.Context) error {
	valveWriter.Lock()
	defer valveWriter.Unlock()
	now := time.Now()
	if err := b.emitPendingValvePlans(ctx, now); err != nil {
		log.Printf("valve snapshots: %v", err)
	}
	// runHousekeeping does not catch emitPendingClears: a malformed stored
	// control ends the whole valve tick before the clock and sweep work. The
	// flow node catches the rejection, so the tick logs and stops.
	if err := b.emitPendingConditionalPlans(ctx, now); err != nil {
		log.Printf("valve pending clears: %v", err)
		return nil
	}
	fallback := storedGatewaySetting(ctx, b.db, "gateway_timezone")
	// A throw here (upsertSettings' foreign-key failure on a SKIP_TODAY
	// reset) leaves runHousekeeping; the flow node catches the rejection, so
	// the tick logs and stops before the decommission sweep and runClockTick.
	if err := b.maintainValveClockSettings(ctx, now, fallback); err != nil {
		log.Printf("valve housekeeping: %v", err)
		return nil
	}
	// queueSnapshot writes the decommission rows, then the send's
	// normalizeDevice throws out of runHousekeeping: runClockTick never runs.
	if err := b.decommissionValvePlans(ctx, now); err != nil {
		if errors.Is(err, errInvalidValveEUI) {
			log.Printf("decommission valve: %v", err)
			return nil
		}
		return err
	}
	if err := b.failStaleValvePushes(ctx, now); err != nil {
		return err
	}
	rows, err := b.db.QueryContext(ctx, `SELECT d.deveui, z.timezone, v.strega_generation, v.last_clock_sync_queued_at,
		(SELECT timezone FROM valve_schedules s WHERE s.device_eui=d.deveui AND deleted_at IS NULL
		AND timezone IS NOT NULL ORDER BY (kind='WEEKLY' AND enabled=1) DESC, kind='WEEKLY' DESC, id LIMIT 1)
		FROM devices d LEFT JOIN irrigation_zones z ON z.id=d.irrigation_zone_id AND z.deleted_at IS NULL
		LEFT JOIN valve_settings v ON v.device_eui=d.deveui WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL
		AND EXISTS (SELECT 1 FROM valve_schedules s WHERE s.device_eui=d.deveui AND s.deleted_at IS NULL)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type target struct {
		eui              string
		generation, last sql.NullString
		zone, schedule   storedValue
	}
	var valves []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.eui, &t.zone, &t.generation, &t.last, &t.schedule); err != nil {
			return err
		}
		valves = append(valves, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var tickErr error
	for _, v := range valves {
		// workers.js: v.schedule_timezone || v.zone_timezone || gatewayTimezone
		// || 'UTC', each with its storage class (an empty BLOB is a truthy
		// Buffer, which Intl refuses, so the clock is formatted in UTC).
		loc := timezoneChain(v.schedule, v.zone, fallback).location()
		// workers.js runClockTick: Date.parse of a non-empty stamp that does
		// not parse is NaN, so the valve is neither due nor in a DST window.
		last, parsed := jsdate.Parse(v.last.String, dailyScheduleLocation())
		if v.last.String != "" && !parsed {
			continue
		}
		if err := b.syncValveClock(ctx, jsvalue.Upper(v.eui), v.generation.String, now, last, loc); err != nil {
			// queuePushes inserts the push row, then enqueueValveCommand's
			// normalizeDevice throws out of runClockTick: later valves wait.
			if errors.Is(err, errInvalidValveEUI) {
				log.Printf("valve clock %s: %v", v.eui, err)
				return tickErr
			}
			tickErr = errors.Join(tickErr, fmt.Errorf("valve clock %s: %w", v.eui, err))
		}
	}
	return tickErr
}

func (b *backend) failStaleValvePushes(ctx context.Context, now time.Time) error {
	cutoff := valveISO(now.Add(-24 * time.Hour))
	stale, err := queryZones(ctx, b.db, `SELECT DISTINCT device_eui FROM valve_schedule_pushes
		WHERE state='QUEUED' AND purpose IN `+planPushPurposes+` AND datetime(queued_at)<datetime(?)`, cutoff)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `UPDATE valve_schedule_pushes SET state='FAILED',
		error=CASE WHEN purpose IN `+planPushPurposes+` THEN 'stale_unconfirmed' ELSE 'no_ack_24h' END
		WHERE state='QUEUED' AND datetime(queued_at)<datetime(?)`, cutoff)
	if err != nil {
		return err
	}
	for _, valve := range stale {
		eui := valve.Get("device_eui").MustString()
		if err := emitPlanRuntime(ctx, b.db, eui, now); err != nil {
			log.Printf("stale valve push runtime %s: %v", eui, err)
		}
	}
	return nil
}

func (b *backend) decommissionValvePlans(ctx context.Context, now time.Time) error {
	retired, err := queryZones(ctx, b.db, `SELECT d.deveui, COALESCE(vs.strega_generation,'GEN1') AS generation
		FROM devices d LEFT JOIN valve_settings vs ON vs.device_eui=d.deveui
		WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NOT NULL
		AND EXISTS (SELECT 1 FROM valve_schedule_pushes p WHERE p.device_eui=d.deveui
		    AND p.purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND p.state='ACKED' AND p.plan_hash<>?)
		AND NOT EXISTS (SELECT 1 FROM valve_schedule_pushes p WHERE p.device_eui=d.deveui
		    AND p.purpose='SCHEDULER_STATUS' AND p.payload_hex='32' AND datetime(p.queued_at)>datetime(d.deleted_at))`,
		planHash(nil))
	if err != nil || len(retired) == 0 {
		return err
	}
	for _, valve := range retired {
		eui := jsvalue.Upper(valve.Get("deveui").MustString())
		frames := []planPush{{purpose: "SCHEDULER_STATUS", port: 21, data: []byte{'2'}}}
		frames = append(frames, weekdayFrames([7][]planWindow{}, valve.Get("generation").MustString(), false)...)
		rows, err := b.prepareDecommissionedValve(ctx, eui, frames, now)
		if err != nil {
			return err
		}
		if err := b.sendDecommissionedValve(ctx, eui, rows); err != nil {
			if errors.Is(err, errInvalidValveEUI) {
				return err
			}
			log.Printf("decommission valve %s: %v", eui, err)
		}
	}
	return nil
}

func (b *backend) prepareDecommissionedValve(ctx context.Context, eui string, frames []planPush, now time.Time) ([]jsvalue.Value, error) {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := supersedePlanPushes(ctx, tx, eui); err != nil {
		return nil, err
	}
	ids, err := insertPlanPushes(ctx, tx, eui, frames, jsvalue.Value{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_settings WHERE key=?", pendingValvePlan+eui); err != nil {
		return nil, err
	}
	if err := emitPlanRuntime(ctx, tx, eui, now); err != nil {
		log.Printf("decommission valve %s runtime: %v", eui, err)
	}
	rows, err := requiredPlanRows(ctx, tx, eui, jsvalue.Arr(ids...))
	if err != nil {
		return nil, err
	}
	return rows, tx.Commit()
}

func (b *backend) sendDecommissionedValve(ctx context.Context, eui string, rows []jsvalue.Value) error {
	if _, valid := normalizeValveDispatchEUI(eui); !valid && len(rows) > 0 {
		return errInvalidValveEUI
	}
	radio, err := openValveRadioLazy()
	if err != nil {
		return err
	}
	defer radio.conn.Close()
	var failures error
	for _, row := range rows {
		_, err := enqueuePlanPush(ctx, b.db, radio, eui, row)
		failures = errors.Join(failures, err)
	}
	return failures
}

// maintainValveClockSettings is workers.js runHousekeeping between the pending
// clears and the decommission sweep, in its order: the SKIP_TODAY resets,
// then the clock-jump detector, whose previous-tick stamp moves only once the
// resets are through.
func (b *backend) maintainValveClockSettings(ctx context.Context, now time.Time, fallback storedValue) error {
	rows, err := b.db.QueryContext(ctx, `SELECT v.device_eui,v.skip_today_date,z.timezone FROM valve_settings v
		JOIN devices d ON d.deveui=v.device_eui LEFT JOIN irrigation_zones z ON z.id=d.irrigation_zone_id
		WHERE v.scheduler_status='SKIP_TODAY'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var expired []string
	for rows.Next() {
		var eui string
		var date sql.NullString
		var tz storedValue
		if err := rows.Scan(&eui, &date, &tz); err != nil {
			return err
		}
		// workers.js: P.localParts(nowDate, s.zone_timezone || gatewayTimezone
		// || 'UTC'); an empty-BLOB zone timezone is truthy and formats in UTC.
		loc := timezoneChain(tz, fallback).location()
		if now.In(loc).Format("2006-01-02") > date.String {
			expired = append(expired, eui)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, eui := range expired {
		if err := resetValveSkipToday(ctx, b.db, eui); err != nil {
			return err
		}
	}
	last := b.valveClockLastTick
	elapsed := now.Round(0).Sub(last.Round(0))
	if !last.IsZero() && (elapsed < -time.Minute || elapsed > 6*time.Hour) {
		_, err := b.db.ExecContext(ctx, `UPDATE valve_settings SET last_clock_sync_queued_at=NULL
			WHERE device_eui IN (SELECT device_eui FROM valve_schedules WHERE deleted_at IS NULL)`)
		if err != nil {
			return err
		}
		log.Print("gateway clock jump: valve clocks due for resynchronization")
	}
	b.valveClockLastTick = now
	return nil
}

// resetValveSkipToday is store.js upsertSettings(db, key, {scheduler_status:
// 'ACTIVE', skip_today_date: null}). It writes the upper-cased decoded key,
// not the stored one: INSERT OR IGNORE first, which a foreign-key failure
// still throws through (a lowercase or invalid-UTF-8 key has no devices row
// under its upper-cased spelling), and that throw ends runHousekeeping, so
// runValveTick never reaches runClockTick. scheduler_status and
// skip_today_date are synced columns, so the UPDATE bumps sync_version.
func resetValveSkipToday(ctx context.Context, db *farmDB, storedKey string) error {
	eui := jsvalue.Upper(storedKey)
	if _, err := db.ExecContext(ctx, "INSERT OR IGNORE INTO valve_settings(device_eui) VALUES (?)", eui); err != nil {
		return fmt.Errorf("valve SKIP_TODAY reset %q: %w", eui, err)
	}
	_, err := db.ExecContext(ctx, `UPDATE valve_settings SET scheduler_status=?, skip_today_date=?,
		sync_version = COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE device_eui=?`, "ACTIVE", nil, eui)
	return err
}

func (b *backend) syncValveClock(ctx context.Context, eui, generation string, now, last time.Time, loc *time.Location) error {
	if !last.IsZero() && now.Sub(last) < 7*24*time.Hour {
		_, thenOffset := last.In(loc).Zone()
		_, nowOffset := now.In(loc).Zone()
		if thenOffset == nowOffset {
			return nil
		}
	}
	var previous string
	var priorJSON sql.NullString
	err := b.db.QueryRowContext(ctx, `SELECT state,transport_json FROM valve_schedule_pushes WHERE UPPER(device_eui)=?
		AND purpose='CLOCK_SYNC' ORDER BY rowid DESC LIMIT 1`, jsvalue.Upper(eui)).Scan(&previous, &priorJSON)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && previous != "ACKED" && previous != "SUPERSEDED" && previous != "FAILED" {
		prior, _ := valveStoredJSON(priorJSON.String)
		if previous == "QUEUED" || prior.Get("phase").Truthy() {
			return nil
		}
	}
	port, frame := uint32(13), []byte{1}
	if generation != "GEN2" {
		port, frame = 12, valveClockFrame(now.In(loc))
	}
	id := uuid.NewString()
	device, valid := normalizeValveDispatchEUI(eui)
	if !valid {
		err := b.insertClockPush(ctx, id, eui, port, frame, nil)
		return errors.Join(err, errInvalidValveEUI)
	}
	radio, err := openValveRadioLazy()
	if err != nil {
		return err
	}
	defer radio.conn.Close()
	transport := jsvalue.Obj()
	valveAttemptAt(&transport, time.Now(), false)
	if err := b.insertClockPush(ctx, id, eui, port, frame, valveJSON(transport)); err != nil {
		return err
	}
	phase, _, rpcErr := radio.enqueueValveFrame(ctx, device, port, frame, &transport)
	_, err = b.db.ExecContext(ctx, "UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?", valveJSON(transport), id)
	if err != nil {
		return errors.Join(rpcErr, err)
	}
	if phase != "ACCEPTED" {
		// runClockTick records a transport failure (warn, transportFailures)
		// and goes on with the next valve; the flow node logs it.
		log.Printf("valve clock %s: transport result %s: %v", eui, phase, rpcErr)
		return nil
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO valve_settings(device_eui,last_clock_sync_queued_at) VALUES (?,?)
		ON CONFLICT(device_eui) DO UPDATE SET last_clock_sync_queued_at=excluded.last_clock_sync_queued_at,
		updated_at=datetime('now')`, eui, valveISO(now))
	return err
}

// insertClockPush is push.js queuePushes for the clock tick: one transaction
// marks every QUEUED CLOCK_SYNC row of the valve SUPERSEDED
// (store.supersedeOutstanding) and inserts the new row, before any dispatch
// check, so a key the dispatcher then refuses gets the same two writes.
func (b *backend) insertClockPush(ctx context.Context, id, eui string, port uint32, frame []byte, transport any) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE valve_schedule_pushes SET state='SUPERSEDED'
		WHERE UPPER(device_eui)=UPPER(?) AND state='QUEUED' AND purpose IN ('CLOCK_SYNC')`, jsvalue.Upper(eui)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO valve_schedule_pushes(push_id,device_eui,purpose,fport,payload_hex,transport_json)
		VALUES (?,?,'CLOCK_SYNC',?,?,?)`, id, eui, port, jsvalue.Upper(hex.EncodeToString(frame)), transport); err != nil {
		return err
	}
	return tx.Commit()
}

func valveClockFrame(local time.Time) []byte {
	digits := fmt.Sprintf("%02d%02d%02d%02d%02d%02d%02d", local.Hour(), local.Minute(), local.Second(),
		local.Weekday(), local.Day(), local.Month(), local.Year()%100)
	frame := make([]byte, len(digits))
	for i := range digits {
		frame[i] = digits[i] - '0'
	}
	return frame
}
