package main

import (
	"context"
	"log"
	"regexp"
	"strings"

	"osi-edge/internal/jsvalue"
)

var sdi12Address = regexp.MustCompile(`^[0-9A-Za-z]$`)

func sdi12DiscoveredAddress(value jsvalue.Value) jsvalue.Value {
	address := value.OrEmpty().MustString()
	if !sdi12Address.MatchString(address) {
		return jsvalue.Nil()
	}
	return jsvalue.Str(address)
}

func sdi12Deployment(row jsvalue.Value) jsvalue.Value {
	if nullish(row.Get("sdi12_deployment_status")).Kind == jsvalue.Null {
		return jsvalue.Nil()
	}
	prop := jsvalue.Property
	fields := []jsvalue.Field{prop("desired_version", jsvalue.Num(row.Get("sdi12_deployment_desired_version").OrEmpty().MustNumber()))}
	for _, name := range []string{"desired_layout_hash", "status", "queued_at", "queue_drained_at",
		"commissioning_deadline_at", "last_observed_at", "compatible_at", "updated_at"} {
		fields = append(fields, prop(name, orNil(row.Get("sdi12_deployment_"+name))))
	}
	count := jsvalue.Nil()
	recipe := parseJSONObject(row.Get("sdi12_deployment_desired_recipe_json"))
	if frames := recipe.Get("frames"); frames.Kind == jsvalue.Array {
		count = jsvalue.Num(float64(len(frames.List)))
	}
	compatible := row.Get("sdi12_deployment_compatible_recipe_json").Truthy() &&
		row.Get("sdi12_deployment_compatible_layout_json").Truthy()
	return jsvalue.Obj(append(fields,
		prop("frame_count", count),
		prop("compatible_available", jsvalue.Bool(compatible)),
		prop("last_error_code", sdi12StoredError(row.Get("sdi12_deployment_last_error_code"))),
	)...)
}

func sdi12StoredError(value jsvalue.Value) jsvalue.Value {
	code := value.OrEmpty().MustString()
	switch code {
	case "":
		return jsvalue.Nil()
	case "device_queue_not_empty", "queue_delivery_timeout", "queueing_interrupted", "acquisition_observation_failed",
		"chirpstack_cancelled", "chirpstack_unknown", "chirpstack_invalid_argument", "chirpstack_deadline_exceeded",
		"chirpstack_not_found", "chirpstack_already_exists", "chirpstack_permission_denied", "chirpstack_resource_exhausted",
		"chirpstack_failed_precondition", "chirpstack_aborted", "chirpstack_out_of_range", "chirpstack_unimplemented",
		"chirpstack_internal", "chirpstack_unavailable", "chirpstack_data_loss", "chirpstack_unauthenticated":
		return jsvalue.Str(code)
	default:
		return jsvalue.Str("chirpstack_unknown")
	}
}

func (b *backend) enrichWeatherStationZones(ctx context.Context, devices []jsvalue.Value) {
	var indices []int
	var euis []any
	for i := range devices {
		if jsOrText(devices[i].Get("type_id")) == "SENSECAP_S2120" {
			indices = append(indices, i)
			euis = append(euis, jsOrText(devices[i].Get("deveui")))
		}
	}
	if len(euis) == 0 {
		return
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(euis)), ",")
	rows, err := queryValues(ctx, b.db, `SELECT wsz.deveui, wsz.zone_id, iz.name AS zone_name
		FROM weather_station_zones wsz LEFT JOIN irrigation_zones iz ON iz.id=wsz.zone_id
		WHERE wsz.deveui IN (`+placeholders+`)`, euis...)
	if err != nil {
		log.Printf("merge-device-data: weather station zones: %v", err)
	}
	type assignment struct {
		ids   []jsvalue.Value
		names []jsvalue.Value
	}
	byDevice := make(map[string]assignment)
	for _, row := range rows {
		eui := jsOrText(row.Get("deveui"))
		zones := byDevice[eui]
		zones.ids = append(zones.ids, row.Get("zone_id"))
		zones.names = append(zones.names, row.Get("zone_name"))
		byDevice[eui] = zones
	}
	for _, i := range indices {
		device := &devices[i]
		zones := byDevice[jsOrText(device.Get("deveui"))]
		device.Set(jsvalue.Property("zone_ids", jsvalue.Arr(zones.ids...)))
		device.Set(jsvalue.Property("zone_names", jsvalue.Arr(zones.names...)))
	}
}
