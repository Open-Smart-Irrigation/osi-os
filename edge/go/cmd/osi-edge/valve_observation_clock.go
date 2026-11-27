package main

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"
	"time"

	"osi-edge/internal/jsvalue"
)

type valveObservationClock struct {
	now     time.Time
	receipt valveClockReceipt
	marker  jsvalue.Value
	reason  string
}

func (b *backend) checkValveObservationClock() valveObservationClock {
	clock := valveObservationClock{now: time.Now(), receipt: readValveReceipt(), reason: "trusted"}
	if b.testHooks {
		return clock
	}

	path := imagePath("/var/run/osi-irrigation-clock.json")
	data, err := os.ReadFile(path)
	marker, parseErr := jsvalue.Parse(data)
	switch {
	case err != nil || parseErr != nil || marker.Kind != jsvalue.Object:
		clock.reason = "clock_untrusted_missing_marker"
	case clock.receipt.bootID == "" || marker.Get("boot_id").MustString() != clock.receipt.bootID:
		clock.reason = "clock_untrusted_boot"
	default:
		clock.marker = marker
		epoch, uptime, stratum := marker.Get("epoch_ms"), marker.Get("uptime_ms"), marker.Get("stratum")
		if !valveWhole(epoch, -9007199254740991, 9007199254740991) ||
			!valveWhole(uptime, -9007199254740991, 9007199254740991) || !valveWhole(stratum, 1, 15) {
			clock.reason = "clock_untrusted_marker"
			return clock
		}
		signature := strings.Join([]string{clock.receipt.bootID, epoch.MustString(), uptime.MustString(), stratum.MustString()}, "|")
		for _, rejectionPath := range []string{imagePath("/var/run/osi-irrigation-clock-rejection.json"), path + ".rejected.json"} {
			raw, err := os.ReadFile(rejectionPath)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			rec, parseErr := jsvalue.Parse(raw)
			if err != nil || parseErr != nil || rec.Get("boot_id").Kind != jsvalue.String ||
				!rec.Get("boot_id").Truthy() || rec.Get("marker").Kind != jsvalue.String || !rec.Get("marker").Truthy() ||
				(rec.Get("reason").MustString() != "clock_untrusted_backward" && rec.Get("reason").MustString() != "clock_untrusted_jump") {
				clock.reason = "clock_untrusted_persistence"
				return clock
			}
			if rec.Get("boot_id").MustString() == clock.receipt.bootID && rec.Get("marker").MustString() == signature {
				clock.reason = "clock_untrusted_invalidated"
			}
		}
		if clock.reason != "trusted" {
			return clock
		}
		elapsed := float64(clock.now.UnixMilli()) - epoch.Num
		uptimeElapsed := float64(clock.receipt.uptimeMS) - uptime.Num
		if elapsed < 0 {
			clock.reason = "clock_untrusted_backward"
		} else if uptimeElapsed < 0 || math.Abs(elapsed-uptimeElapsed) > 5000 {
			clock.reason = "clock_untrusted_jump"
		}
	}
	return clock
}

func (clock valveObservationClock) trusted(at time.Time) bool {
	return clock.reason == "trusted" && !at.IsZero() && !at.After(clock.now)
}

func (clock valveObservationClock) proof() jsvalue.Value {
	if clock.receipt.bootID == "" {
		return jsvalue.Nil()
	}
	return jsvalue.Obj(append([]jsvalue.Field{jsvalue.Property("checked_at", jsvalue.Str(valveISO(clock.now)))}, clock.receipt.fields()...)...)
}

func (b *backend) observeValveCloseEvidence(ctx context.Context, eui string, report valveReport, clock valveObservationClock) error {
	if clock.receipt.bootID == "" {
		return nil
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := queryZones(ctx, tx, `SELECT expectation_id,commanded_at,transport_json FROM valve_actuation_expectations
		WHERE UPPER(device_eui)=? ORDER BY rowid`, eui)
	if err != nil {
		return err
	}
	p := jsvalue.Property
	evidence := jsvalue.Obj(p("observed_state", jsvalue.Str("CLOSED")), p("observed_at", jsvalue.Str(report.recordedAt)),
		p("receipt", jsvalue.Obj(clock.receipt.fields()...)), p("event_identity", report.identity))
	for _, row := range rows {
		transport, err := valveStoredJSON(row.Get("transport_json").OrEmpty().MustString())
		if err != nil {
			return err
		}
		if !valveCloseEvidenceFits(row, transport, report.at, clock) {
			continue
		}
		transport.Set(p("closed_observation", evidence))
		if _, err := tx.ExecContext(ctx, `UPDATE valve_actuation_expectations
			SET observed_close_at=?,reconciliation_state='OBSERVED_CLOSED',transport_json=? WHERE expectation_id=?`,
			report.recordedAt, valveJSON(transport), row.Get("expectation_id").MustString()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func valveCloseEvidenceFits(row, transport jsvalue.Value, reported time.Time, clock valveObservationClock) bool {
	snapshot := transport.Get("effect_snapshot")
	if snapshot.Get("effect_class").MustString() != "CLOSE_ONLY" {
		return false
	}
	prior := transport.Get("attempt_receipt")
	if prior.Truthy() && (prior.Get("boot_id").MustString() != clock.receipt.bootID ||
		float64(clock.receipt.uptimeMS) < prior.Get("uptime_ms").MustNumber()) {
		return false
	}
	trustedAt := transport.Get("attempt_trusted_at")
	if snapshot.Get("timing_contract").MustString() == "UNBOUNDED_SAFE_CLOSE_V1" {
		if !prior.Truthy() {
			return false
		}
		if !trustedAt.Truthy() {
			epoch, uptime := clock.marker.Get("epoch_ms"), clock.marker.Get("uptime_ms")
			return clock.marker.Get("boot_id").MustString() == clock.receipt.bootID &&
				valveWhole(epoch, -9007199254740991, 9007199254740991) && valveWhole(uptime, 0, 9007199254740991) &&
				uptime.Num >= prior.Get("uptime_ms").MustNumber() && reported.UnixMilli() >= int64(epoch.Num)
		}
	} else if !trustedAt.Truthy() && !transport.Get("attempted_at").Truthy() && !prior.Truthy() {
		return false
	}
	at := zoneFallback(trustedAt, zoneFallback(transport.Get("attempted_at"), row.Get("commanded_at")))
	attempted := valveInstant(at.MustString())
	return !attempted.IsZero() && !reported.Before(attempted)
}
