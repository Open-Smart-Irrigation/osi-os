package main

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"osi-edge/internal/jsvalue"
)

// nextValveRun is plan.js nextRun: each schedule uses s.timezone ||
// timeZoneFallback || 'UTC', with the stored values' classes kept.
func (b *backend) nextValveRun(ctx context.Context, eui string, fallback storedValue, now time.Time) (jsvalue.Value, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT schedule_uuid,kind,start_time,weekdays_mask,fire_at,once_state,timezone,duration_minutes
		FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL AND enabled<>0
		AND (condition_policy_uuid IS NULL OR condition_policy_uuid='') ORDER BY kind,start_time,fire_at`, eui)
	if err != nil {
		return jsvalue.Nil(), err
	}
	defer rows.Close()
	var best time.Time
	next := jsvalue.Nil()
	now = now.Truncate(time.Millisecond)
	for rows.Next() {
		var id, kind string
		var start, fire, state sql.NullString
		var zone storedValue
		var weekdaysRaw any
		var minutes float64
		if err := rows.Scan(&id, &kind, &start, &weekdaysRaw, &fire, &state, &zone, &minutes); err != nil {
			return jsvalue.Nil(), err
		}
		var at time.Time
		switch kind {
		case "ONCE":
			if state.String == "PENDING" {
				at = valveInstant(fire.String)
			}
		case "WEEKLY":
			if minute, valid := planStart(start.String); valid {
				loc := timezoneChain(zone, fallback).location()
				at = nextWeeklyValveRun(now, loc, jsMaskInt32(weekdaysRaw), minute/60, minute%60)
			}
		}
		if !at.IsZero() && !at.Before(now) && (best.IsZero() || at.Before(best)) {
			best = at
			next = jsvalue.Obj(
				jsvalue.Property("at", jsvalue.Str(valveISO(at))),
				jsvalue.Property("kind", jsvalue.Str(kind)),
				jsvalue.Property("minutes", jsvalue.Num(minutes)),
				jsvalue.Property("scheduleUuid", jsvalue.Str(id)),
			)
		}
	}
	return next, rows.Err()
}

func nextWeeklyValveRun(now time.Time, loc *time.Location, mask int64, hour, minute int) time.Time {
	year, month, day := now.In(loc).Date()
	dayUTC := time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 8; i++ {
		day := dayUTC.AddDate(0, 0, i)
		if mask&(1<<day.Weekday()) == 0 {
			continue
		}
		at := valveLocalInstant(day, loc, hour, minute)
		if !at.Before(now) {
			return at
		}
	}
	return time.Time{}
}

func valveLocalInstant(day time.Time, loc *time.Location, hour, minute int) time.Time {
	wall := day.Add(time.Duration(hour*60+minute) * time.Minute)
	_, noonOffset := day.Add(12 * time.Hour).In(loc).Zone()
	first := wall.Add(-time.Duration(noonOffset) * time.Second)
	roundTrips := func(instant time.Time) bool {
		local := instant.In(loc)
		return local.Day() == day.Day() && local.Hour() == hour && local.Minute() == minute
	}
	if roundTrips(first) {
		return first
	}
	_, alternateOffset := first.In(loc).Zone()
	second := wall.Add(-time.Duration(alternateOffset) * time.Second)
	if roundTrips(second) {
		return second
	}
	probe := first
	if second.Before(first) {
		probe = second
	}
	for i := 0; i < 120; i++ {
		local := probe.In(loc)
		sameDay := local.Year() == day.Year() && local.Month() == day.Month() && local.Day() == day.Day()
		localDay := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
		if sameDay && local.Hour()*60+local.Minute() >= hour*60+minute || localDay.After(day) {
			break
		}
		probe = probe.Add(time.Minute)
	}
	return probe
}

func valvePushLost(state, reason string) bool {
	return state == "FAILED" && (reason == "stale_unconfirmed" || reason == "not_resent_q02c")
}

// valvePushLostStored is store.js isLostRow on a scanned error column:
// LOST_REASONS.includes(r.error) is strict, so only a TEXT reason matches
// (a BLOB is a Buffer, never equal to a string).
func valvePushLostStored(state string, reason storedValue) bool {
	text, ok := reason.text()
	return ok && valvePushLost(state, text)
}

func valvePushSummary(ctx context.Context, db scheduleQueryer, eui string, now time.Time) (jsvalue.Value, error) {
	at := valveISO(now)
	rows, err := db.QueryContext(ctx, `SELECT purpose,weekday,payload_hex,state,error,queued_at>datetime(?,'-30 day')
		FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN')
		AND state IN ('QUEUED','ACKED','FAILED') ORDER BY rowid DESC`, at, eui)
	if err != nil {
		return jsvalue.Nil(), err
	}
	defer rows.Close()
	var queued, acked, failed, lost int
	seen := make(map[string]bool)
	for rows.Next() {
		var purpose, payload, state string
		var weekday sql.NullInt64
		var reason storedValue
		var recent bool
		if err := rows.Scan(&purpose, &weekday, &payload, &state, &reason, &recent); err != nil {
			return jsvalue.Nil(), err
		}
		var slots []string
		if purpose == "WEEKDAY_PLAN" {
			slot := "null"
			if weekday.Valid {
				slot = strconv.FormatInt(weekday.Int64, 10)
			}
			slots = append(slots, "weekday:"+slot)
		} else {
			mask, _ := strconv.ParseUint(payload[:min(2, len(payload))], 16, 8)
			if mask == 0x80 {
				mask = 0x7f
			}
			for day := 0; day < 7; day++ {
				if mask&(1<<day) != 0 {
					slots = append(slots, "daymask:"+strconv.Itoa(day))
				}
			}
		}
		for _, slot := range slots {
			if seen[slot] {
				continue
			}
			seen[slot] = true
			switch {
			case valvePushLostStored(state, reason):
				failed++
				lost++
			case !recent:
			case state == "QUEUED":
				queued++
			case state == "ACKED":
				acked++
			case state == "FAILED":
				failed++
			}
		}
	}
	if err := rows.Err(); err != nil {
		return jsvalue.Nil(), err
	}
	var lastQueued, lastACK sql.NullString
	err = db.QueryRowContext(ctx, `SELECT
		MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') THEN queued_at END),
		MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state='ACKED' THEN acked_at END)
		FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND queued_at>datetime(?,'-30 day')`, eui, at).
		Scan(&lastQueued, &lastACK)
	if err != nil {
		return jsvalue.Nil(), err
	}
	var state string
	var reason storedValue
	err = db.QueryRowContext(ctx, `SELECT state,error FROM valve_schedule_pushes
		WHERE UPPER(device_eui)=UPPER(?) AND purpose='SCHEDULER_STATUS' AND state IN ('QUEUED','ACKED','FAILED')
		ORDER BY rowid DESC LIMIT 1`, eui).Scan(&state, &reason)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return jsvalue.Nil(), err
	}
	return jsvalue.Obj(
		jsvalue.Property("queued", jsvalue.Num(float64(queued))),
		jsvalue.Property("acked", jsvalue.Num(float64(acked))),
		jsvalue.Property("failed", jsvalue.Num(float64(failed))),
		jsvalue.Property("lost", jsvalue.Num(float64(lost))),
		jsvalue.Property("scheduler_status_lost", jsvalue.Bool(valvePushLostStored(state, reason))),
		jsvalue.Property("last_plan_queued_at", valveText(lastQueued)),
		jsvalue.Property("last_plan_acked_at", valveText(lastACK)),
	), nil
}

// jsMaskInt32 is ToInt32(Number(value)), as plan.js applies `>> d` to a
// stored weekdays_mask: a restored REAL or TEXT mask still yields a bitmask.
func jsMaskInt32(value any) int64 {
	v := zoneSQLValue(value)
	if blob, ok := value.([]byte); ok {
		v = jsvalue.Str(string(blob))
	}
	return int64(v.MustInt32())
}
