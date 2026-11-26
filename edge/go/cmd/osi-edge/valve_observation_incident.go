package main

import (
	"context"

	"github.com/google/uuid"

	"osi-edge/internal/jsvalue"
)

func valveConditionallyConfigured(ctx context.Context, tx *farmTx, eui string, control jsvalue.Value) (bool, error) {
	if control.Get("mode").MustString() == "CONDITIONAL" {
		return true, nil
	}
	var conditional bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM valve_schedules WHERE UPPER(device_eui)=?
		AND enabled=1 AND condition_policy_uuid IS NOT NULL)`, eui).Scan(&conditional)
	return conditional, err
}

func observeValveIncident(ctx context.Context, tx *farmTx, eui string, control *jsvalue.Value, run, at string) error {
	configured, err := valveConditionallyConfigured(ctx, tx, eui, *control)
	if err != nil || !configured {
		return err
	}
	incident := control.Get("incident")
	if incident.Get("physical_run_reference").MustString() == run && incident.Get("state").MustString() != "RECONCILED" {
		return nil
	}
	p := jsvalue.Property
	if incident.Kind != jsvalue.Object {
		incident = jsvalue.Obj()
	}
	for _, field := range []jsvalue.Field{
		p("incident_id", jsvalue.Str(uuid.NewString())), p("physical_run_reference", jsvalue.Str(run)),
		p("ended", jsvalue.Bool(false)), p("ended_at", jsvalue.Nil()), p("reconciled_at", jsvalue.Nil()),
		p("state", jsvalue.Str("OPEN")), p("retry_revision", jsvalue.Nil()), p("created_at", jsvalue.Str(at)),
	} {
		incident.Set(field)
	}
	control.Set(p("incident", incident))
	return nil
}

func reconcileValveIncident(ctx context.Context, tx *farmTx, eui string, control *jsvalue.Value, at string) error {
	revision, incident := control.Get("desired_revision"), control.Get("incident")
	if !revision.Truthy() || incident.Get("state").MustString() != "ENDED" || !incident.Get("ended").Bool ||
		incident.Get("retry_revision").MustString() != revision.MustString() ||
		!incident.Get("physical_run_reference").Truthy() || valveInstant(incident.Get("ended_at").MustString()).IsZero() ||
		valveInstant(at).IsZero() {
		return nil
	}
	ids := control.Get("required_push_ids")
	if len(ids.List) == 0 {
		return nil
	}
	rows, err := requiredPlanRows(ctx, tx, eui, ids)
	if err != nil || len(rows) != len(ids.List) {
		return err
	}
	for _, row := range rows {
		if row.Get("state").MustString() != "ACKED" {
			return nil
		}
	}
	incident.Set(jsvalue.Property("reconciled_at", jsvalue.Str(at)))
	incident.Set(jsvalue.Property("state", jsvalue.Str("RECONCILED")))
	control.Set(jsvalue.Property("incident", incident))
	return nil
}
