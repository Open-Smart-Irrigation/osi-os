package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"osi-edge/internal/jsvalue"
)

type planWindow struct {
	start, end float64
	id, label  jsvalue.Value
}

type valvePlan struct {
	days   [7][]planWindow
	errors []jsvalue.Value
	labels map[string]jsvalue.Value
}

func planStart(value string) (int, bool) {
	if len(value) != 5 || value[2] != ':' {
		return 0, false
	}
	for _, i := range [...]int{0, 1, 3, 4} {
		if value[i] < '0' || value[i] > '9' {
			return 0, false
		}
	}
	hour := int(value[0]-'0')*10 + int(value[1]-'0')
	minute := int(value[3]-'0')*10 + int(value[4]-'0')
	return 60*hour + minute, hour < 24 && minute < 60
}

func (w planWindow) parts() [4]float64 {
	off := math.Mod(w.end, 1440)
	return [4]float64{math.Floor(w.start / 60), math.Mod(w.start, 60), math.Floor(off / 60), math.Mod(off, 60)}
}

func (w planWindow) wire() jsvalue.Value {
	hm := w.parts()
	p := jsvalue.Property
	return jsvalue.Obj(p("onH", jsvalue.Num(hm[0])), p("onM", jsvalue.Num(hm[1])),
		p("offH", jsvalue.Num(hm[2])), p("offM", jsvalue.Num(hm[3])), p("startMin", jsvalue.Num(w.start)),
		p("endMin", jsvalue.Num(w.end)), p("scheduleUuid", w.id), p("label", zoneFallback(w.label, jsvalue.Nil())))
}

func planError(code string, day, count jsvalue.Value, ids ...jsvalue.Value) jsvalue.Value {
	p := jsvalue.Property
	return jsvalue.Obj(p("code", jsvalue.Str(code)), p("weekday", day), p("count", count),
		p("conflicts", jsvalue.Arr(ids...)))
}

func activePlanRow(row jsvalue.Value) bool {
	return row.Get("kind").MustString() == "WEEKLY" && jsvalue.Num(row.Get("enabled").MustNumber()).Truthy() &&
		!row.Get("deleted_at").Truthy()
}

func compileValvePlan(schedules []jsvalue.Value) valvePlan {
	plan := valvePlan{labels: make(map[string]jsvalue.Value)}
	for _, row := range schedules {
		id, label := row.Get("schedule_uuid"), row.Get("label")
		plan.labels[id.MustString()] = label
		if !activePlanRow(row) || row.Get("condition_policy_uuid").Truthy() {
			continue
		}
		start, ok := planStart(row.Get("start_time").OrEmpty().MustString())
		if !ok {
			plan.errors = append(plan.errors, planError("invalid_start_time", jsvalue.Nil(), jsvalue.Value{}, id))
			continue
		}
		mask := int(row.Get("weekdays_mask").MustNumber())
		window := planWindow{start: float64(start), end: float64(start) + row.Get("duration_minutes").MustNumber(),
			id: id, label: label}
		for day := range plan.days {
			if mask&(1<<day) != 0 {
				plan.days[day] = append(plan.days[day], window)
			}
		}
	}
	for d, windows := range plan.days {
		sort.SliceStable(windows, func(i, j int) bool { return windows[i].start < windows[j].start })
		day := jsvalue.Num(float64(d))
		if len(windows) > 4 {
			ids := make([]jsvalue.Value, 0, len(windows))
			for _, w := range windows {
				ids = append(ids, w.id)
			}
			plan.errors = append(plan.errors, planError("too_many_windows", day, jsvalue.Num(float64(len(windows))), ids...))
		}
		for i := 1; i < len(windows); i++ {
			if windows[i].start < windows[i-1].end {
				plan.errors = append(plan.errors, planError("overlap", day, jsvalue.Value{}, windows[i-1].id, windows[i].id))
			}
		}
	}
	for d, windows := range plan.days {
		for _, earlier := range plan.days[(d+6)%7] {
			if earlier.end <= 1440 {
				continue
			}
			for _, w := range windows {
				if w.start < earlier.end-1440 {
					plan.errors = append(plan.errors, planError("overlap", jsvalue.Num(float64(d)), jsvalue.Value{}, earlier.id, w.id))
				}
			}
		}
	}
	return plan
}

func (plan valvePlan) wire() jsvalue.Value {
	days := make([]jsvalue.Value, len(plan.days))
	for i, windows := range plan.days {
		var list []jsvalue.Value
		for _, w := range windows {
			list = append(list, w.wire())
		}
		days[i] = jsvalue.Arr(list...)
	}
	return jsvalue.Obj(jsvalue.Property("days", jsvalue.Arr(days...)),
		jsvalue.Property("errors", jsvalue.Arr(plan.errors...)))
}

func (plan valvePlan) conflict(afterInsert bool) *scheduleError {
	details := make([]jsvalue.Value, 0, len(plan.errors))
	for _, conflict := range plan.errors {
		var labels []jsvalue.Value
		for _, id := range conflict.Get("conflicts").List {
			label, ok := plan.labels[id.MustString()]
			if !ok {
				label = jsvalue.Nil()
			}
			labels = append(labels, label)
		}
		conflict.Set(jsvalue.Property("labels", jsvalue.Arr(labels...)))
		details = append(details, conflict)
	}
	refusal := &scheduleError{status: 422, code: "plan_conflict", details: jsvalue.Arr(details...)}
	if afterInsert {
		refusal.message = "plan_conflict"
	}
	return refusal
}

func planScheduleMode(ctx context.Context, db scheduleQueryer, schedules []jsvalue.Value) (conditionalMode bool, err error) {
	var live, conditional, fixed, ids, unresolved, unresolvedPolicies []jsvalue.Value
	policies := make(map[string]bool)
	unresolvedSeen := make(map[string]bool)
	for _, row := range schedules {
		if !activePlanRow(row) {
			continue
		}
		id, policy := row.Get("schedule_uuid"), row.Get("condition_policy_uuid")
		live = append(live, id)
		if !policy.Truthy() {
			fixed = append(fixed, id)
			continue
		}
		conditional = append(conditional, id)
		key := policy.MustString()
		resolved, checked := policies[key]
		if !checked {
			err := db.QueryRowContext(ctx, "SELECT deleted_at IS NULL FROM irrigation_policies WHERE policy_uuid=?", key).Scan(&resolved)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return false, err
			}
			policies[key] = resolved
			ids = append(ids, jsvalue.Str(key))
		}
		if !resolved {
			unresolved = append(unresolved, id)
			if !unresolvedSeen[key] {
				unresolvedSeen[key] = true
				unresolvedPolicies = append(unresolvedPolicies, jsvalue.Str(key))
			}
		}
	}
	p := jsvalue.Property
	refuse := func(code string, details ...jsvalue.Field) (bool, error) {
		prefix := []jsvalue.Field{p("ok", jsvalue.Bool(false)), p("code", jsvalue.Str(code)), p("status", jsvalue.Num(409))}
		return false, &scheduleError{status: 409, code: code, message: code, details: jsvalue.Obj(append(prefix, details...)...)}
	}
	if len(unresolved) > 0 {
		return refuse("invalid_conditional_policy", p("conflicts", jsvalue.Arr(unresolved...)),
			p("conditional", jsvalue.Arr(conditional...)), p("policyIds", jsvalue.Arr(ids...)),
			p("unresolvedPolicies", jsvalue.Arr(unresolvedPolicies...)))
	}
	if len(conditional) > 0 && (len(fixed) > 0 || len(ids) > 1) {
		return refuse("mixed_schedule_mode", p("conflicts", jsvalue.Arr(live...)), p("fixed", jsvalue.Arr(fixed...)),
			p("conditional", jsvalue.Arr(conditional...)), p("policyIds", jsvalue.Arr(ids...)))
	}
	return len(conditional) > 0, nil
}

type planPush struct {
	purpose string
	day     any
	port    uint32
	data    []byte
	hash    any
}

func planHash(windows []planWindow) string {
	names := make([]string, 0, len(windows))
	for _, window := range windows {
		parts := window.parts()
		names = append(names, fmt.Sprintf("%s:%s:%s:%s", jsvalue.Num(parts[0]).MustString(),
			jsvalue.Num(parts[1]).MustString(), jsvalue.Num(parts[2]).MustString(), jsvalue.Num(parts[3]).MustString()))
	}
	sort.Strings(names)
	sum := sha1.Sum([]byte(strings.Join(names, "|")))
	return hex.EncodeToString(sum[:])
}

func weekdayFrames(days [7][]planWindow, generation string, prefix bool) []planPush {
	bcd := func(n float64) byte {
		return (byte(math.Floor(n/10))&0x0f)<<4 | byte(math.Mod(n, 10))
	}
	var pushes []planPush
	if generation != "GEN2" {
		for d, windows := range days {
			data := bytes.Repeat([]byte{0xff}, 24)
			for i, w := range windows[:min(4, len(windows))] {
				hm := w.parts()
				copy(data[i*6:], []byte{0xff, 0x80 | bcd(hm[0]), bcd(hm[1]), 0xff, bcd(hm[2]), bcd(hm[3])})
			}
			pushes = append(pushes, planPush{"WEEKDAY_PLAN", d, uint32(14 + d), data, planHash(windows)})
		}
		return pushes
	}
	if prefix {
		pushes = append(pushes, planPush{"DAYMASK_PLAN", nil, 25, []byte{0x80}, planHash(nil)})
	}
	groups := make(map[string]int)
	for d, windows := range days {
		if prefix && len(windows) == 0 {
			continue
		}
		hash := planHash(windows)
		if j, ok := groups[hash]; ok {
			pushes[j].data[0] |= 1 << d
			continue
		}
		data := []byte{1 << d}
		for _, w := range windows[:min(4, len(windows))] {
			hm := w.parts()
			data = append(data, 0x80|bcd(hm[0]), bcd(hm[1]), bcd(hm[2]), bcd(hm[3]))
		}
		groups[hash] = len(pushes)
		pushes = append(pushes, planPush{"DAYMASK_PLAN", nil, 25, data, hash})
	}
	for i := range pushes {
		if pushes[i].data[0] == 0x7f {
			pushes[i].data[0] = 0x80
		}
	}
	return pushes
}

type planWriter interface {
	scheduleQueryer
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertPlanPushes(ctx context.Context, tx planWriter, eui string, pushes []planPush, transport jsvalue.Value) ([]jsvalue.Value, error) {
	ids := make([]jsvalue.Value, 0, len(pushes))
	var raw any
	if transport.Kind != jsvalue.Undefined {
		raw = valveJSON(transport)
	}
	for _, push := range pushes {
		id := uuid.NewString()
		_, err := tx.ExecContext(ctx, `INSERT INTO valve_schedule_pushes
			(push_id,device_eui,purpose,weekday,fport,payload_hex,plan_hash,transport_json) VALUES (?,?,?,?,?,?,?,?)`,
			id, eui, push.purpose, push.day, push.port, jsvalue.Upper(hex.EncodeToString(push.data)), push.hash, raw)
		if err != nil {
			return nil, err
		}
		ids = append(ids, jsvalue.Str(id))
	}
	return ids, nil
}

func invalidatePlanLifecycle(ctx context.Context, tx *farmTx, eui string, now time.Time) error {
	control, err := loadValveControl(ctx, tx, eui)
	if err != nil {
		return err
	}
	if err := validatePlanControl(control); err != nil {
		return err
	}
	if control.Get("mode").MustString() != "LIFECYCLE_CLEAR" {
		return nil
	}
	p := jsvalue.Property
	lifecycle := control.Get("lifecycle_clear")
	lifecycle.Set(p("state", jsvalue.Str("SUPERSEDED")))
	lifecycle.Set(p("superseded_at", jsvalue.Str(valveISO(now))))
	lifecycle.Set(p("superseded_reason", jsvalue.Str("schedule_changed")))
	control.Set(p("lifecycle_clear", lifecycle))
	setFixedPlanMode(&control, "lifecycle_clear_superseded")
	return writePlanControl(ctx, tx, eui, control)
}

var errPlanControlMalformed = errors.New("conditional_control_malformed")

// errPlanIncidentMalformed is store.js parseIncident's throw, which
// parseControl raises for every caller. It is a malformed control
// (errors.Is) with parseIncident's own message.
var errPlanIncidentMalformed error = planIncidentError{}

type planIncidentError struct{}

func (planIncidentError) Error() string        { return "conditional_incident_malformed" }
func (planIncidentError) Is(target error) bool { return target == errPlanControlMalformed }

// validPlanIncident is store.js parseIncident: null passes; otherwise a plain
// object with non-empty string incident_id and physical_run_reference, a
// boolean ended, state OPEN, ENDED or RECONCILED with ended exactly when the
// state is not OPEN, an ended_at that parseAckInstant reads when ended, a
// reconciled_at that is null or readable, and a retry_revision that is null or
// a string with non-blank text.
func validPlanIncident(value jsvalue.Value) bool {
	if value.Kind == jsvalue.Null || value.Kind == jsvalue.Undefined {
		return true
	}
	if value.Kind != jsvalue.Object {
		return false
	}
	id, ref, ended, state := value.Get("incident_id"), value.Get("physical_run_reference"), value.Get("ended"), value.Get("state")
	if id.Kind != jsvalue.String || len(id.Text) == 0 || ref.Kind != jsvalue.String || len(ref.Text) == 0 {
		return false
	}
	if ended.Kind != jsvalue.Boolean || !claimOneOf(state, "OPEN", "ENDED", "RECONCILED") {
		return false
	}
	readable := func(v jsvalue.Value) bool {
		if v.Kind != jsvalue.String {
			return false
		}
		_, ok := valveAckInstant(v.MustString())
		return ok
	}
	if ended.Bool && !readable(value.Get("ended_at")) {
		return false
	}
	if at := value.Get("reconciled_at"); at.Kind != jsvalue.Null && at.Kind != jsvalue.Undefined && !readable(at) {
		return false
	}
	if retry := value.Get("retry_revision"); retry.Kind != jsvalue.Null && retry.Kind != jsvalue.Undefined &&
		(retry.Kind != jsvalue.String || !retry.TrimmedString().Truthy()) {
		return false
	}
	return ended.Bool == (state.MustString() != "OPEN")
}

func validatePlanControl(control jsvalue.Value) error {
	if control.Kind != jsvalue.Object {
		return errPlanControlMalformed
	}
	for _, key := range []string{"flushes", "opaque", "required_push_ids", "predecessor_push_ids"} {
		v := control.Get(key)
		if v.Kind != jsvalue.Undefined && v.Kind != jsvalue.Array {
			return errPlanControlMalformed
		}
		if key == "required_push_ids" || key == "predecessor_push_ids" {
			for _, id := range v.List {
				if id.Kind != jsvalue.String || !id.Truthy() {
					return errPlanControlMalformed
				}
			}
		}
	}
	if v := control.Get("readiness"); v.Kind != jsvalue.Undefined && v.Kind != jsvalue.Object {
		return errPlanControlMalformed
	}
	if incident := control.Get("incident"); incident.Kind != jsvalue.Undefined && !validPlanIncident(incident) {
		return errPlanIncidentMalformed
	}
	lifecycle := control.Get("lifecycle_clear")
	if lifecycle.Kind != jsvalue.Undefined && !validValveLifecycle(lifecycle) {
		return errPlanControlMalformed
	}
	if control.Get("mode").MustString() == "LIFECYCLE_CLEAR" &&
		(lifecycle.Kind != jsvalue.Object || !valveEffectValuesEqual(control.Get("desired_revision"), lifecycle.Get("revision"))) {
		return errPlanControlMalformed
	}
	return nil
}

func setFixedPlanMode(control *jsvalue.Value, reason string) {
	p := jsvalue.Property
	control.Set(p("mode", jsvalue.Str("FIXED")))
	control.Set(p("desired_revision", jsvalue.Nil()))
	control.Set(p("required_push_ids", jsvalue.Arr()))
	control.Set(p("predecessor_push_ids", jsvalue.Arr()))
	control.Set(p("readiness", jsvalue.Obj(p("state", jsvalue.Str("INVALID")), p("reason", jsvalue.Str(reason)))))
}

func writePlanControl(ctx context.Context, tx planWriter, eui string, control jsvalue.Value) error {
	if err := validatePlanControl(control); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)
		ON CONFLICT(device_eui) DO UPDATE SET conditional_control_json=excluded.conditional_control_json,
		updated_at=datetime('now')`, eui, valveJSON(control))
	return err
}

func (b *backend) invalidateFixedTransition(ctx context.Context, eui, fallback string, control *jsvalue.Value, now time.Time) error {
	transition := control.Get("fixed_generation_transition")
	if !pendingFixedValveTransition(transition) || !preparedFixedValveTransition(transition) {
		return nil
	}
	schedules, err := queryZones(ctx, b.db, planRowsSQL, eui)
	if err != nil {
		return err
	}
	if sameFixedValveSnapshot(transition, schedules, fallback) {
		return nil
	}
	supersedeFixedValveTransition(control, now)
	return b.savePlanControl(ctx, eui, *control)
}

func fixedValveSnapshot(schedules []jsvalue.Value, fallback string) jsvalue.Value {
	p := jsvalue.Property
	var active []jsvalue.Value
	var firstTimezone jsvalue.Value
	for _, row := range schedules {
		zone := row.Get("timezone")
		if zone.Truthy() && !firstTimezone.Truthy() {
			firstTimezone = zone
		}
		if !activePlanRow(row) {
			continue
		}
		active = append(active, jsvalue.Obj(
			p("schedule_uuid", row.Get("schedule_uuid")), p("kind", row.Get("kind")),
			p("weekdays_mask", row.Get("weekdays_mask")), p("start_time", row.Get("start_time")),
			p("duration_minutes", row.Get("duration_minutes")), p("timezone", zone),
			p("enabled", jsvalue.Num(row.Get("enabled").MustNumber())),
			p("effective_from", zoneFallback(row.Get("effective_from"), jsvalue.Nil())),
			p("condition_policy_uuid", zoneFallback(row.Get("condition_policy_uuid"), jsvalue.Nil()))))
	}
	timezone := zoneFallback(firstTimezone, zoneFallback(jsvalue.Str(fallback), jsvalue.Str("UTC")))
	for _, row := range active {
		if zone := row.Get("timezone"); zone.Truthy() {
			timezone = zone
			break
		}
	}
	// .sort((a, b) => String(a.schedule_uuid).localeCompare(String(b.schedule_uuid))),
	// the comparator of lifecycleScheduleSort.
	lifecycleScheduleSort(active)
	// push.js resolvedClockTimezone is String(timezone || fallback || 'UTC'),
	// and fixedScheduleSnapshot writes String(that || 'UTC'): a Buffer
	// timezone is stored as its decoded text, an empty one as 'UTC'.
	clock := storedOfJS(timezone).jsString()
	if clock == "" {
		clock = "UTC"
	}
	return jsvalue.Obj(p("schedules", jsvalue.Arr(active...)), p("clock_timezone", jsvalue.Str(clock)))
}

func sameFixedValveSnapshot(transition jsvalue.Value, schedules []jsvalue.Value, fallback string) bool {
	stored := transition.Get("source_schedule_snapshot")
	return stored.Kind == jsvalue.Object && valveJSON(stored) == valveJSON(fixedValveSnapshot(schedules, fallback))
}

func supersedeFixedValveTransition(control *jsvalue.Value, now time.Time) {
	p := jsvalue.Property
	transition := control.Get("fixed_generation_transition")
	transition.Set(p("state", jsvalue.Str("SUPERSEDED")))
	transition.Set(p("superseded_at", jsvalue.Str(valveISO(now))))
	transition.Set(p("superseded_reason", jsvalue.Str("source_schedule_changed")))
	control.Set(p("fixed_generation_transition", transition))
}
