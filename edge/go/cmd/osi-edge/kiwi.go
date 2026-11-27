package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"time"

	"osi-edge/internal/ingest"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

const (
	kiwiLegacyProfileID   = "ae4194a5-56f8-4ca0-a129-8ad958505e1e"
	cloverLegacyProfileID = "46bdcc01-86db-41bd-bbf8-78cc439edae5"
)

var kiwiTimestampFloor = time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC)

// The history lane calls this handler serially in broker arrival order.
type kiwiIngest struct{}

func parseKiwiUplink(uplink ingest.Uplink) (event, info jsvalue.Value, err error) {
	event, err = jsvalue.Parse(uplink.Payload)
	if err != nil {
		return event, info, fmt.Errorf("parse uplink: %w", err)
	}
	info = event.Get("deviceInfo")
	application := jsvalue.Lower(jsvalue.Trim(info.Get("applicationId").OrEmpty().MustString()))
	if testerApp := jsvalue.Lower(jsvalue.Trim(os.Getenv("CHIRPSTACK_APP_FIELD_TESTER"))); testerApp != "" && testerApp == application {
		return jsvalue.Value{}, jsvalue.Value{}, nil
	}
	return event, info, nil
}

func (k *kiwiIngest) handle(b *backend, ctx context.Context, uplink ingest.Uplink) error {
	event, info, err := parseKiwiUplink(uplink)
	if err != nil || !event.Truthy() {
		return err
	}
	// The storage node also recognizes top-level profile fields. Build
	// Telemetry uses deviceInfo alone, so its profile check is separate.
	profileID := kiwiFirstPresent(info.Get("deviceProfileId"), event.Get("deviceProfileId"))
	profileName := kiwiFirstPresent(info.Get("deviceProfileName"), event.Get("deviceProfileName"))

	if !isKiwiProfile(profileID, profileName) {
		return nil
	}
	return k.store(b, ctx, event, info, time.Now())
}

func isKiwiProfile(id, name jsvalue.Value) bool {
	profileID := jsvalue.Trim(id.OrEmpty().MustString())
	profileName := jsvalue.Upper(name.OrEmpty().MustString())
	return profileID == kiwiLegacyProfileID || profileID == cloverLegacyProfileID ||
		matchesProfileID(profileID, "CHIRPSTACK_PROFILE_KIWI", "CHIRPSTACK_PROFILE_CLOVER") ||
		strings.Contains(profileName, "KIWI") || strings.Contains(profileName, "CLOVER")
}

func matchesProfileID(id string, envKeys ...string) bool {
	if id != "" {
		for _, key := range envKeys {
			if id == jsvalue.Trim(os.Getenv(key)) {
				return true
			}
		}
	}
	return false
}

func (k *kiwiIngest) store(b *backend, ctx context.Context, event, info jsvalue.Value, now time.Time) error {
	decoded := event.Get("object")
	if !decoded.Truthy() {
		return errors.New("unexpected payload structure")
	}
	rawEUI := kiwiFirstPresent(info.Get("devEui"), event.Get("devEui"), event.Get("dev_eui"))
	if !rawEUI.Truthy() {
		return errors.New("missing devEui in payload")
	}

	eui := jsvalue.Upper(jsvalue.Trim(rawEUI.MustString()))
	key := ingest.EventKey("kiwi", event)
	if b.dedup.IsDuplicate("kiwi", event, eui, now.UnixMilli()) {
		return nil
	}

	stamp := now
	if value := event.Get("time"); value.Truthy() {
		var valid bool
		stamp, valid = ingest.EventTime(value)
		if !valid {
			return errors.New("invalid uplink time")
		}
	}
	if eui == "" {
		return errors.New("empty devEui after normalization")
	}
	if stamp.Before(kiwiTimestampFloor) || stamp.After(now.Add(time.Hour)) {
		log.Printf("ingest kiwi: timestamp_clamped: %s to %s", jsdate.ISOString(stamp), jsdate.ISOString(now))
		stamp = now
	}

	rawWM1 := kiwiFirstPresent(decoded.Get("watermark1_frequency"), decoded.Get("input5_frequency"))
	rawWM2 := kiwiFirstPresent(decoded.Get("watermark2_frequency"), decoded.Get("input6_frequency"))
	light, temperature, humidity := decoded.Get("light_intensity"), decoded.Get("ambient_temperature"), decoded.Get("relative_humidity")

	wm1, wm2 := kiwiKPa(kiwiFinite(rawWM1)), kiwiKPa(kiwiFinite(rawWM2))
	// Keep the partial-index conflict target and let the existing FK and
	// triggers govern unknown devices and outbox writes.
	b.writes.RLock()
	defer b.writes.RUnlock()
	_, err := b.db.ExecContext(ctx, `
		INSERT INTO device_data (
			deveui, swt_wm1, swt_wm2, swt_1, swt_2, light_lux,
			ambient_temperature, relative_humidity, recorded_at, uplink_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(deveui, uplink_key) WHERE uplink_key IS NOT NULL DO NOTHING`,
		eui, kiwiSQLNumber(wm1), kiwiSQLNumber(wm2), kiwiSQLNumber(wm1), kiwiSQLNumber(wm2),
		kiwiSQLNumber(kiwiFinite(light)),
		kiwiSQLNumber(kiwiFinite(temperature)),
		kiwiSQLNumber(kiwiFinite(humidity)),
		jsdate.ISOString(stamp), kiwiSQLKey(key))
	return err
}

func kiwiFirstPresent(values ...jsvalue.Value) jsvalue.Value {
	for _, value := range values {
		if value.Kind != jsvalue.Undefined && value.Kind != jsvalue.Null &&
			(value.Kind != jsvalue.String || len(value.Text) > 0) {
			return value
		}
	}
	return jsvalue.Nil()
}

func kiwiFinite(value jsvalue.Value) jsvalue.Value {
	if kiwiFirstPresent(value).Kind == jsvalue.Null {
		return jsvalue.Nil()
	}
	n := value.MustNumber()
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return jsvalue.Nil()
	}
	return jsvalue.Num(n)
}

func kiwiKPa(frequency jsvalue.Value) jsvalue.Value {
	if frequency.Kind != jsvalue.Number {
		return jsvalue.Nil()
	}
	hz := frequency.Num
	switch {
	case hz > 6430:
		return jsvalue.Num(0)
	case hz >= 4330:
		return kiwiSegment(hz, 4330, 9, .004286)
	case hz >= 2820:
		return kiwiSegment(hz, 2820, 15, .003974)
	case hz >= 1110:
		return kiwiSegment(hz, 1110, 35, .01170)
	case hz >= 770:
		return kiwiSegment(hz, 770, 55, .05884)
	case hz >= 600:
		return kiwiSegment(hz, 600, 75, .1176)
	case hz >= 485:
		return kiwiSegment(hz, 485, 100, .2174)
	case hz >= 293:
		return kiwiSegment(hz, 293, 200, .5208)
	default:
		return jsvalue.Num(200)
	}
}

func kiwiSegment(hz, minHz, maxKPa, slope float64) jsvalue.Value {
	// Round the product as JS does before subtracting on FMA-capable CPUs.
	return jsvalue.Num(maxKPa - float64((hz-minHz)*slope))
}

func kiwiSQLNumber(value jsvalue.Value) any {
	if value.Kind == jsvalue.Null {
		return nil
	}
	// The shipped flow inserts JS decimal literals; bind what SQLite makes of
	// the same literal text on the gateway.
	return sqliteNumberLiteral(value.MustNumber())
}

func kiwiSQLKey(key string) any {
	if key == "" {
		return nil
	}
	return key
}
