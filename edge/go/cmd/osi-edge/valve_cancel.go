package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"slices"
	"time"
	"unicode/utf16"

	"github.com/chirpstack/chirpstack/api/go/v4/api"

	"osi-edge/internal/jsvalue"
)

type valveCancelQueue struct {
	items  []*api.DeviceQueueItem
	target string
}

func (b *backend) selectValveCancel(ctx context.Context, eui string, active []cancellableValve, id string) (cancellableValve, valveCancelQueue, string, error) {
	if id != "" {
		for _, candidate := range active {
			if candidate.id == id {
				return candidate, valveCancelQueue{}, "", nil
			}
		}
		var found string
		err := b.db.QueryRowContext(ctx, "SELECT expectation_id FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=?", id, eui).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			err = nil
		}
		return cancellableValve{id: found}, valveCancelQueue{}, "", err
	}
	switch len(active) {
	case 0:
		return cancellableValve{}, valveCancelQueue{}, "", nil
	case 1:
		return active[0], valveCancelQueue{}, "", nil
	}
	for _, candidate := range active {
		if candidate.conditional {
			return cancellableValve{}, valveCancelQueue{}, "conditional_irrigation", nil
		}
	}
	radio, err := openValveRadio()
	if err != nil {
		return cancellableValve{}, valveCancelQueue{}, "queue_unreadable", nil
	}
	defer radio.conn.Close()
	items, err := radio.readValveQueue(ctx, eui)
	if err != nil {
		return cancellableValve{}, valveCancelQueue{}, "queue_unreadable", nil
	}
	var target cancellableValve
	for _, candidate := range active {
		if candidate.queueID == "" || !slices.ContainsFunc(items, func(item *api.DeviceQueueItem) bool {
			return !item.GetIsPending() && item.GetId() == candidate.queueID
		}) {
			continue
		}
		if target.id != "" {
			return cancellableValve{}, valveCancelQueue{}, "several_queued", nil
		}
		target = candidate
	}
	if target.id == "" {
		return target, valveCancelQueue{}, "none_queued", nil
	}
	return target, valveCancelQueue{items: items, target: target.queueID}, "", nil
}

func (radio *valveRadio) readValveQueue(ctx context.Context, eui string) ([]*api.DeviceQueueItem, error) {
	callCtx, stop := radio.request(ctx)
	defer stop()
	reply, err := radio.GetQueue(callCtx, &api.GetDeviceQueueItemsRequest{DevEui: eui})
	if err != nil {
		return nil, err
	}
	if reply.GetResult() == nil {
		return []*api.DeviceQueueItem{}, nil
	}
	return reply.GetResult(), nil
}

func (radio *valveRadio) flushValveQueue(ctx context.Context, eui string) error {
	callCtx, stop := radio.request(ctx)
	defer stop()
	_, err := radio.FlushQueue(callCtx, &api.FlushDeviceQueueRequest{DevEui: eui})
	return err
}

func valveOpenSignature(item *api.DeviceQueueItem) string {
	if item.GetFPort() != 2 || item.GetIsPending() || item.GetIsEncrypted() {
		return ""
	}
	return string(item.GetData())
}

func valveIsQueuedOpen(item *api.DeviceQueueItem) bool {
	signature := valveOpenSignature(item)
	return len(signature) > 0 && (signature[0] == 0x21 || signature[0] == 0x41 || signature[0] == 0x81)
}

func valveIsUnboundedQueueItem(item *api.DeviceQueueItem) bool {
	data := item.GetData()
	return !item.GetIsPending() && !item.GetIsEncrypted() &&
		(item.GetFPort() == 28 || item.GetFPort() == 27 && len(data) > 0 && data[0] == 0x31)
}

func valveOpenSignatures(seconds int) []string {
	var signatures []string
	if seconds > 0 {
		signatures = append(signatures, string([]byte{0x41, byte(min(255, (seconds+59)/60))}))
	}
	for _, encoding := range []struct {
		opcode byte
		factor int
	}{{0x21, 1}, {0x81, 3600}} {
		if seconds > 0 && seconds%encoding.factor == 0 && seconds/encoding.factor <= 255 {
			signatures = append(signatures, string([]byte{encoding.opcode, byte(seconds / encoding.factor)}))
		}
	}
	return signatures
}

func valveQueuedOpenIndex(items []*api.DeviceQueueItem, target cancellableValve, active []cancellableValve) int {
	signatures := valveOpenSignatures(target.seconds)
	// Both rows and frames are FIFO. The newest k matching owners still
	// account for the k matching queued items.
	newer := 0
	for _, row := range active {
		if row.id == target.id {
			break
		}
		if slices.ContainsFunc(valveOpenSignatures(row.seconds), func(signature string) bool {
			return slices.Contains(signatures, signature)
		}) {
			newer++
		}
	}
	for i := len(items) - 1; i >= 0; i-- {
		if slices.Contains(signatures, valveOpenSignature(items[i])) {
			if newer == 0 {
				return i
			}
			newer--
		}
	}
	return -1
}

func droppedValveOpens(items []*api.DeviceQueueItem, active []cancellableValve, target cancellableValve, skip int) jsvalue.Value {
	owners := make(map[string][]string)
	for _, row := range active {
		for _, signature := range valveOpenSignatures(row.seconds) {
			owners[signature] = append(owners[signature], row.id)
		}
	}
	var ids []jsvalue.Value
	count := 0
	for index := len(items) - 1; index >= 0; index-- {
		item := items[index]
		switch {
		case valveIsUnboundedQueueItem(item) && index != skip:
			count++
		case valveIsQueuedOpen(item):
			signature := valveOpenSignature(item)
			var owner string
			if matches := owners[signature]; len(matches) > 0 {
				owner, owners[signature] = matches[0], matches[1:]
			}
			if index != skip && owner != target.id {
				count++
				if owner != "" {
					ids = append(ids, jsvalue.Str(owner))
				}
			}
		}
	}
	slices.Reverse(ids)
	return jsvalue.Obj(jsvalue.Property("count", jsvalue.Num(float64(count))), jsvalue.Property("expectationIds", jsvalue.Arr(ids...)))
}

func (b *backend) cancelSelectedValve(w http.ResponseWriter, ctx context.Context, eui string, target cancellableValve, active []cancellableValve, queue valveCancelQueue, reason string) {
	at := time.Now()
	reasonUnits := utf16.Encode([]rune(reason))
	if len(reasonUnits) > 255 {
		reason = string(utf16.Decode(reasonUnits[:255-12])) + "…[truncated]"
	}
	fail := func(err error) {
		log.Printf("cancel valve %s: %v", eui, err)
		message := "Unable to cancel STREGA actuation"
		if errors.Is(err, errInvalidValveEUI) {
			// cancel-ingress answers a throw with its message: flushValveQueue's
			// normalizeDevice refuses before the flush intent is written.
			message = invalidValveEUIMessage
		}
		sendJSON(w, 500, jsvalue.Obj(jsvalue.Property("message", jsvalue.Str(message))))
	}
	if target.conditional {
		if err := b.cancelConditionalValve(w, ctx, eui, target, reason, at); err != nil {
			fail(err)
		}
		return
	}
	radio, err := openValveRadio()
	if err != nil {
		fail(err)
		return
	}
	defer radio.conn.Close()
	known := queue.items != nil
	if !known {
		queue.items, err = radio.readValveQueue(ctx, eui)
		known = err == nil
	}
	index := valveQueuedOpenIndex(queue.items, target, active)
	if queue.target != "" {
		index = slices.IndexFunc(queue.items, func(item *api.DeviceQueueItem) bool { return item.GetId() == queue.target })
	}
	scope, dropped := "not_queued", droppedValveOpens(nil, nil, target, -1)
	openCount := 0
	for _, item := range queue.items {
		if valveIsQueuedOpen(item) {
			openCount++
		}
	}
	switch {
	case !known:
		scope, dropped = "full_flush", jsvalue.Nil()
	case index >= 0:
		scope, dropped = "target_only", droppedValveOpens(queue.items, active, target, index)
	case len(valveOpenSignatures(target.seconds)) == 0 || openCount > len(active):
		scope, dropped = "full_flush", droppedValveOpens(queue.items, active, target, -1)
	}
	if scope != "not_queued" {
		if err := radio.flushValveQueue(ctx, eui); err != nil {
			fail(err)
			return
		}
	}
	if scope == "target_only" {
		for i, item := range queue.items {
			if i == index || item.GetIsPending() || item.GetIsEncrypted() || valveIsQueuedOpen(item) || valveIsUnboundedQueueItem(item) {
				continue
			}
			callCtx, stop := radio.request(ctx)
			reply, err := radio.Enqueue(callCtx, &api.EnqueueDeviceQueueItemRequest{
				QueueItem: &api.DeviceQueueItem{DevEui: eui, FPort: item.GetFPort(), Data: item.GetData(), Confirmed: item.GetConfirmed()},
			})
			stop()
			if err != nil || !valveQueueID.MatchString(jsvalue.Trim(reply.GetId())) {
				log.Printf("cancel valve %s: queue item restore was not confirmed: %v", eui, err)
			}
		}
	}
	if err := b.markValveCancelled(ctx, eui, target.id, reason, valveISO(at), scope == "full_flush", jsvalue.Value{}); err != nil {
		fail(err)
		return
	}
	b.emitValveCancelEvents(ctx, eui, target.id)
	writeValveCancelSuccess(w, eui, target, reason, valveISO(at), scope, dropped, jsvalue.Nil())
}

func writeValveCancelSuccess(w http.ResponseWriter, eui string, target cancellableValve, reason, at, scope string, dropped, collateral jsvalue.Value) {
	var queueStatus jsvalue.Value
	if scope == "not_queued" {
		queueStatus = jsvalue.Nil()
	}
	sendJSON(w, 200, jsvalue.Obj(
		jsvalue.Property("status", jsvalue.Str("cancelled")),
		jsvalue.Property("outcome", jsvalue.Str("cancelled")),
		jsvalue.Property("confirmation", jsvalue.Str("queue_flushed")),
		jsvalue.Property("deveui", jsvalue.Str(eui)),
		jsvalue.Property("cancelled", jsvalue.Num(1)),
		jsvalue.Property("expectation_id", jsvalue.Str(target.id)),
		jsvalue.Property("previous_state", jsvalue.Str(target.state)),
		jsvalue.Property("reason", jsvalue.Str(reason)),
		jsvalue.Property("chirpstack_queue_status", queueStatus),
		jsvalue.Property("queue_scope", jsvalue.Str(scope)),
		jsvalue.Property("dropped_opens", dropped),
		jsvalue.Property("collateral", collateral),
		jsvalue.Property("transport_uncertain", jsvalue.Bool(false)),
		jsvalue.Property("timestamp", jsvalue.Str(at)),
	))
}

func (b *backend) markValveCancelled(ctx context.Context, eui, id, reason, at string, fullFlush bool, transport jsvalue.Value) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if fullFlush {
		if err := markFlushedValvePushes(ctx, tx, eui); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE valve_actuation_expectations SET reconciliation_state='CANCELLED', cancel_reason=?
		WHERE expectation_id=? AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')`, reason, id)
	if err != nil {
		return err
	}
	if transport.Kind == jsvalue.Object {
		if _, err := tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
			valveJSON(transport), id); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE devices SET target_state='CLOSED', updated_at=?,
		sync_version=CASE WHEN target_state='OPEN' THEN COALESCE(sync_version,0)+1 ELSE sync_version END
		WHERE UPPER(deveui)=? AND NOT EXISTS (SELECT 1 FROM valve_actuation_expectations
		WHERE UPPER(device_eui)=? AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING'))`, at, eui, eui)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func markFlushedValvePushes(ctx context.Context, tx *farmTx, eui string) error {
	// The shared valve writer fences this flush from the clock tick. A
	// debounced plan and an unattempted lifecycle clear were never on air.
	_, err := tx.ExecContext(ctx, `UPDATE valve_schedule_pushes SET state='FAILED',error='not_resent_q02c'
		WHERE UPPER(device_eui)=? AND state='QUEUED' AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS')
		AND NOT (COALESCE(json_extract(CASE WHEN json_valid(transport_json) THEN transport_json END,'$.lifecycle_clear_revision'),'')<>''
		  AND json_extract(CASE WHEN json_valid(transport_json) THEN transport_json END,'$.phase') IS NULL)
		AND NOT EXISTS (SELECT 1 FROM app_settings, json_each(CASE WHEN json_valid(app_settings.value) THEN app_settings.value END,'$.push_ids')
		  WHERE app_settings.key=? AND json_each.value=push_id)`, eui, "valve_snapshot_pending:"+eui)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE valve_schedule_pushes SET state='SUPERSEDED'
		WHERE UPPER(device_eui)=? AND purpose='CLOCK_SYNC' AND state='QUEUED'`, eui)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO valve_settings(device_eui,last_clock_sync_queued_at) VALUES (?,NULL)
		ON CONFLICT(device_eui) DO UPDATE SET last_clock_sync_queued_at=NULL,updated_at=datetime('now')`, eui)
	return err
}
