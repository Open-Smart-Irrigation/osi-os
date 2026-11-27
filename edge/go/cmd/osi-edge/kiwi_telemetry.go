package main

import (
	"context"
	"os"
	"strings"
	"time"

	"osi-edge/internal/ingest"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

func (b *backend) publishKiwiTelemetry(_ context.Context, uplink ingest.Uplink) error {
	if b.cloud == nil {
		return nil
	}
	event, info, err := parseKiwiUplink(uplink)
	if err != nil || !event.Truthy() {
		return err
	}
	profileID, profileName := info.Get("deviceProfileId"), info.Get("deviceProfileName")
	kiwiLike := isKiwiProfile(profileID, profileName)
	if !kiwiLike {
		id := jsvalue.Trim(profileID.OrEmpty().MustString())
		name := jsvalue.Upper(profileName.OrEmpty().MustString())
		// These recognized profiles have separate branches in Build Telemetry.
		if matchesProfileID(id, "CHIRPSTACK_PROFILE_SDI12", "CHIRPSTACK_PROFILE_LSN50",
			"CHIRPSTACK_PROFILE_STREGA", "CHIRPSTACK_PROFILE_STREGA_GEN2") ||
			strings.Contains(name, "SDI-12") || strings.Contains(name, "SDI12") ||
			strings.Contains(name, "LSN50") || strings.Contains(name, "DRAGINO") ||
			strings.Contains(name, "STREGA") {
			return nil
		}
	}
	decoded := event.Get("object")
	wm1 := kiwiTelemetryKPa(decoded, "swt_wm1", "watermark1_frequency")
	wm2 := kiwiTelemetryKPa(decoded, "swt_wm2", "watermark2_frequency")
	if !kiwiLike && wm1.Kind == jsvalue.Null && wm2.Kind == jsvalue.Null {
		return nil
	}
	topic, value := kiwiTelemetry(event, info, uplink.Received, wm1, wm2)
	payload, err := jsvalue.Stringify(value)
	if err != nil {
		return err
	}
	return b.cloud.Publish(topic, payload)
}

func kiwiTelemetry(event, info jsvalue.Value, now time.Time, wm1, wm2 jsvalue.Value) (string, jsvalue.Value) {
	gateway := os.Getenv("DEVICE_EUI")
	if gateway == "" {
		gateway = "UNKNOWN"
	}
	gateway = jsvalue.Upper(jsvalue.Trim(gateway))
	sensor := info.Get("devEui")
	if !sensor.Truthy() {
		sensor = jsvalue.Str(gateway)
	}
	stamp := event.Get("time")
	if !stamp.Truthy() {
		stamp = jsvalue.Str(jsdate.ISOString(now))
	}
	decoded := event.Get("object")
	light := decoded.Get("light_intensity")
	if light.Kind == jsvalue.Undefined || light.Kind == jsvalue.Null {
		light = decoded.Get("light_lux")
	}
	fields := []jsvalue.Field{
		jsvalue.Property("deviceEui", jsvalue.Str(jsvalue.Upper(jsvalue.Trim(sensor.MustString())))),
		jsvalue.Property("deviceType", jsvalue.Str("KIWI_SENSOR")),
		jsvalue.Property("timestamp", stamp),
		jsvalue.Property("swt_wm1", wm1),
		jsvalue.Property("swt_wm2", wm2),
		jsvalue.Property("light_lux", kiwiNullIfAbsent(light)),
		jsvalue.Property("ambient_temperature", kiwiNullIfAbsent(decoded.Get("ambient_temperature"))),
		jsvalue.Property("relative_humidity", kiwiNullIfAbsent(decoded.Get("relative_humidity"))),
	}
	for _, name := range []string{
		"ext_temperature_c", "bat_v", "adc_ch0v", "adc_ch1v", "dendro_ratio", "dendro_mode_used",
		"dendro_position_raw_mm", "dendro_position_mm", "dendro_delta_mm", "dendro_stem_change_um", "dendro_valid",
	} {
		fields = append(fields, jsvalue.Property(name, jsvalue.Nil()))
	}
	fields = append(fields, jsvalue.Property("dendro_saturated", jsvalue.Num(0)))
	for _, name := range []string{"dendro_saturation_side", "lsn50_mode_code", "lsn50_mode_label", "lsn50_mode_observed_at"} {
		fields = append(fields, jsvalue.Property(name, jsvalue.Nil()))
	}
	fields = append(fields, jsvalue.Property("chameleon_enabled", jsvalue.Num(0)))
	for _, name := range []string{"chameleon_swt1_depth_cm", "chameleon_swt2_depth_cm", "chameleon_swt3_depth_cm"} {
		fields = append(fields, jsvalue.Property(name, jsvalue.Nil()))
	}
	return "devices/" + gateway + "/telemetry", jsvalue.Obj(fields...)
}

func kiwiTelemetryKPa(decoded jsvalue.Value, valueKey, frequencyKey string) jsvalue.Value {
	if reported := decoded.Get(valueKey); reported.Kind != jsvalue.Undefined && reported.Kind != jsvalue.Null {
		return kiwiFinite(reported)
	}
	// Build Telemetry recognizes only watermark*_frequency. The storage
	// node also understands the legacy input5_frequency and input6_frequency.
	return kiwiKPa(kiwiFinite(decoded.Get(frequencyKey)))
}

func kiwiNullIfAbsent(value jsvalue.Value) jsvalue.Value {
	if value.Kind == jsvalue.Undefined {
		return jsvalue.Nil()
	}
	return value
}
