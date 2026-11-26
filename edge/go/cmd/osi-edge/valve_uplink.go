package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/ingest"
	"osi-edge/internal/jsnum"
	"osi-edge/internal/jsvalue"
)

func init() {
	registerUplink("strega", (*backend).ingestSTREGA)
}

func (b *backend) ingestSTREGA(ctx context.Context, uplink ingest.Uplink) error {
	event, err := jsvalue.Parse(uplink.Payload)
	if err != nil {
		return err
	}
	info := event.Get("deviceInfo")
	name := jsvalue.Upper(info.Get("deviceProfileName").OrEmpty().MustString())
	profile := jsvalue.Trim(info.Get("deviceProfileId").OrEmpty().MustString())
	strega, gen2 := envValveValue("CHIRPSTACK_PROFILE_STREGA"), envValveValue("CHIRPSTACK_PROFILE_STREGA_GEN2")
	if !strings.Contains(name, "STREGA") && (profile == "" || (profile != strega && profile != gen2)) {
		return nil
	}
	isGen2 := strings.Contains(name, "GEN2") || gen2 != "" && profile == gen2
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()

	// Valve ACK ledger and Process STREGA consume separate wires. A throw
	// in either wire must leave the other free to process the same uplink.
	ackErr := b.recordValveACK(ctx, event, uplink.Received)
	reportErr := b.reportSTREGA(ctx, event, info, isGen2, uplink.Received)
	return errors.Join(ackErr, reportErr)
}

func (b *backend) reportSTREGA(ctx context.Context, event, info jsvalue.Value, isGen2 bool, received time.Time) (err error) {
	defer jsvalue.CatchConversion(&err)
	app := jsvalue.Lower(envValveValue("CHIRPSTACK_APP_FIELD_TESTER"))
	uplinkApp := jsvalue.Lower(jsvalue.Trim(info.Get("applicationId").OrEmpty().MustString()))
	if app != "" && app == uplinkApp {
		return nil
	}
	eui := jsvalue.Upper(jsvalue.Trim(info.Get("devEui").OrEmpty().MustString()))
	if eui == "" {
		return nil
	}
	if stregaProfileKind(info) != valveType {
		return nil
	}
	// The shared guard records the key before the device lookup, so a
	// STREGA-named uplink for any device takes a slot in the KIWI capacity.
	if b.dedup.IsDuplicate("strega", event, eui, time.Now().UnixMilli()) {
		return nil
	}
	decoded := event.Get("object")
	if len(decoded.Fields) == 0 && len(decoded.List) == 0 {
		if isGen2 {
			return nil
		}
		decoded = decodeValveGen1(event.Get("data"), event.Get("fPort"))
		if decoded.Kind == jsvalue.Undefined {
			return nil
		}
	}
	return b.ingestValveReport(ctx, eui, event, decoded, isGen2, received)
}

func (b *backend) ingestValveReport(ctx context.Context, eui string, event, decoded jsvalue.Value, gen2 bool, received time.Time) error {
	state := ""
	bit := decoded.Get("Valve")
	if bit.Kind == jsvalue.Undefined || bit.Kind == jsvalue.Null {
		bit = decoded.Get("Actuator")
	}

	report := makeValveReport(event, received)
	temp, humidity, battery := valveEnvironment(decoded, gen2)
	switch jsvalue.Trim(bit.MustString()) {
	case "1":
		state = "OPEN"
	case "0":
		state = "CLOSED"
	}
	// Process STREGA stringifies these before it sends the local report,
	// even though this port does not store the flag strings.
	for _, field := range [...]string{"Tamper", "Cable", "Leakage", "Fraud"} {
		if value := decoded.Get(field); value.Kind != jsvalue.Null && value.Kind != jsvalue.Undefined {
			value.MustString()
		}
	}

	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var kind string
	err = tx.QueryRowContext(ctx, "SELECT type_id FROM devices WHERE deveui=? AND deleted_at IS NULL", eui).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && kind != valveType) {
		return nil
	}
	if err != nil {
		return err
	}
	inserted, err := tx.ExecContext(ctx, `INSERT INTO device_data(deveui, recorded_at, ambient_temperature, relative_humidity, bat_pct, uplink_key)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(deveui, uplink_key) WHERE uplink_key IS NOT NULL DO NOTHING`,
		eui, report.recordedAt, temp, humidity, battery, report.key)
	if err != nil {
		return err
	}
	count, err := inserted.RowsAffected()
	if err != nil {
		return err
	}
	var clock valveObservationClock
	if state != "" {
		clock = b.checkValveObservationClock()
		if count > 0 {
			if err := recordValveObservation(ctx, tx, eui, state, report, clock); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if state == "CLOSED" && clock.trusted(report.at) {
		return b.observeValveCloseEvidence(ctx, eui, report, clock)
	}
	return nil
}

// stregaProfileKind is Process STREGA's getProfileKind: the KIWI, Clover and
// LSN50 checks come before the STREGA one.
func stregaProfileKind(info jsvalue.Value) string {
	name := jsvalue.Upper(info.Get("deviceProfileName").OrEmpty().MustString())
	id := jsvalue.Trim(info.Get("deviceProfileId").OrEmpty().MustString())
	is := func(value string) bool { return value != "" && value == id }
	switch {
	case is(envValveValue("CHIRPSTACK_PROFILE_KIWI")) || id == kiwiLegacyProfileID || strings.Contains(name, "KIWI"):
		return "KIWI_SENSOR"
	case is(envValveValue("CHIRPSTACK_PROFILE_CLOVER")) || id == cloverLegacyProfileID || strings.Contains(name, "CLOVER"):
		return "TEKTELIC_CLOVER"
	case is(envValveValue("CHIRPSTACK_PROFILE_LSN50")) || strings.Contains(name, "LSN50") || strings.Contains(name, "DRAGINO"):
		return "DRAGINO_LSN50"
	case is(envValveValue("CHIRPSTACK_PROFILE_STREGA")) || is(envValveValue("CHIRPSTACK_PROFILE_STREGA_GEN2")) || strings.Contains(name, "STREGA"):
		return valveType
	}
	return ""
}

func envValveValue(key string) string {
	return jsvalue.Trim(os.Getenv(key))
}

type valveReport struct {
	at         time.Time
	recordedAt string
	identity   jsvalue.Value
	key        any
}

func makeValveReport(event jsvalue.Value, received time.Time) valveReport {
	report := valveReport{recordedAt: valveISO(received)}
	raw := event.Get("time")
	if raw.Kind != jsvalue.Undefined && raw.Kind != jsvalue.Null {
		var valid bool
		report.at, valid = ingest.EventTime(raw)
		if valid {
			report.recordedAt = valveISO(report.at)
		}
		raw = jsvalue.Str(raw.MustString())
	} else {
		raw = jsvalue.Nil()
	}
	id, count, port := event.Get("deduplicationId"), event.Get("fCnt"), event.Get("fPort")
	if !id.Truthy() {
		id = jsvalue.Nil()
	}
	if count.Kind == jsvalue.Undefined {
		count = jsvalue.Nil()
	}
	if port.Kind == jsvalue.Undefined {
		port = jsvalue.Nil()
	}
	report.identity = jsvalue.Obj(
		jsvalue.Property("deduplicationId", id),
		jsvalue.Property("fCnt", count),
		jsvalue.Property("fPort", port),
		jsvalue.Property("reportedAtRaw", raw),
	)
	keyEvent := jsvalue.Obj(
		jsvalue.Property("deduplicationId", id),
		jsvalue.Property("fCnt", count),
		jsvalue.Property("fPort", port),
		jsvalue.Property("time", raw),
	)
	if key := ingest.EventKey("strega", keyEvent); key != "" {
		report.key = key
	}
	return report
}

func valveEnvironment(decoded jsvalue.Value, gen2 bool) (temperature, humidity, battery sql.NullFloat64) {
	number := func(field string) float64 {
		value := decoded.Get(field)
		if value.Kind == jsvalue.Null || (value.Kind == jsvalue.String && !value.Truthy()) {
			return math.NaN()
		}
		return value.MustNumber()
	}
	temp, rh, batt := number("Temperature"), number("Hygrometry"), number("Battery")
	if temp != 125 || rh != 100 {
		if temp >= -50 && temp <= 100 {
			temperature = sql.NullFloat64{Float64: jsnum.Round(temp*10) / 10, Valid: true}
		}
		if !math.IsNaN(rh) && !math.IsInf(rh, 0) {
			humidity = sql.NullFloat64{Float64: jsnum.Round(math.Max(0, math.Min(100, rh))*10) / 10, Valid: true}
		}
	}
	// The shipped local telemetry INSERT has no voltage column. Gen2's
	// millivolt reading is absent from local history and is never a percent.
	if !gen2 && batt >= 0 && !math.IsInf(batt, 0) {
		battery = sql.NullFloat64{Float64: math.Min(100, jsnum.Round(batt)), Valid: true}
	}
	return
}

func recordValveObservation(ctx context.Context, tx *farmTx, eui, state string, report valveReport, clock valveObservationClock) error {
	var raw sql.NullString
	err := tx.QueryRowContext(ctx, "SELECT conditional_control_json FROM valve_settings WHERE device_eui=?", eui).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	control, err := valveStoredJSON(raw.String)
	if err != nil {
		return fmt.Errorf("parse valve observation control: %w", err)
	}

	observation := control.Get("observation")
	if observation.Kind != jsvalue.Object {
		observation = jsvalue.Obj()
	}
	proof := clock.proof()
	if !clock.trusted(report.at) {
		reason := clock.reason
		if report.at.IsZero() {
			reason = "observation_time_invalid"
		}
		return recordUntrustedValveReport(ctx, tx, eui, state, reason, report, control, observation, clock)
	}
	previous := valveInstant(observation.Get("last_reported_at").OrEmpty().MustString())
	identity := valveJSON(report.identity)
	if !previous.IsZero() && !report.at.After(previous) {
		reason := "stale_report"
		if report.at.Equal(previous) {
			if observation.Get("state").MustString() == state && observation.Get("event_identity").MustString() == identity {
				if state == "CLOSED" {
					if id := observation.Get("physical_run_id"); id.Truthy() {
						_, err := tx.ExecContext(ctx, `UPDATE valve_actuation_expectations SET observed_close_at=?,
							reconciliation_state='OBSERVED_COMPLETE' WHERE expectation_id=? AND UPPER(device_eui)=?
							AND observed_close_at IS NULL`, report.recordedAt, id.MustString(), eui)
						return err
					}
				}
				return nil
			}
			reason = "equal_time_conflict"
			observation.Set(jsvalue.Property("uncertain", jsvalue.Bool(true)))
		}
		appendValveReport(&observation, report, state, reason, true, proof)
		control.Set(jsvalue.Property("observation", observation))
		return writePlanControl(ctx, tx, eui, control)
	}

	reportAt := jsvalue.Str(report.recordedAt)
	observation.Set(jsvalue.Property("last_reported_at", reportAt))
	observation.Set(jsvalue.Property("state", jsvalue.Str(state)))
	observation.Set(jsvalue.Property("event_identity", jsvalue.Str(identity)))
	observation.Set(jsvalue.Property("uncertain", jsvalue.Bool(false)))
	openRun := observation.Get("physical_run_id")
	if state == "OPEN" {
		id, err := openValveObservation(ctx, tx, eui, report, clock.receipt, proof, &control, openRun)
		if err != nil {
			return err
		}
		observation.Set(jsvalue.Property("physical_run_id", jsvalue.Str(id)))
	}
	if state == "CLOSED" {
		if _, _, err := attachValveUntrustedReport(ctx, tx, eui, state, "clock_synchronised",
			valveISO(clock.now), report.identity, proof, control); err != nil {
			return err
		}
		if openRun.Truthy() {
			if err := closeValveObservation(ctx, tx, eui, openRun.MustString(), reportAt, proof); err != nil {
				return err
			}
			incident := control.Get("incident")
			if incident.Get("physical_run_reference").MustString() == openRun.MustString() {
				p := jsvalue.Property
				incident.Set(p("ended", jsvalue.Bool(true)))
				incident.Set(p("ended_at", reportAt))
				incident.Set(p("state", jsvalue.Str("ENDED")))
				control.Set(p("incident", incident))
				if err := reconcileValveIncident(ctx, tx, eui, &control, report.recordedAt); err != nil {
					return err
				}
			}
			observation.Set(jsvalue.Property("last_physical_run_id", openRun))
			observation.Set(jsvalue.Property("physical_run_id", jsvalue.Nil()))
		}
		// Resolve a timed OPEN target only after its last live expectation ends.
		_, err = tx.ExecContext(ctx, `UPDATE devices SET target_state='CLOSED',
			sync_version=COALESCE(sync_version,0)+CASE WHEN UPPER(current_state)='CLOSED' THEN 1 ELSE 0 END
			WHERE deveui=? AND target_state='OPEN' AND NOT EXISTS
			(SELECT 1 FROM valve_actuation_expectations WHERE UPPER(device_eui)=?
			AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING'))`, eui, eui)
		if err != nil {
			return err
		}
	}
	return writeValveObservation(ctx, tx, eui, state, report.recordedAt, control, observation)
}

func writeValveObservation(ctx context.Context, tx *farmTx, eui, state, at string, control, observation jsvalue.Value) error {
	_, err := tx.ExecContext(ctx, `UPDATE devices SET current_state=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1
		WHERE deveui=? AND COALESCE(UPPER(current_state),'')<>?`, state, at, eui, state)
	if err != nil {
		return err
	}
	control.Set(jsvalue.Property("observation", observation))
	return writePlanControl(ctx, tx, eui, control)
}

func openValveObservation(ctx context.Context, tx *farmTx, eui string, report valveReport, receipt valveClockReceipt, proof jsvalue.Value, control *jsvalue.Value, linked jsvalue.Value) (string, error) {
	p := jsvalue.Property
	if linked.Truthy() {
		rows, err := queryZones(ctx, tx, `SELECT expectation_id,command_id,observed_open_at,transport_json
			FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=?
			AND observed_close_at IS NULL AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING','STALE_OPEN_OBSERVED')`, linked.MustString(), eui)
		if err != nil {
			return "", err
		}
		if len(rows) == 1 {
			row := rows[0]
			commanded := row.Get("command_id").Truthy()
			if commanded || row.Get("observed_open_at").Kind == jsvalue.Null {
				transport, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
				if err != nil {
					return "", err
				}
				observation := transport.Get("observation")
				if observation.Kind != jsvalue.Object {
					observation = jsvalue.Obj()
				}
				observation.Set(p("source", jsvalue.Str("explicit_report")))
				if commanded {
					observation.Set(p("report_only", jsvalue.Bool(false)))
					observation.Set(p("proof", proof))
					observation.Set(p("observed_at", jsvalue.Str(report.recordedAt)))
				} else {
					observation.Set(p("proof", proof))
					observation.Set(p("untrusted", jsvalue.Nil()))
				}
				if err := markValveObservedOpen(ctx, tx, row, transport, observation, report.recordedAt); err != nil {
					return "", err
				}
			}
			if !commanded {
				if err := observeValveIncident(ctx, tx, eui, control, linked.MustString(), report.recordedAt); err != nil {
					return "", err
				}
			}
			return linked.MustString(), nil
		}
	}
	owners, err := queryZones(ctx, tx, `SELECT * FROM valve_actuation_expectations
		WHERE UPPER(device_eui)=? AND command_id IS NOT NULL AND observed_open_at IS NULL
		AND reconciliation_state<>'OBSERVED_COMPLETE' ORDER BY rowid`, eui)
	if err != nil {
		return "", err
	}
	occurrences, err := queryZones(ctx, tx, `SELECT command_id, device_eui, state, decision_evidence_json, expires_at, reservation_end_at
		FROM irrigation_occurrences WHERE UPPER(device_eui)=? AND command_id IS NOT NULL`, eui)
	if err != nil {
		return "", err
	}
	byCommand := make(map[string]jsvalue.Value, len(occurrences))
	for _, occ := range occurrences {
		byCommand[occ.Get("command_id").MustString()] = occ
	}

	var eligible int
	var owner, transport jsvalue.Value
	for _, row := range owners {
		candidate, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		if err == nil && valveObservationFits(row, byCommand[row.Get("command_id").MustString()], candidate, eui, report.at, receipt) {
			owner, transport = row, candidate
			eligible++
		}
	}
	if eligible == 1 {
		observation := jsvalue.Obj(p("source", jsvalue.Str("explicit_report")), p("report_only", jsvalue.Bool(false)),
			p("proof", proof), p("observed_at", jsvalue.Str(report.recordedAt)))
		id := owner.Get("expectation_id").MustString()
		return id, markValveObservedOpen(ctx, tx, owner, transport, observation, report.recordedAt)
	}

	reason := "no_owner"
	if eligible > 1 {
		reason = "ambiguous_owner"
	}
	id, err := insertReportedValveRun(ctx, tx, eui, report.recordedAt, jsvalue.Str(report.recordedAt), proof, jsvalue.Nil(), reason)
	if err != nil {
		return "", err
	}
	return id, observeValveIncident(ctx, tx, eui, control, id, report.recordedAt)
}

func markValveObservedOpen(ctx context.Context, tx *farmTx, row, transport, observation jsvalue.Value, at string) error {
	transport.Set(jsvalue.Property("observation", observation))
	_, err := tx.ExecContext(ctx, `UPDATE valve_actuation_expectations SET observed_open_at=COALESCE(observed_open_at,?),
		reconciliation_state='OBSERVED_RUNNING', transport_json=? WHERE expectation_id=?`,
		at, valveJSON(transport), row.Get("expectation_id").MustString())
	if command := row.Get("command_id"); err == nil && command.Truthy() {
		_, err = tx.ExecContext(ctx, `UPDATE irrigation_occurrences SET observed_open_at=COALESCE(observed_open_at,?),updated_at=? WHERE command_id=?`,
			at, at, command.MustString())
	}
	return err
}

func insertReportedValveRun(ctx context.Context, tx *farmTx, eui, anchor string, observed, proof, untrusted jsvalue.Value, reason string) (string, error) {
	transport := jsvalue.Obj(
		jsvalue.Property("physical_run", jsvalue.Obj(
			jsvalue.Property("version", jsvalue.Num(1)),
			jsvalue.Property("source", jsvalue.Str("explicit_report")),
			jsvalue.Property("earliest_possible_start_at", jsvalue.Nil()),
			jsvalue.Property("latest_possible_end_at", jsvalue.Nil()),
		)),
		jsvalue.Property("observation", jsvalue.Obj(
			jsvalue.Property("source", jsvalue.Str("explicit_report")),
			jsvalue.Property("proof", proof),
			jsvalue.Property("untrusted", untrusted),
			jsvalue.Property("unattributed", jsvalue.Str(reason)),
		)),
	)
	id := uuid.NewString()
	var opened any
	if observed.Kind == jsvalue.String {
		opened = observed.MustString()
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO valve_actuation_expectations(
		expectation_id, device_eui, zone_id, commanded_at, commanded_duration_seconds, expected_close_at,
		volume_source, observed_open_at, reconciliation_state, created_at, trigger, transport_json)
		SELECT ?, deveui, irrigation_zone_id, ?, -1, '', 'unknown', ?, 'OBSERVED_RUNNING', ?, 'unexplained', ?
		FROM devices WHERE deveui=?`, id, anchor, opened, anchor, valveJSON(transport), eui)
	return id, err
}

func valveObservationFits(row, occurrence, transport jsvalue.Value, eui string, reported time.Time, receipt valveClockReceipt) bool {
	if jsvalue.Upper(row.Get("device_eui").MustString()) != eui || !row.Get("command_id").Truthy() ||
		row.Get("observed_open_at").Kind != jsvalue.Null || row.Get("reconciliation_state").MustString() == "OBSERVED_COMPLETE" {
		return false
	}
	if row.Get("state").MustString() == "FAILED" {
		switch row.Get("error").MustString() {
		case "negative_ack", "malformed_ack", "ack_protocol_unverified":
			return false
		}
	}
	switch transport.Get("phase").MustString() {
	case "ATTEMPTED", "ACCEPTED", "UNKNOWN":
	default:
		return false
	}
	snapshot := transport.Get("effect_snapshot")
	if snapshot.Get("effect_class").MustString() != "SELF_CLOSING_OPEN" || snapshot.Get("device_eui").MustString() != eui ||
		!validReleasableValveEffect(snapshot, "SELF_CLOSING_OPEN") || transport.Get("untrusted_report").Get("closed").Truthy() {
		return false
	}
	attempt := zoneFallback(transport.Get("attempt_trusted_at"), transport.Get("attempted_at"))
	attempted := valveEffectInstant(attempt)
	end := valveEffectInstant(snapshot.Get("future_effect_end"))
	if reported.IsZero() || attempted.IsZero() || end.IsZero() {
		return false
	}
	prior := transport.Get("attempt_receipt")
	uptime := prior.Get("uptime_ms")
	// An ordinary command in this boot can use elapsed uptime. Occurrence
	// bounds and evidence are persisted in wall time.
	if !occurrence.Truthy() && receipt.bootID != "" && prior.Get("boot_id").MustString() == receipt.bootID &&
		valveWhole(uptime, 0, 9007199254740991) {
		anchor := valveEffectInstant(snapshot.Get("anchor_at"))
		elapsed := receipt.uptimeMS - int64(uptime.Num)
		return !anchor.IsZero() && elapsed >= 0 && elapsed <= end.Sub(anchor).Milliseconds()
	}
	return !reported.Before(attempted) && !reported.After(end) &&
		valveOccurrenceMatches(occurrence, row, snapshot, eui)
}

func valveOccurrenceMatches(occurrence, row, snapshot jsvalue.Value, eui string) bool {
	if !occurrence.Truthy() {
		return true
	}
	if occurrence.Get("command_id").MustString() != row.Get("command_id").MustString() ||
		jsvalue.Upper(occurrence.Get("device_eui").MustString()) != eui {
		return false
	}
	switch occurrence.Get("state").MustString() {
	case "ATTEMPTED", "SENT", "UNKNOWN":
	default:
		return false
	}
	evidence, err := valveStoredJSON(occurrence.Get("decision_evidence_json").OrEmpty().MustString())
	if err != nil || evidence.Get("effect_snapshot").Kind != jsvalue.Object {
		return false
	}
	for _, key := range []string{"queue_expires_at", "latest_physical_start_at", "future_effect_end", "exclusion_end_at"} {
		if !valveEffectValuesEqual(evidence.Get("effect_bounds").Get(key), snapshot.Get(key)) {
			return false
		}
	}
	return valveEffectInstant(occurrence.Get("expires_at")).Equal(valveEffectInstant(snapshot.Get("queue_expires_at"))) &&
		valveEffectInstant(occurrence.Get("reservation_end_at")).Equal(valveEffectInstant(snapshot.Get("future_effect_end"))) &&
		valveJSON(evidence.Get("effect_snapshot")) == valveJSON(snapshot)
}

func closeValveObservation(ctx context.Context, tx *farmTx, eui, id string, at, proof jsvalue.Value) error {
	var command, trigger, opened, raw sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT command_id, trigger, observed_open_at, transport_json
		FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=? AND observed_close_at IS NULL`,
		id, eui).Scan(&command, &trigger, &opened, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	transport, err := valveStoredJSON(raw.String)
	if err != nil {
		return err
	}
	observation := transport.Get("observation")
	if observation.Kind != jsvalue.Object {
		observation = jsvalue.Obj()
	}
	if !command.Valid {
		run := transport.Get("physical_run")
		run.Set(jsvalue.Property("latest_possible_end_at", at))
		transport.Set(jsvalue.Property("physical_run", run))
	}
	observation.Set(jsvalue.Property("observed_at", at))
	observation.Set(jsvalue.Property("proof", proof))
	if !command.Valid {
		observation.Set(jsvalue.Property("untrusted", jsvalue.Nil()))
	}
	transport.Set(jsvalue.Property("observation", observation))
	_, err = tx.ExecContext(ctx, `UPDATE valve_actuation_expectations SET observed_close_at=?,
		reconciliation_state='OBSERVED_COMPLETE', transport_json=? WHERE expectation_id=?`,
		at.MustString(), valveJSON(transport), id)
	if err != nil {
		return err
	}
	if command.Valid {
		_, err = tx.ExecContext(ctx, `UPDATE irrigation_occurrences SET observed_close_at=?,updated_at=?
			WHERE UPPER(device_eui)=? AND command_id=?`, at.MustString(), at.MustString(), eui, command.String)
	} else if trigger.String == "unexplained" || trigger.String == "on_valve_schedule" {
		err = recordPhysicalValveRun(ctx, tx, eui, id, trigger.String, opened, at)
	}
	if err != nil {
		return err
	}
	if err := emitPlanRuntime(ctx, tx, eui, time.Now()); err != nil {
		log.Printf("valve observation runtime %s: %v", eui, err)
	}
	if err := emitValveActuationArchive(ctx, tx, eui, id); err != nil {
		log.Printf("valve observation archive %s: %v", eui, err)
	}
	return nil
}

func recordPhysicalValveRun(ctx context.Context, tx *farmTx, eui, id, trigger string, opened sql.NullString, at jsvalue.Value) error {
	reason := "unexplained_on_valve_run"
	if trigger == "on_valve_schedule" {
		reason = "on_valve_schedule_run"
	}
	payload := jsvalue.Obj(
		jsvalue.Property("expectation_id", jsvalue.Str(id)),
		jsvalue.Property("trigger", jsvalue.Str(trigger)),
		jsvalue.Property("observed_open_at", valveText(opened)),
		jsvalue.Property("observed_close_at", at),
		jsvalue.Property("duration_minutes", jsvalue.Nil()),
	)
	_, err := tx.ExecContext(ctx, `INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, valve_deveui, payload_json)
		SELECT user_id, irrigation_zone_id, 'IRRIGATE', ?, deveui, ?
		FROM devices WHERE deveui=? AND deleted_at IS NULL AND user_id IS NOT NULL AND irrigation_zone_id IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM irrigation_events WHERE action='IRRIGATE' AND valve_deveui=?
			AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.expectation_id')=?)`,
		reason, valveJSON(payload), eui, eui, id)
	return err
}

func appendValveReport(observation *jsvalue.Value, report valveReport, state, reason string, trusted bool, proof jsvalue.Value) {
	p := jsvalue.Property
	stamp := jsvalue.Nil()
	if !report.at.IsZero() {
		stamp = jsvalue.Str(report.recordedAt)
	}
	value := jsvalue.Obj(p("state", jsvalue.Str(state)), p("reported_at", stamp), p("event_identity", report.identity),
		p("trusted", jsvalue.Bool(trusted)), p("proof", proof), p("reason", jsvalue.Str(reason)))
	reports := observation.Get("untrusted_reports").List
	reports = append(reports[max(0, len(reports)-31):], value)
	observation.Set(p("untrusted_reports", jsvalue.Arr(reports...)))
}

func recordUntrustedValveReport(ctx context.Context, tx *farmTx, eui, state, reason string, report valveReport, control, observation jsvalue.Value, clock valveObservationClock) error {
	anchor := valveISO(clock.now)
	proof := clock.proof()
	appendValveReport(&observation, report, state, reason, false, proof)
	attached, fits, err := attachValveUntrustedReport(ctx, tx, eui, state, reason, anchor, report.identity, proof, control)
	if err != nil {
		return err
	}
	if state == "OPEN" && !attached && !observation.Get("physical_run_id").Truthy() {
		unattributed := "no_owner"
		if fits > 1 {
			unattributed = "ambiguous_owner"
		}
		id, err := insertReportedValveRun(ctx, tx, eui, anchor, jsvalue.Nil(), jsvalue.Nil(), jsvalue.Str(reason), unattributed)
		if err != nil {
			return err
		}
		observation.Set(jsvalue.Property("physical_run_id", jsvalue.Str(id)))
	}
	if state == "OPEN" && !attached {
		if err := observeValveIncident(ctx, tx, eui, &control, observation.Get("physical_run_id").MustString(), anchor); err != nil {
			return err
		}
	}
	return writeValveObservation(ctx, tx, eui, state, anchor, control, observation)
}

func attachValveUntrustedReport(ctx context.Context, tx *farmTx, eui, state, reason, anchor string, identity, proof, control jsvalue.Value) (bool, int, error) {
	conditional, err := valveConditionallyConfigured(ctx, tx, eui, control)
	if err != nil || conditional {
		return false, 0, err
	}
	var current sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT current_state FROM devices WHERE deveui=?", eui).Scan(&current); err != nil {
		return false, 0, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT expectation_id, transport_json FROM valve_actuation_expectations e
		WHERE UPPER(device_eui)=? AND command_id IS NOT NULL AND reconciliation_state='PENDING_OBSERVATION'
		AND observed_open_at IS NULL AND commanded_duration_seconds>0
		AND NOT EXISTS (SELECT 1 FROM irrigation_occurrences o WHERE UPPER(o.device_eui)=? AND o.command_id=e.command_id)
		ORDER BY rowid`, eui, eui)
	if err != nil {
		return false, 0, err
	}
	defer rows.Close()
	type owner struct {
		id        string
		transport jsvalue.Value
	}
	var running, unopened []owner
	for rows.Next() {
		var id string
		var raw sql.NullString
		if err := rows.Scan(&id, &raw); err != nil {
			return false, 0, err
		}
		transport, err := valveStoredJSON(raw.String)
		if err != nil || transport.Get("effect_snapshot").Get("effect_class").MustString() != "SELF_CLOSING_OPEN" {
			continue
		}
		switch transport.Get("phase").MustString() {
		case "ATTEMPTED", "UNKNOWN", "ACCEPTED":
		default:
			continue
		}
		seen := transport.Get("untrusted_report")
		if seen.Get("closed").Truthy() {
			continue
		}
		if seen.Get("open").Truthy() {
			running = append(running, owner{id, transport})
		} else {
			unopened = append(unopened, owner{id, transport})
		}
	}
	if err := rows.Err(); err != nil {
		return false, 0, err
	}
	candidates, field := running, "closed"
	if state == "OPEN" {
		if len(running) == 1 {
			return true, 1, nil
		}
		if jsvalue.Upper(current.String) == "OPEN" {
			return false, 0, nil
		}
		candidates, field = unopened, "open"
	}
	if len(candidates) != 1 {
		return false, len(candidates), nil
	}
	sel := candidates[0]
	seen := sel.transport.Get("untrusted_report")
	if seen.Kind != jsvalue.Object {
		seen = jsvalue.Obj()
	}
	seen.Set(jsvalue.Property(field, jsvalue.Obj(
		jsvalue.Property("received_at", jsvalue.Str(anchor)),
		jsvalue.Property("boot_id", proof.Get("boot_id")),
		jsvalue.Property("uptime_ms", proof.Get("uptime_ms")),
		jsvalue.Property("reason", jsvalue.Str(reason)),
		jsvalue.Property("event_identity", identity),
	)))
	sel.transport.Set(jsvalue.Property("untrusted_report", seen))
	_, err = tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
		valveJSON(sel.transport), sel.id)
	return err == nil, 1, err
}
