package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"log"
	"regexp"
	"slices"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

// valveRuntimeGateway is runtime.js resolveLinkAndGateway: the cloud link row
// and the device row are read as node-sqlite3 returns them; the link counts
// when Number(linked) === 1; the gateway is String(value).trim() of the
// device's truthy gateway_device_eui, else of the link's, with JavaScript's
// whitespace (not SQLite trim, which strips only spaces). An unlinked gateway
// gives "" and no error; a linked one without a gateway gives an error (the
// JS warns and writes nothing).
func valveRuntimeGateway(ctx context.Context, db scheduleQueryer, eui string) (string, error) {
	var linked, linkGateway, deviceGateway storedValue
	linkErr := db.QueryRowContext(ctx, "SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'").
		Scan(&linked, &linkGateway)
	deviceErr := db.QueryRowContext(ctx, "SELECT gateway_device_eui FROM devices WHERE UPPER(deveui) = UPPER(?) AND deleted_at IS NULL", eui).
		Scan(&deviceGateway)
	for _, err := range []error{linkErr, deviceErr} {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	if linkErr != nil || linked.number() != 1 {
		return "", nil
	}
	gateway := ""
	if deviceGateway.truthy() {
		gateway = jsvalue.Trim(deviceGateway.jsString())
	}
	if gateway == "" && linkGateway.truthy() {
		gateway = jsvalue.Trim(linkGateway.jsString())
	}
	if gateway == "" {
		return "", errors.New("no gateway EUI for valve runtime event")
	}
	return gateway, nil
}

func emitPlanRuntime(ctx context.Context, tx planWriter, eui string, now time.Time) error {
	eui = jsvalue.Upper(eui)
	gateway, err := valveRuntimeGateway(ctx, tx, eui)
	if err != nil || gateway == "" {
		return err
	}

	pushes, err := valvePushSummary(ctx, tx, eui, now)
	if err != nil {
		return err
	}
	p := jsvalue.Property
	push := jsvalue.Obj(p("queued", pushes.Get("queued")), p("acked", pushes.Get("acked")),
		p("failed", pushes.Get("failed")), p("lost", pushes.Get("lost")),
		p("scheduler_status_lost", pushes.Get("scheduler_status_lost")),
		p("last_plan_acked_at", zoneFallback(pushes.Get("last_plan_acked_at"), jsvalue.Nil())))
	settings, err := planSettings(ctx, tx, eui)
	if err != nil {
		return err
	}
	if settings.Get("strega_generation").MustString() == "GEN1" {
		rows, err := planWeekdayStates(ctx, tx, eui)
		if err != nil {
			return err
		}
		var slots [7]jsvalue.Value
		for _, row := range rows {
			if row.Get("purpose").MustString() != "WEEKDAY_PLAN" {
				continue
			}
			weekday := row.Get("weekday")
			if !valveWhole(weekday, 0, 6) || slots[int(weekday.Num)].Truthy() {
				continue
			}
			state, lost := row.Get("state"), jsvalue.Value{}
			if state.MustString() == "LOST" {
				state, lost = jsvalue.Str("FAILED"), jsvalue.Bool(true)
			}
			slots[int(weekday.Num)] = jsvalue.Obj(p("weekday", weekday), p("state", state),
				p("acked_at", zoneFallback(row.Get("acked_at"), jsvalue.Nil())), p("lost", lost))
		}
		var days []jsvalue.Value
		for _, slot := range slots {
			if slot.Truthy() {
				days = append(days, slot)
			}
		}
		push.Set(p("weekday_states", jsvalue.Arr(days...)))
	}

	candidates, err := queryZones(ctx, tx, `SELECT expectation_id,reconciliation_state,commanded_at,expected_close_at,
		commanded_duration_seconds AS duration_seconds,trigger,transport_json
		FROM valve_actuation_expectations WHERE UPPER(device_eui)=? AND commanded_duration_seconds>0
		AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY commanded_at DESC`, eui)
	if err != nil {
		return err
	}
	active := jsvalue.Nil()
	for _, row := range candidates {
		state, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		reports := state.Get("untrusted_report")
		if err != nil || state.Get("physical_run").Truthy() || (reports.Get("open").Truthy() && reports.Get("closed").Truthy()) {
			continue
		}
		active = jsvalue.Obj(row.Fields[:6]...)
		active.Set(p("trigger", zoneFallback(row.Get("trigger"), jsvalue.Nil())))
		break
	}
	// store.js recentStaleState answers row.reconciliation_state as read (a
	// BLOB matching LIKE 'STALE_%' is a Buffer in the payload), null without
	// a row. modernc builds SQLite with SQLITE_LIKE_DOESNT_MATCH_BLOBS; the
	// gateway's sqlite3 matches a BLOB as its text, which the CAST restores.
	var stale storedValue
	err = tx.QueryRowContext(ctx, `SELECT reconciliation_state FROM valve_actuation_expectations
		WHERE UPPER(device_eui)=? AND CAST(reconciliation_state AS TEXT) LIKE 'STALE_%' AND datetime(commanded_at)>datetime('now','-1 day')
		ORDER BY commanded_at DESC LIMIT 1`, eui).Scan(&stale)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	nowText := valveISO(time.Now())
	payload := jsvalue.Obj(p("contract_version", jsvalue.Num(1)), p("device_eui", jsvalue.Str(eui)),
		p("active_actuation", active), p("recent_stale_state", stale.json()), p("push_state", push),
		p("as_of", jsvalue.Str(nowText)))
	_, err = tx.ExecContext(ctx, `INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,
		sync_version,occurred_at,gateway_device_eui) VALUES (?,'VALVE_RUNTIME',?,'VALVE_RUNTIME_CHANGED',?,0,?,?)`,
		uuid.NewString(), eui, valveJSON(payload), nowText, gateway)
	return err
}

func (b *backend) emitValveRuntime(ctx context.Context, eui string) {
	if err := func() error {
		tx, err := b.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err := emitPlanRuntime(ctx, tx, eui, time.Now()); err != nil {
			return err
		}
		return tx.Commit()
	}(); err != nil {
		log.Printf("valve runtime %s: %v", eui, err)
	}
}

func (b *backend) emitValveCancelEvents(ctx context.Context, eui, id string) {
	b.emitValveRuntime(ctx, eui)
	if id != "" {
		if err := emitValveActuationArchive(ctx, b.db, eui, id); err != nil {
			log.Printf("archive valve cancellation %s: %v", eui, err)
		}
	}
}

func emitValveActuationArchive(ctx context.Context, db planWriter, eui, id string) error {
	gateway, err := valveRuntimeGateway(ctx, db, eui)
	if err != nil || gateway == "" {
		return err
	}
	rows, err := queryZones(ctx, db, `SELECT vae.*, z.zone_uuid, ac.result AS command_result, ac.result_detail AS command_result_detail
		FROM valve_actuation_expectations vae
		LEFT JOIN irrigation_zones z ON z.id=vae.zone_id AND z.deleted_at IS NULL
		LEFT JOIN applied_commands ac ON ac.command_id=vae.command_id
		WHERE vae.expectation_id=? AND vae.reconciliation_state IN
		('CANCELLED','OBSERVED_COMPLETE','STALE_NO_OBSERVATION','STALE_OPEN_OBSERVED')`, id)
	if err != nil || len(rows) == 0 {
		return err
	}
	row := rows[0]
	if valveActuationLocalOnly(row) {
		return nil
	}
	status := "OPEN_TIMEOUT"
	switch {
	case row.Get("reconciliation_state").MustString() == "CANCELLED":
		status = "CANCELLED"
	case row.Get("command_result").Truthy() && jsvalue.Upper(row.Get("command_result").MustString()) != "APPLIED":
		status = "COMMAND_FAILED"
	case row.Get("observed_open_at").Truthy() && row.Get("observed_close_at").Truthy():
		status = "COMPLETED"
	case row.Get("observed_open_at").Truthy():
		status = "CLOSE_TIMEOUT"
	}
	p := jsvalue.Property
	nullIfEmpty := func(key string) jsvalue.Value { return zoneFallback(row.Get(key), jsvalue.Nil()) }
	archivedAt := zoneFallback(row.Get("observed_close_at"), row.Get("commanded_at"))
	payload := jsvalue.Obj(p("contract_version", jsvalue.Num(1)), p("expectation_id", jsvalue.Str(id)),
		p("device_eui", jsvalue.Str(jsvalue.Upper(row.Get("device_eui").MustString()))),
		p("zone_uuid", nullIfEmpty("zone_uuid")), p("status", jsvalue.Str(status)), p("trigger", nullIfEmpty("trigger")),
		p("commanded_at", row.Get("commanded_at")), p("observed_open_at", nullIfEmpty("observed_open_at")),
		p("observed_close_at", nullIfEmpty("observed_close_at")), p("expected_close_at", nullIfEmpty("expected_close_at")),
		p("duration_seconds", row.Get("commanded_duration_seconds")), p("estimated_gross_liters", row.Get("estimated_gross_liters")),
		p("volume_source", nullIfEmpty("volume_source")), p("cancel_reason", nullIfEmpty("cancel_reason")),
		p("command_result_detail", nullIfEmpty("command_result_detail")), p("archived_at", archivedAt))
	// The archive ID sorts the flat payload's keys before hashing, with
	// the original JSON string and number encodings.
	sorted := jsvalue.Obj(slices.Clone(payload.Fields)...)
	slices.SortFunc(sorted.Fields, func(a, b jsvalue.Field) int { return slices.Compare(a.Key, b.Key) })
	digest := sha256.Sum256([]byte(id + "\x00" + valveJSON(sorted)))
	digest[6] = digest[6]&0x0f | 0x80
	digest[8] = digest[8]&0x0f | 0x80
	event := uuid.UUID(digest[:16]).String()
	_, err = db.ExecContext(ctx, `INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,
		sync_version,occurred_at,gateway_device_eui) VALUES (?,'VALVE_ACTUATION',?,'VALVE_ACTUATION_ARCHIVED',?,0,?,?)
		ON CONFLICT(event_uuid) DO NOTHING`, event, id, valveJSON(payload), archivedAt.MustString(), gateway)
	return err
}

func valveActuationLocalOnly(row jsvalue.Value) bool {
	if row.Get("command_id").Kind != jsvalue.Null {
		return false
	}
	if row.Get("commanded_duration_seconds").MustString() == "-1" && row.Get("expected_close_at").MustString() == "" {
		return true
	}
	transport, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
	marker := transport.Get("physical_run")
	if err == nil && (marker.Kind == jsvalue.Undefined || marker.Kind == jsvalue.Null) {
		return false
	}
	legacy := marker.Get("legacy_v1_compatibility")
	n := row.Get("commanded_duration_seconds")
	if err != nil || row.Get("trigger").MustString() != "on_valve_schedule" ||
		!valveWhole(n, 1, 9007199254740991) ||
		!validArchiveInstant(row.Get("commanded_at")) || !validArchiveInstant(row.Get("expected_close_at")) ||
		marker.Kind != jsvalue.Object || !valveWhole(marker.Get("version"), 1, 1) ||
		marker.Get("source").MustString() != "explicit_report" ||
		legacy.Kind != jsvalue.Object || !valveWhole(legacy.Get("version"), 1, 1) ||
		legacy.Get("source").MustString() != "preexisting_on_valve_schedule" {
		return true
	}
	for _, key := range []string{"earliest_possible_start_at", "latest_possible_end_at"} {
		value := marker.Get(key)
		if value.Kind != jsvalue.Null && !validArchiveInstant(value) {
			return true
		}
	}
	for _, key := range []string{"expectation_id", "commanded_at", "commanded_duration_seconds", "expected_close_at"} {
		if !valveEffectValuesEqual(legacy.Get(key), row.Get(key)) {
			return true
		}
	}
	return false
}

var archiveInstant = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`)

func validArchiveInstant(value jsvalue.Value) bool {
	raw := value.MustString()
	if value.Kind != jsvalue.String || !archiveInstant.MatchString(raw) {
		return false
	}
	at, ok := jsdate.Parse(raw, time.UTC)
	return ok && jsdate.ISOString(at)[:19] == raw[:19]
}
