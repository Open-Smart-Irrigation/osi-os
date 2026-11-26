package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/chirpstack/chirpstack/api/go/v4/api"

	"osi-edge/internal/jsvalue"
)

const valveCancelHelp = "Cancel deletes the pending command. It does not close a valve that is already open."

func (b *backend) cancelConditionalValve(w http.ResponseWriter, ctx context.Context, eui string, target cancellableValve, reason string, now time.Time) error {
	p := jsvalue.Property
	empty := jsvalue.Arr()
	outcome := "handed_off"
	lead := "The open may already have been sent to the valve, so it was not cancelled. "
	replyConflict := func(scope string, collateral, dropped jsvalue.Value) {
		sendJSON(w, 409, jsvalue.Obj(p("message", jsvalue.Str(lead+valveCancelHelp)),
			p("error", jsvalue.Str("actuation_handed_off")), p("outcome", jsvalue.Str(outcome)),
			p("expectation_id", jsvalue.Str(target.id)), p("queue_scope", jsvalue.Str(scope)),
			p("collateral", collateral), p("dropped_opens", dropped)))
	}
	if target.state == "OBSERVED_RUNNING" {
		outcome = "already_running"
		lead = "The valve is already open: there is no pending command to delete. "
		replyConflict("not_queued", empty, droppedValveOpens(nil, nil, target, -1))
		return nil
	}
	before, parseErr := valveStoredJSON(target.transport.String)
	phase := before.Get("phase").OrEmpty().MustString()
	if before.Get("invalidated_by_flush").Truthy() && before.Get("first_invalidated_by_flush").Truthy() {
		replyConflict("not_queued", empty, droppedValveOpens(nil, nil, target, -1))
		return nil
	}
	stamp := valveISO(now)
	local := phase == "" && !before.Get("attempted_at").Truthy() && !before.Get("attempt_receipt").Truthy() ||
		phase == "INTENT" && !before.Get("attempted_at").Truthy()
	if parseErr == nil && target.transport.String != "" &&
		(local || phase == "enqueue_failed_before_acceptance" || phase == "enqueue_rejected") {
		if local {
			before.Set(p("phase", jsvalue.Str("enqueue_failed_before_acceptance")))
			before.Set(p("cancelled_before_send_at", jsvalue.Str(stamp)))
		} else {
			before.Set(p("cancelled_unsent_at", jsvalue.Str(stamp)))
		}
		if err := b.markValveCancelled(ctx, eui, target.id, reason, stamp, false, before); err != nil {
			return err
		}
		b.emitValveCancelEvents(ctx, eui, target.id)
		writeValveCancelSuccess(w, eui, target, reason, stamp, "not_queued", droppedValveOpens(nil, nil, target, -1), empty)
		return nil
	}

	if parseErr == nil && target.transport.String != "" {
		flush := target.queueID != "" && (phase == "ACCEPTED" || phase == "UNKNOWN")
		if target.queueID == "" && (phase == "ATTEMPTED" || phase == "UNKNOWN") {
			flush = pendingConditionalValveFrame(ctx, eui, before.Get("effect_snapshot"))
		}
		if !flush {
			replyConflict("not_queued", empty, droppedValveOpens(nil, nil, target, -1))
			return nil
		}
	}
	flush, err := b.flushPlanQueue(ctx, eui, "cancel", now)
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
	if flush.ok {
		if err := markFlushedValvePushes(ctx, tx, eui); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	b.emitValveCancelEvents(ctx, eui, "")
	collateral, dropped, err := b.valveCancelCollateral(ctx, eui, target.id, flush.intent)
	if err != nil {
		return err
	}
	if !flush.ok {
		details := flush.failureWire()
		sendJSON(w, 503, jsvalue.Obj(p("message", jsvalue.Str("Cancellation transport outcome is uncertain")),
			p("error", jsvalue.Str("transport_uncertain")), p("outcome", jsvalue.Str("uncertain")),
			p("uncertainty", details), p("expectation_id", jsvalue.Str(target.id)), p("collateral", collateral)))
		return nil
	}
	replyConflict("full_flush", collateral, dropped)
	return nil
}

func pendingConditionalValveFrame(ctx context.Context, eui string, frame jsvalue.Value) bool {
	radio, err := openValveRadio()
	if err != nil {
		return false
	}
	defer radio.conn.Close()
	items, err := radio.readValveQueue(ctx, eui)
	if err != nil {
		return false
	}
	return slices.ContainsFunc(items, func(item *api.DeviceQueueItem) bool {
		return valveIsQueuedOpen(item) || valveIsUnboundedQueueItem(item) ||
			(frame.Truthy() && !item.GetIsPending() && float64(item.GetFPort()) == frame.Get("fPort").MustNumber() &&
				jsvalue.Upper(hex.EncodeToString(item.GetData())) == jsvalue.Upper(frame.Get("bytes_hex").OrEmpty().MustString()))
	})
}

func (b *backend) valveCancelCollateral(ctx context.Context, eui, target string, intent jsvalue.Value) (jsvalue.Value, jsvalue.Value, error) {
	p := jsvalue.Property
	var owners, dropped []jsvalue.Value
	snapshot := intent.Get("captured_snapshot")
	control, err := loadValveControl(ctx, b.db, eui)
	if err != nil {
		return jsvalue.Value{}, jsvalue.Value{}, err
	}
	for _, owner := range intent.Get("owners").List {
		id, kind, queue := owner.Get("id"), owner.Get("type"), owner.Get("queue_id")
		if kind.MustString() == "expectation" && id.MustString() == target {
			continue
		}
		entry := jsvalue.Obj(p("owner_type", kind), p("owner_id", id))
		inQueue := jsvalue.Nil()
		if queue.Truthy() && snapshot.Kind == jsvalue.Array {
			inQueue = jsvalue.Bool(slices.ContainsFunc(snapshot.List, func(item jsvalue.Value) bool {
				return item.Get("id").MustString() == queue.MustString() && !item.Get("isPending").Truthy()
			}))
		}
		switch kind.MustString() {
		case "expectation":
			entry.Set(p("expectation_id", id))
			dropped = append(dropped, id)
		case "push":
			var purpose sql.NullString
			var weekday sql.NullInt64
			err := b.db.QueryRowContext(ctx, "SELECT purpose,weekday FROM valve_schedule_pushes WHERE push_id=? AND UPPER(device_eui)=?",
				id.MustString(), eui).Scan(&purpose, &weekday)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return jsvalue.Value{}, jsvalue.Value{}, err
			}
			entry.Set(p("purpose", nullableText(purpose)))
			entry.Set(p("weekday", valveInt(weekday)))
		case "opaque":
			port := jsvalue.Nil()
			for _, item := range control.Get("opaque").List {
				if item.Get("owner_id").MustString() == id.MustString() || item.Get("queue_id").MustString() == id.MustString() {
					port = zoneFallback(item.Get("fPort"), zoneFallback(item.Get("fport"), jsvalue.Nil()))
					break
				}
			}
			entry.Set(p("fport", port))
		}
		entry.Set(p("queue_id", queue))
		entry.Set(p("phase_before", owner.Get("phase")))
		entry.Set(p("in_queue", inQueue))
		owners = append(owners, entry)
	}
	return jsvalue.Arr(owners...), jsvalue.Obj(p("count", jsvalue.Num(float64(len(dropped)))), p("expectationIds", jsvalue.Arr(dropped...))), nil
}
