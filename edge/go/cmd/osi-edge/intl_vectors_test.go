package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jstimezone"
)

// The gateway guest's edge/vectors/generate-intl.js output; OSI_INTL_VECTORS
// points at another run.
func intlVectorsPath() string {
	if p := os.Getenv("OSI_INTL_VECTORS"); p != "" {
		return p
	}
	return "../../../vectors/intl-gateway.vectors.json"
}

// The process-zone rows of every gateway run: the emulator guest (with
// /etc/TZ rows; boot clock, in April), its repeats with the guest clock in
// July and in January, and the Pi 5 board.
func intlGatewayRuns() []string {
	if p := os.Getenv("OSI_INTL_VECTORS"); p != "" {
		return []string{p}
	}
	return append(intlGuestRuns(), "../../../vectors/intl-pi5.vectors.json")
}

// The emulator guest's three passes of one boot.
func intlGuestRuns() []string {
	return []string{"../../../vectors/intl-gateway.vectors.json", "../../../vectors/intl-gateway-summer.vectors.json",
		"../../../vectors/intl-gateway-winter.vectors.json"}
}

// One child node's view of its process zone (generate-intl.js PROCESS_PROBE).
type intlProbe struct {
	Error    string         `json:"error"`
	Resolved string         `json:"resolved"`
	Rows     [][]any        `json:"rows"` // [ms, getTimezoneOffset, toString, toTimeString, toLocaleString, getHours, getDate]
	Parse    map[string]any `json:"parse"`
	Local    []float64      `json:"local_ctor"`
}

type intlVectors struct {
	Sections struct {
		Facts struct {
			Versions map[string]string `json:"versions"`
			Arch     string            `json:"arch"`
			EtcTZ    any               `json:"etc_TZ"`
		} `json:"facts"`
		DateTimeFormat struct {
			Instants []float64 `json:"instants"`
			Formats  map[string]struct {
				Rows []struct {
					Zone          string   `json:"zone"`
					Error         string   `json:"error"`
					ResolvedZone  string   `json:"resolved_zone"`
					ResolvedLocal string   `json:"resolved_locale"`
					Values        []string `json:"values"`
				} `json:"rows"`
			} `json:"formats"`
		} `json:"date_time_format"`
		ProcessZoneEnv []struct {
			TZ     *string   `json:"TZ"`
			Result intlProbe `json:"result"`
		} `json:"process_zone_env"`
		ProcessZoneEtcTZ json.RawMessage `json:"process_zone_etc_tz"`
	} `json:"sections"`
}

func loadIntlVectors(t *testing.T) intlVectors { return loadIntlVectorsFile(t, intlVectorsPath()) }

func loadIntlVectorsFile(t *testing.T, path string) intlVectors {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v intlVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func intlParts(text string) map[string]string {
	parts := map[string]string{}
	for _, p := range strings.Split(text, "|") {
		k, v, _ := strings.Cut(p, "=")
		if k != "literal" {
			parts[k] = v
		}
	}
	return parts
}

func yearOfEra(t time.Time) int {
	if y := t.Year(); y <= 0 {
		return 1 - y
	} else {
		return y
	}
}

// Every Intl.DateTimeFormat the Go port copies takes its fields from
// formatToParts; Go reads them from time.In(jstimezone.Location(zone)).
func TestIntlDateTimeFormatPartsMatchGateway(t *testing.T) {
	v := loadIntlVectors(t).Sections.DateTimeFormat
	ported := map[string]bool{
		"plan.js buildFormatter": true, "zone-config-fn zoneLocalToday": true, "merge-device-data rain_day": true,
		"osi-rain date": true, "osi-rain dateTime": true,
	}
	checked := 0
	for label, format := range v.Formats {
		if !ported[label] {
			continue
		}
		for _, row := range format.Rows {
			if row.Error != "" {
				if jstimezone.Canonical(row.Zone) != "" {
					t.Errorf("%s %s: gateway refuses the zone (%s), Go accepts it", label, row.Zone, row.Error)
				}
				continue
			}
			if got := jstimezone.Canonical(row.Zone); got != row.ResolvedZone {
				t.Errorf("%s %s: canonical %q, gateway %q", label, row.Zone, got, row.ResolvedZone)
			}
			loc := jstimezone.Location(row.Zone)
			for i, ms := range v.Instants {
				parts := intlParts(row.Values[i])
				local := time.UnixMilli(int64(ms)).In(loc)
				want := map[string]string{
					"year": strconv.Itoa(yearOfEra(local)), "month": fmt.Sprintf("%02d", int(local.Month())),
					"day": fmt.Sprintf("%02d", local.Day()),
				}
				if hour, ok := parts["hour"]; ok {
					// osi-rain's hour12: false resolves hourCycle h24 and renders
					// midnight as "24"; every consumer reads Number(hour) % 24.
					want["hour"] = fmt.Sprintf("%02d", local.Hour())
					if n, err := strconv.Atoi(hour); err == nil && n == 24 && local.Hour() == 0 {
						want["hour"] = hour
					}
					want["minute"] = fmt.Sprintf("%02d", local.Minute())
					want["second"] = fmt.Sprintf("%02d", local.Second())
				}
				if _, ok := parts["weekday"]; ok {
					want["weekday"] = local.Weekday().String()[:3]
				}
				if len(parts) != len(want) {
					t.Errorf("%s %s %v: gateway parts %v, Go fields %v", label, row.Zone, ms, parts, want)
					continue
				}
				for k, w := range want {
					if parts[k] != w {
						t.Errorf("%s %s %v: %s = %q on the gateway, Go %q", label, row.Zone, ms, k, parts[k], w)
					}
				}
				if label == "merge-device-data rain_day" {
					if got, w := intlRainDay(local), parts["year"]+"-"+parts["month"]+"-"+parts["day"]; got != w {
						t.Errorf("rain_day %s %v: Go %q, gateway %q", row.Zone, ms, got, w)
					}
				}
				checked++
			}
		}
	}
	if checked == 0 {
		t.Fatal("no Intl.DateTimeFormat vectors")
	}
}

type processZoneCase struct {
	label  string
	tz     *string // nil: unset
	etcTZ  *string // nil: absent
	result intlProbe
}

func processZoneCases(t *testing.T, v intlVectors) []processZoneCase {
	var cases []processZoneCase
	factory, _ := v.Sections.Facts.EtcTZ.(string)
	for _, row := range v.Sections.ProcessZoneEnv {
		label := "TZ unset"
		if row.TZ != nil {
			label = fmt.Sprintf("TZ=%q", *row.TZ)
		}
		etc := factory
		cases = append(cases, processZoneCase{label + " /etc/TZ factory", row.TZ, &etc, row.Result})
	}
	var etcRows []struct {
		Rule    *string   `json:"rule"`
		Content *string   `json:"content"`
		Absent  bool      `json:"absent"`
		Result  intlProbe `json:"result"`
	}
	if json.Unmarshal(v.Sections.ProcessZoneEtcTZ, &etcRows) == nil {
		for _, row := range etcRows {
			var etc *string
			switch {
			case row.Absent:
			case row.Rule != nil && *row.Rule == "factory":
				etc = row.Content
			case row.Rule != nil:
				rule := *row.Rule + "\n"
				etc = &rule
			}
			label := "/etc/TZ absent"
			if etc != nil {
				label = fmt.Sprintf("/etc/TZ=%q", *etc)
			}
			cases = append(cases, processZoneCase{"TZ unset " + label, nil, etc, row.Result})
		}
	}
	return cases
}

// The process zone: V8 takes local time from ICU, which reads TZ and then the
// system files; osi-edge resolves the same inputs once at start
// (resolveProcessZone). The TZ rows run with the gateway's own /etc/TZ;
// only the emulator guest also rewrites /etc/TZ (--etc-tz). The x86
// oracle's rows depend on its host's zone files and are skipped.
func TestProcessZoneMatchesGateway(t *testing.T) {
	for _, path := range intlGatewayRuns() {
		t.Run(filepath.Base(path), func(t *testing.T) { checkProcessZoneRun(t, loadIntlVectorsFile(t, path)) })
	}
}

func checkProcessZoneRun(t *testing.T, v intlVectors) {
	if v.Sections.Facts.Arch != "arm64" {
		t.Skip("not gateway vectors: process-zone rows depend on the generating host")
	}
	// ICU resolves at process start; the generator's last instant is the
	// UTC day it ran (Date.now() floored), close enough for DST status.
	instants := v.Sections.DateTimeFormat.Instants
	start := time.UnixMilli(int64(instants[len(instants)-1]) + 12*3600*1000)
	for _, c := range processZoneCases(t, v) {
		t.Run(c.label, func(t *testing.T) {
			if c.result.Error != "" {
				t.Fatalf("probe failed on the gateway: %s", c.result.Error)
			}
			root := t.TempDir()
			if c.etcTZ != nil {
				if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "etc/TZ"), []byte(*c.etcTZ), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("OSI_EDGE_DATA_ROOT", root)
			t.Setenv("TZ", "")
			if c.tz == nil {
				os.Unsetenv("TZ")
			} else {
				os.Setenv("TZ", *c.tz)
			}
			loc, name := jstimezone.HostZone(processHost(), start)
			if want := c.result.Resolved; name != want && !(name == "" && want == "undefined") {
				t.Errorf("resolvedOptions().timeZone %q on the gateway, Go %q", want, name)
			}
			for _, row := range c.result.Rows {
				ms := int64(row[0].(float64))
				local := time.UnixMilli(ms).In(loc)
				_, offset := local.Zone()
				// V8's DateCache::TimezoneOffset divides whole minutes
				// (int64 division), so sub-minute LMT offsets truncate.
				if want := row[1].(float64); float64(-offset/60) != want {
					t.Errorf("%d: getTimezoneOffset %v on the gateway, Go %d (zone %s)", ms, want, -offset/60, c.result.Resolved)
				}
				if want := row[5].(float64); float64(local.Hour()) != want {
					t.Errorf("%d: getHours %v on the gateway, Go %d", ms, want, local.Hour())
				}
			}
			for text, want := range c.result.Parse {
				got, ok := jsdate.Parse(text, loc)
				w, isNumber := want.(float64)
				switch {
				case !isNumber || math.IsNaN(w):
					if ok {
						t.Errorf("Date.parse(%q) is NaN on the gateway, Go %d", text, got.UnixMilli())
					}
				case !ok || float64(got.UnixMilli()) != w:
					t.Errorf("Date.parse(%q) = %v on the gateway, Go %v (ok=%v)", text, w, got.UnixMilli(), ok)
				}
			}
		})
	}
}

// The guest's three passes and the Pi 5 board run the same image's node:
// every section but the facts, locale_strings (the run's clock) and the
// process zone (host-specific) agrees, apart from the last date instant,
// which is the day each generator ran.
func TestGatewayRunsAgree(t *testing.T) {
	if os.Getenv("OSI_INTL_VECTORS") != "" {
		t.Skip("one vector file given")
	}
	read := func(path string) map[string]json.RawMessage {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var v struct {
			Sections map[string]json.RawMessage `json:"sections"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		return v.Sections
	}
	board := read("../../../vectors/intl-pi5.vectors.json")
	for _, path := range intlGuestRuns() {
		guest := read(path)
		for _, name := range []string{"collation", "collation_sweep", "collation_fuzz", "case", "case_sweep", "normalize", "zone_names"} {
			if string(guest[name]) != string(board[name]) {
				t.Errorf("%s: section %s differs from the Pi 5", filepath.Base(path), name)
			}
		}
		if dropLast(t, guest["date_time_format"]) != dropLast(t, board["date_time_format"]) {
			t.Errorf("%s: date_time_format differs from the Pi 5", filepath.Base(path))
		}
	}
}

// dropLast is a date_time_format section without its last instant, the day
// the generator ran.
func dropLast(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var d struct {
		Instants []float64 `json:"instants"`
		Formats  map[string]struct {
			Rows []struct {
				Zone   string   `json:"zone"`
				Values []string `json:"values"`
			} `json:"rows"`
		} `json:"formats"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	d.Instants = d.Instants[:len(d.Instants)-1]
	for _, f := range d.Formats {
		for i := range f.Rows {
			if n := len(f.Rows[i].Values); n > 0 {
				f.Rows[i].Values = f.Rows[i].Values[:n-1]
			}
		}
	}
	out, _ := json.Marshal(d)
	return string(out)
}
