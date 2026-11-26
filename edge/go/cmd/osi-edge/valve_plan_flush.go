package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"slices"
	"time"

	"github.com/chirpstack/chirpstack/api/go/v4/api"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"osi-edge/internal/jsvalue"
)

type planFlushResult struct {
	id             string
	ok, attempted  bool
	replayed       bool
	problem        error
	wireError      jsvalue.Value
	invalidatedIDs []jsvalue.Value
	intent         jsvalue.Value
}

func (f planFlushResult) failure() error {
	if f.ok || f.id == "" {
		return nil
	}
	return &scheduleError{status: 503, code: "transport_uncertain",
		message: "Valve transport did not confirm the write", details: f.failureWire()}
}

func (f planFlushResult) failureWire() jsvalue.Value {
	p := jsvalue.Property
	details := jsvalue.Obj(p("ok", jsvalue.Bool(false)), p("phase", jsvalue.Str("UNKNOWN")), p("flush_id", jsvalue.Str(f.id)))
	if f.problem != nil {
		details.Set(p("error", zoneFallback(f.wireError, jsvalue.Obj())))
	} else if f.replayed {
		details.Set(p("snapshot", zoneFallback(f.intent.Get("captured_snapshot"), jsvalue.Nil())))
	}
	if f.attempted || (f.replayed && f.problem == nil) {
		details.Set(p("invalidated_queue_ids", jsvalue.Arr(f.invalidatedIDs...)))
		details.Set(p("replayed", jsvalue.Bool(f.replayed)))
	} else if f.replayed {
		details.Set(p("replayed", jsvalue.Bool(true)))
	}
	return details
}

// ChirpStack's Node adapter retains the RPC details and trailers on the
// enumerable error object it exposes in transport failures.
func planQueueRPCError(err error, step string, header, trailer metadata.MD) (error, jsvalue.Value) {
	if errors.Is(err, errValveTransportUnavailable) {
		// lazyTransport's rejection serialises as its one enumerable field.
		return err, jsvalue.Obj(jsvalue.Property("code", jsvalue.Str("transport_unavailable")))
	}
	st, ok := status.FromError(err)
	if err == nil || !ok {
		return err, jsvalue.Value{}
	}
	p := jsvalue.Property
	meta := jsvalue.Obj()
	keys := make([]string, 0, len(header)+len(trailer))
	for key := range metadata.Join(header, trailer) {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	if len(trailer) > 0 && len(header) == 0 {
		meta.Set(p("content-type", jsvalue.Arr(jsvalue.Str("application/grpc+proto"))))
	}
	for _, key := range keys {
		var values []jsvalue.Value
		for _, value := range append(slices.Clone(header.Get(key)), trailer.Get(key)...) {
			values = append(values, jsvalue.Str(value))
		}
		meta.Set(p(key, jsvalue.Arr(values...)))
	}
	code, details := jsvalue.Num(float64(st.Code())), jsvalue.Str(st.Message())
	name := "UNKNOWN"
	if n := st.Code(); n < codes.Code(len(deviceRPCStatusNames)) && deviceRPCStatusNames[n] != "" {
		name = deviceRPCStatusNames[n]
	}
	raw := jsvalue.Obj(p("code", code), p("details", details), p("metadata", meta))
	return errors.New(st.Message()), jsvalue.Obj(p("step", jsvalue.Str(step)), p("code", code),
		p("grpcStatus", jsvalue.Str(name)), p("details", details), p("raw", raw))
}

type planQueueOwner struct {
	kind, id string
	state    jsvalue.Value
	row      jsvalue.Value
}

func (owner planQueueOwner) wire(eui string) jsvalue.Value {
	p := jsvalue.Property
	result := jsvalue.Obj(p("type", jsvalue.Str(owner.kind)), p("id", jsvalue.Str(owner.id)))
	if owner.kind == "opaque" {
		result.Set(p("device_eui", jsvalue.Str(eui)))
	}
	result.Set(p("queue_id", zoneFallback(owner.state.Get("queue_id"), jsvalue.Nil())))
	result.Set(p("phase", zoneFallback(owner.state.Get("phase"), jsvalue.Nil())))
	return result
}

func (b *backend) flushPlanQueue(ctx context.Context, eui, reason string, now time.Time) (planFlushResult, error) {
	return b.executePlanFlush(ctx, eui, reason, jsvalue.Value{}, now)
}

func (b *backend) executePlanFlush(ctx context.Context, eui, reason string, saved jsvalue.Value, now time.Time) (planFlushResult, error) {
	if _, valid := normalizeValveDispatchEUI(eui); !valid {
		return planFlushResult{}, errInvalidValveEUI
	}
	p := jsvalue.Property
	at := jsvalue.Str(valveISO(now))
	control, err := loadValveControl(ctx, b.db, eui)
	if err != nil {
		return planFlushResult{}, err
	}
	result := planFlushResult{intent: saved, replayed: saved.Kind == jsvalue.Object}
	var owners []planQueueOwner
	if result.replayed {
		result.id = saved.Get("flush_id").MustString()
		if planFlushComplete(saved) {
			result.ok = true
			return result, nil
		}
		if attempt := saved.Get("attempt_status").OrEmpty().MustString(); attempt != "" && attempt != "NOT_STARTED" {
			return b.finishPlanFlush(ctx, eui, control, result, now)
		}
	} else {
		result.id = uuid.NewString()
		owners, err = b.planQueueOwners(ctx, eui, &control)
		if err != nil {
			return result, err
		}
		result.intent = jsvalue.Obj(p("flush_id", jsvalue.Str(result.id)), p("reason", jsvalue.Str(reason)),
			p("started_at", at), p("status", jsvalue.Str("PENDING")), p("capture_status", jsvalue.Str("PENDING")),
			p("attempt_status", jsvalue.Str("NOT_STARTED")), p("result_status", jsvalue.Str("PENDING")), p("owners", planQueueOwnerValues(eui, owners)))
		if err := b.savePlanFlush(ctx, eui, &control, result.intent); err != nil {
			return result, err
		}
	}

	radio, openErr := openValveRadioLazy()
	if openErr == nil {
		defer radio.conn.Close()
	}
	if result.intent.Get("capture_status").MustString() != "COMPLETE" {
		if result.replayed {
			owners, err = b.planQueueOwners(ctx, eui, &control)
			if err != nil {
				return result, err
			}
		}
		if err := b.capturePlanFlush(ctx, eui, radio, openErr, &control, &result, owners); err != nil || result.problem != nil {
			return result, err
		}
	}
	if openErr != nil {
		return result, openErr
	}

	result.intent.Set(p("attempt_status", jsvalue.Str("STARTED")))
	result.intent.Set(p("attempt_started_at", at))
	if err := b.savePlanFlush(ctx, eui, &control, result.intent); err != nil {
		return result, err
	}

	callCtx, stop := radio.request(ctx)
	var header, trailer metadata.MD
	_, rpcErr := radio.FlushQueue(callCtx, &api.FlushDeviceQueueRequest{DevEui: eui}, grpc.Header(&header), grpc.Trailer(&trailer))
	stop()
	result.attempted = true
	result.ok = rpcErr == nil
	result.problem, result.wireError = planQueueRPCError(rpcErr, "flushDeviceQueue", header, trailer)
	return b.finishPlanFlush(ctx, eui, control, result, now)
}

func planFlushComplete(intent jsvalue.Value) bool {
	return intent.Get("status").MustString() == "COMPLETE" || intent.Get("result_status").MustString() == "COMPLETE"
}

func planQueueOwnerValues(eui string, owners []planQueueOwner) jsvalue.Value {
	values := make([]jsvalue.Value, 0, len(owners))
	for _, owner := range owners {
		values = append(values, owner.wire(eui))
	}
	return jsvalue.Arr(values...)
}

func (b *backend) capturePlanFlush(ctx context.Context, eui string, radio *valveRadio, readErr error, control *jsvalue.Value, result *planFlushResult, owners []planQueueOwner) error {
	p := jsvalue.Property
	intent := &result.intent
	readStarted := valveISO(time.Now())
	var items []*api.DeviceQueueItem
	if readErr == nil {
		callCtx, stop := radio.request(ctx)
		var header, trailer metadata.MD
		reply, err := radio.GetQueue(callCtx, &api.GetDeviceQueueItemsRequest{DevEui: eui}, grpc.Header(&header), grpc.Trailer(&trailer))
		stop()
		items = reply.GetResult()
		readErr, result.wireError = planQueueRPCError(err, "getDeviceQueue", header, trailer)
	}
	readCompleted := valveISO(time.Now())
	if readErr != nil {
		result.problem = readErr
		intent.Set(p("status", jsvalue.Str("UNKNOWN")))
		intent.Set(p("capture_status", jsvalue.Str("UNKNOWN")))
		intent.Set(p("result_status", jsvalue.Str("UNKNOWN")))
		intent.Set(p("error", jsvalue.Str(readErr.Error())))
		intent.Set(p("failed_at", jsvalue.Str(readCompleted)))
		return b.savePlanFlush(ctx, eui, control, *intent)
	}

	seen := make(map[string]bool)
	for _, owner := range owners {
		if id := owner.state.Get("queue_id"); id.Truthy() {
			seen[id.MustString()] = true
		}
	}
	var snapshot []jsvalue.Value
	opaque := control.Get("opaque").List
	for _, item := range items {
		id := item.GetId()
		data := jsvalue.Str(base64.StdEncoding.EncodeToString(item.GetData()))
		view := jsvalue.Obj(p("id", jsvalue.Str(id)), p("fPort", jsvalue.Num(float64(item.GetFPort()))),
			p("data", data), p("confirmed", jsvalue.Bool(item.GetConfirmed())),
			p("isPending", jsvalue.Bool(item.GetIsPending())), p("isEncrypted", jsvalue.Bool(item.GetIsEncrypted())))
		expiry := jsvalue.Nil()
		if item.GetExpiresAt() != nil {
			expiry = jsvalue.Str(valveISO(item.GetExpiresAt().AsTime()))
			view.Set(p("expiresAt", expiry))
		}
		snapshot = append(snapshot, view)
		if id == "" || seen[id] {
			continue
		}
		entry := jsvalue.Obj(p("owner_id", jsvalue.Str(id)), p("queue_id", jsvalue.Str(id)), p("device_eui", jsvalue.Str(eui)),
			p("phase", jsvalue.Str("ACCEPTED")), p("payload", zoneFallback(data, jsvalue.Nil())),
			p("data", zoneFallback(data, jsvalue.Nil())), p("fPort", view.Get("fPort")), p("confirmed", view.Get("confirmed")),
			p("expiresAt", expiry), p("isPending", view.Get("isPending")), p("captured_by_flush", jsvalue.Str(result.id)))
		if !slices.ContainsFunc(opaque, func(owner jsvalue.Value) bool {
			return owner.Get("owner_id").MustString() == id || owner.Get("queue_id").MustString() == id
		}) {
			opaque = append(opaque, entry)
		}
		owners = append(owners, planQueueOwner{kind: "opaque", id: id, state: entry, row: entry})
		seen[id] = true
	}
	control.Set(p("opaque", jsvalue.Arr(opaque...)))
	intent.Set(p("owners", planQueueOwnerValues(eui, owners)))
	intent.Set(p("captured_snapshot", jsvalue.Arr(snapshot...)))
	intent.Set(p("captured_at", jsvalue.Str(readCompleted)))
	intent.Set(p("read_started_at", jsvalue.Str(readStarted)))
	intent.Set(p("read_completed_at", jsvalue.Str(readCompleted)))
	intent.Set(p("capture_status", jsvalue.Str("COMPLETE")))
	return b.savePlanFlush(ctx, eui, control, *intent)
}

func (b *backend) finishPlanFlush(ctx context.Context, eui string, control jsvalue.Value, result planFlushResult, now time.Time) (planFlushResult, error) {
	p := jsvalue.Property
	intent := &result.intent
	outcome := "UNKNOWN"
	if result.ok {
		outcome = "COMPLETE"
	}
	intent.Set(p("status", jsvalue.Str(outcome)))
	intent.Set(p("attempt_status", jsvalue.Str(outcome)))
	intent.Set(p("result_status", jsvalue.Str(outcome)))
	switch {
	case result.ok:
		intent.Set(p("completed_at", jsvalue.Str(valveISO(time.Now()))))
	case result.problem != nil:
		intent.Set(p("error", jsvalue.Str(result.problem.Error())))
		intent.Set(p("failed_at", jsvalue.Str(valveISO(time.Now()))))
	default:
		result.invalidatedIDs = slices.Clone(intent.Get("invalidated_queue_ids").List)
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	for _, owner := range intent.Get("owners").List {
		queue := owner.Get("queue_id")
		if err := invalidatePlanFlushOwner(ctx, tx, eui, result, &control, owner, now); err != nil {
			return result, err
		}
		if queue.Truthy() && (!result.replayed || result.attempted || !slices.ContainsFunc(result.invalidatedIDs, func(id jsvalue.Value) bool {
			return id.MustString() == queue.MustString()
		})) {
			result.invalidatedIDs = append(result.invalidatedIDs, queue)
		}
	}
	intent.Set(p("invalidated_queue_ids", jsvalue.Arr(result.invalidatedIDs...)))
	if result.replayed && !result.attempted {
		intent.Set(p("reconciled_at", jsvalue.Str(valveISO(now))))
	}
	setPlanFlush(&control, *intent)
	if err := writeValveControl(ctx, tx, eui, control); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func invalidatePlanFlushOwner(ctx context.Context, tx *farmTx, eui string, result planFlushResult, control *jsvalue.Value, owner jsvalue.Value, now time.Time) error {
	p := jsvalue.Property
	id, kind, queue := owner.Get("id").MustString(), owner.Get("type").MustString(), owner.Get("queue_id")
	at := jsvalue.Str(valveISO(now))
	invalidate := func(state *jsvalue.Value) error {
		if current := state.Get("queue_id"); current.Truthy() && queue.Truthy() && current.MustString() != queue.MustString() {
			return errors.New("transport_queue_id_immutable")
		}
		state.Set(p("phase", jsvalue.Str("UNKNOWN")))
		if queue.Truthy() {
			state.Set(p("queue_id", queue))
		}
		state.Set(p("invalidated_by_flush", jsvalue.Str(result.id)))
		state.Set(p("invalidated_at", at))
		snapshot := result.intent.Get("captured_snapshot")
		first := state.Get("first_invalidated_by_flush")
		if result.ok && snapshot.Kind == jsvalue.Array && (first.Kind == jsvalue.Null || first.Kind == jsvalue.Undefined) {
			state.Set(p("first_invalidated_by_flush", jsvalue.Str(result.id)))
			unsent := queue.Truthy() && slices.ContainsFunc(snapshot.List, func(item jsvalue.Value) bool {
				itemID := zoneFallback(item.Get("id"), zoneFallback(item.Get("queue_id"), item.Get("queueId")))
				return itemID.MustString() == queue.MustString() && !item.Get("isPending").Truthy() && !item.Get("is_pending").Truthy()
			})
			state.Set(p("unsent_in_snapshot", jsvalue.Bool(unsent)))
		}
		return nil
	}
	if kind == "opaque" {
		opaque := control.Get("opaque").List
		for i, entry := range opaque {
			if entry.Get("owner_id").MustString() == id || entry.Get("queue_id").MustString() == id {
				if err := invalidate(&entry); err != nil {
					return err
				}
				opaque[i] = entry
				return nil
			}
		}
		entry := jsvalue.Obj(p("owner_id", jsvalue.Str(id)), p("queue_id", jsvalue.Nil()), p("device_eui", jsvalue.Str(eui)))
		if err := invalidate(&entry); err != nil {
			return err
		}
		control.Set(p("opaque", jsvalue.Arr(append(opaque, entry)...)))
		return nil
	}

	table, column := "valve_schedule_pushes", "push_id"
	if kind == "expectation" {
		table, column = "valve_actuation_expectations", "expectation_id"
	} else if kind != "push" {
		return errors.New("flush owner type is invalid")
	}
	var raw sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT transport_json FROM "+table+" WHERE "+column+"=? AND UPPER(device_eui)=?",
		id, eui).Scan(&raw); err != nil {
		return err
	}
	state, err := valveStoredJSON(raw.String)
	if err == nil {
		err = invalidate(&state)
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE "+table+" SET transport_json=? WHERE "+column+"=?", valveJSON(state), id); err != nil {
		return err
	}
	if kind == "expectation" {
		_, err = tx.ExecContext(ctx, `UPDATE irrigation_occurrences SET state='UNKNOWN',updated_at=?
			WHERE command_id=(SELECT command_id FROM valve_actuation_expectations WHERE expectation_id=?)
			AND state IN ('ATTEMPTED','SENT')`, at.MustString(), id)
	}
	return err
}

func setPlanFlush(control *jsvalue.Value, intent jsvalue.Value) {
	flushes := control.Get("flushes").List
	for i, existing := range flushes {
		if existing.Get("flush_id").MustString() == intent.Get("flush_id").MustString() {
			flushes[i] = intent
			return
		}
	}
	flushes = append(flushes, intent)
	control.Set(jsvalue.Property("flushes", jsvalue.Arr(flushes[max(0, len(flushes)-20):]...)))
}

func (b *backend) savePlanFlush(ctx context.Context, eui string, control *jsvalue.Value, intent jsvalue.Value) error {
	setPlanFlush(control, intent)
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := writeValveControl(ctx, tx, eui, *control); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *backend) planQueueOwners(ctx context.Context, eui string, control *jsvalue.Value) ([]planQueueOwner, error) {
	var owners []planQueueOwner
	for _, source := range []struct{ kind, id, table string }{
		{"expectation", "expectation_id", "valve_actuation_expectations"},
		{"push", "push_id", "valve_schedule_pushes"},
	} {
		rows, err := queryZones(ctx, b.db, "SELECT * FROM "+source.table+" WHERE UPPER(device_eui)=? ORDER BY rowid", eui)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			state, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
			if err != nil {
				return nil, err
			}
			if planOwnerBlocks(source.kind, row, state) {
				owners = append(owners, planQueueOwner{source.kind, row.Get(source.id).MustString(), state, row})
			}
		}
	}
	opaque := control.Get("opaque").List
	for i, entry := range opaque {
		if !planOwnerBlocks("opaque", entry, entry) {
			continue
		}
		id := zoneFallback(entry.Get("owner_id"), entry.Get("queue_id"))
		if !id.Truthy() {
			id = jsvalue.Str("opaque:" + eui + ":" + jsvalue.Num(float64(i)).MustString())
			entry.Set(jsvalue.Property("owner_id", id))
		}
		if !entry.Get("device_eui").Truthy() {
			entry.Set(jsvalue.Property("device_eui", jsvalue.Str(eui)))
		}
		opaque[i] = entry
		owners = append(owners, planQueueOwner{"opaque", id.MustString(), entry, entry})
	}
	return owners, nil
}

func planOwnerBlocks(kind string, row, state jsvalue.Value) bool {
	phase := state.Get("phase").MustString()
	if phase == "UNKNOWN" && state.Get("first_invalidated_by_flush").Truthy() && state.Get("invalidated_by_flush").Truthy() {
		return false
	}
	switch kind {
	case "expectation":
		if row.Get("reconciliation_state").MustString() == "CANCELLED" &&
			(state.Get("cancelled_unsent_at").Truthy() || state.Get("cancelled_before_send_at").Truthy()) {
			return false
		}
		open := valveInstant(row.Get("observed_open_at").MustString())
		close := valveInstant(row.Get("observed_close_at").MustString())
		if effect := state.Get("effect_snapshot"); effect.Truthy() {
			return valveEffectHolds(effect, state, valveDevice{}, open, close, !open.IsZero(), !close.IsZero())
		}
		if !open.IsZero() && !close.IsZero() && !close.Before(open) {
			return false
		}
	case "push":
		if row.Get("state").MustString() == "ACKED" {
			return false
		}
	}
	return phase == "INTENT" || phase == "ATTEMPTED" || phase == "UNKNOWN" || phase == "ACCEPTED"
}

func supersedePlanClock(ctx context.Context, tx planWriter, eui string, flush planFlushResult) error {
	result, err := tx.ExecContext(ctx, `UPDATE valve_schedule_pushes SET state='SUPERSEDED'
		WHERE UPPER(device_eui)=? AND state='QUEUED' AND purpose='CLOCK_SYNC'
		AND (? OR json_extract(CASE WHEN json_valid(transport_json) THEN transport_json END,'$.invalidated_by_flush')=?)`,
		eui, flush.ok, flush.id)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE valve_settings SET last_clock_sync_queued_at=NULL,updated_at=datetime('now') WHERE device_eui=?", eui)
	return err
}

func (b *backend) savePlanControl(ctx context.Context, eui string, control jsvalue.Value) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := writePlanControl(ctx, tx, eui, control); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *backend) planConversionConflict(ctx context.Context, eui string, now time.Time) (jsvalue.Value, error) {
	rows, err := queryZones(ctx, b.db, `SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=? ORDER BY rowid DESC`, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	for _, row := range rows {
		state, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		if err != nil {
			return jsvalue.Value{}, err
		}
		reconciliation := row.Get("reconciliation_state").MustString()
		deadline := valveInstant(zoneFallback(row.Get("reservation_end_at"), row.Get("expected_close_at")).MustString())
		if planOwnerBlocks("expectation", row, state) || (state.Get("effect_snapshot").Kind == jsvalue.Undefined &&
			(reconciliation == "PENDING_OBSERVATION" || reconciliation == "OBSERVED_RUNNING" || deadline.After(now))) {
			return zoneFallback(row.Get("command_id"), zoneFallback(row.Get("expectation_id"), jsvalue.Str("active_open"))), nil
		}
	}
	var command sql.NullString
	err = b.db.QueryRowContext(ctx, `SELECT command_id FROM irrigation_occurrences WHERE UPPER(device_eui)=?
		AND command_id IS NOT NULL AND state IN ('RESERVED','ATTEMPTED','SENT','UNKNOWN') LIMIT 1`, eui).Scan(&command)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return jsvalue.Value{}, err
	}
	if command.Valid {
		return jsvalue.Str(command.String), nil
	}
	control, err := loadValveControl(ctx, b.db, eui)
	if err != nil {
		return jsvalue.Value{}, err
	}
	for _, entry := range control.Get("opaque").List {
		port := zoneFallback(entry.Get("fPort"), entry.Get("fport")).MustNumber()
		data, _ := base64.StdEncoding.DecodeString(zoneFallback(entry.Get("data"), entry.Get("payload")).MustString())
		if planOwnerBlocks("opaque", entry, entry) &&
			(port != port || port == 2 || port == 28 || (port == 27 && (len(data) == 0 || data[0] == 0x31))) {
			return zoneFallback(entry.Get("queue_id"), jsvalue.Str("active_open")), nil
		}
	}
	return jsvalue.Value{}, nil
}
