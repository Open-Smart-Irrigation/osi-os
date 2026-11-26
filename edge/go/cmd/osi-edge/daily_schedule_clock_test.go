package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"osi-edge/internal/ingest"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jstimezone"
	"osi-edge/internal/jsvalue"
)

func TestDailyScheduleCronosDates(t *testing.T) {
	// Node-RED's CronosExpression.parse("00 06 * * *") on Node 20.18.3.
	for _, tc := range []struct{ zone, after, want string }{
		{"Europe/Zurich", "2026-03-28T05:00:00Z", "2026-03-29T04:00:00Z"},
		{"Europe/Zurich", "2026-03-29T01:30:00Z", "2026-03-29T04:00:00Z"},
		{"Europe/Zurich", "2026-03-29T04:00:00Z", "2026-03-30T04:00:00Z"},
		{"Europe/Zurich", "2026-10-24T04:00:00Z", "2026-10-25T05:00:00Z"},
		{"Europe/Zurich", "2026-10-25T01:30:00Z", "2026-10-25T05:00:00Z"},
		{"Europe/Zurich", "2026-10-25T05:00:00Z", "2026-10-26T05:00:00Z"},
		{"Africa/Kampala", "2026-03-28T05:00:00Z", "2026-03-29T03:00:00Z"},
		{"Africa/Kampala", "2026-03-29T01:30:00Z", "2026-03-29T03:00:00Z"},
		{"Africa/Kampala", "2026-03-29T04:00:00Z", "2026-03-30T03:00:00Z"},
		{"Africa/Kampala", "2026-10-24T04:00:00Z", "2026-10-25T03:00:00Z"},
		{"Africa/Kampala", "2026-10-25T01:30:00Z", "2026-10-25T03:00:00Z"},
		{"Africa/Kampala", "2026-10-25T05:00:00Z", "2026-10-26T03:00:00Z"},
		{"CET-1CEST,M3.5.0,M10.5.0/3", "2026-03-29T01:30:00Z", "2026-03-29T04:00:00Z"},
		{"CET-1CEST,M3.5.0,M10.5.0/3", "2026-10-25T01:30:00Z", "2026-10-25T05:00:00Z"},
		{"EAT-3", "2026-10-25T01:30:00Z", "2026-10-25T03:00:00Z"},
		{"Pacific/Apia", "2011-12-29T20:00:00Z", "2011-12-30T16:00:00Z"},
		{"Pacific/Apia", "2011-12-30T09:59:59Z", "2011-12-30T16:00:00Z"},
		{"Pacific/Apia", "2011-12-30T10:00:00Z", "2011-12-30T16:00:00Z"},
		{"Pacific/Apia", "2011-12-30T16:00:00Z", "2011-12-31T16:00:00Z"},
		{"Pacific/Kwajalein", "1993-08-21T00:00:00Z", "1993-08-21T18:00:00Z"},
		// Synthetic transitions within the 06:00 cron's own hour.
		{"CET-1CEST,M3.5.0/6,M10.5.0/7", "2026-03-29T04:30:00Z", "2026-03-29T05:00:00Z"},
		{"CET-1CEST,M3.5.0/6,M10.5.0/7", "2026-10-25T03:30:00Z", "2026-10-25T04:00:00Z"},
		{"CET-1CEST,M3.5.0/6,M10.5.0/7", "2026-10-25T04:30:00Z", "2026-10-26T05:00:00Z"},
	} {
		t.Run(tc.zone+"/"+tc.after, func(t *testing.T) {
			at := valveInstant(tc.after)
			got := nextDailyScheduleIn(at, dailyNamedLocation(tc.zone))
			if want := valveInstant(tc.want); !got.Equal(want) {
				t.Errorf("next occurrence = %v, want %v", got, want)
			}
		})
	}
}

func TestScheduleFireAtMatchesDateParse(t *testing.T) {
	loc := dailyNamedLocation("Europe/Zurich")
	for _, tc := range []struct{ value, want string }{
		{"2026-03-29T02:30", "2026-03-29T01:30:00.000Z"},
		{"2026-10-25T02:30", "2026-10-25T00:30:00.000Z"},
		{"2026-02-31T24:00Z", "2026-03-04T00:00:00.000Z"},
		{"2026-10-25T06:00:00.123456+0300", "2026-10-25T03:00:00.123Z"},
		{"0001-01-01T00:00Z", "0001-01-01T00:00:00.000Z"},
		{"2026-10-25T06:00+00:60", ""},
	} {
		t.Run(tc.value, func(t *testing.T) {
			at, ok := scheduleFireAt(tc.value, loc)
			if ok != (tc.want != "") {
				t.Fatalf("scheduleFireAt(%q) valid = %t, want %t", tc.value, ok, tc.want != "")
			}
			if ok && valveISO(at) != tc.want {
				t.Errorf("scheduleFireAt(%q) = %s, want %s", tc.value, valveISO(at), tc.want)
			}
		})
	}
}

func TestDailyScheduleStoredDatesMatchDateParse(t *testing.T) {
	loc := dailyNamedLocation("Europe/Zurich")
	for _, tc := range []struct{ value, want string }{
		{"2026-11-23T06:00:00.123456Z", "2026-11-23T06:00:00.123Z"},
		{"2026-11-23", "2026-11-23T00:00:00.000Z"},
		{"2026-11-23 00:00:00", "2026-11-22T23:00:00.000Z"},
		{"2026-11-23 ", "2026-11-22T23:00:00.000Z"},
		{"2026/11/23 00:00:00 GMT", "2026-11-23T00:00:00.000Z"},
		{"2026/11/23 00:20:00 GMT+2", "2026-11-22T22:20:00.000Z"},
		{"Mon, 23 Nov 2026 00:00:00 -0500", "2026-11-23T05:00:00.000Z"},
		{"Mon Nov 23 2026 00:05:00 GMT+0100 (Central European Standard Time)", "2026-11-22T23:05:00.000Z"},
		{"11/23/26, 12:00:00 AM", "2026-11-22T23:00:00.000Z"},
		{"23-November-2026 1:00 PM PST", "2026-11-23T21:00:00.000Z"},
		{"2026-03-29T02:30", "2026-03-29T01:30:00.000Z"},
		{"2026-10-25T02:30", "2026-10-25T00:30:00.000Z"},
		{"2026-02-31 24:00:00 GMT", "2026-03-04T00:00:00.000Z"},
		{"0001-01-01T00:00Z", "0001-01-01T00:00:00.000Z"},
		{"2026-11-23T00:00Z ", ""},
		{"2026-11-23T06:00+00:60", ""},
		{"2026-11-23T24:00:00.0000001Z", ""},
		{"not a date", ""},
	} {
		t.Run(tc.value, func(t *testing.T) {
			at, ok := jsdate.Parse(tc.value, loc)
			if ok != (tc.want != "") || (ok && valveISO(at) != tc.want) {
				t.Errorf("Parse(%q) = %s, %t, want %q", tc.value, valveISO(at), ok, tc.want)
			}
		})
	}
}

// node-red.init sets no TZ; OpenWrt's musl then reads /etc/TZ, and ICU maps
// its abbreviations to a zone (jstimezone.HostZone). An empty TZ is ICU's
// Etc/Unknown (GMT) whatever /etc/TZ holds. The resolved zone governs every
// offset-free date (KIWI's legacy "2024-01-01 00:15:00" clamps under CET and is
// kept under UTC). Started in winter: a CET rule resolves Europe/Brussels;
// started in summer it is a fixed UTC zone (ICU's raw offset on musl).
func TestProcessZoneFollowsOpenWrtTZFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OSI_EDGE_DATA_ROOT", root)
	previous, had := os.LookupEnv("TZ")
	t.Cleanup(func() {
		if had {
			os.Setenv("TZ", previous)
		} else {
			os.Unsetenv("TZ")
		}
		jsdate.SetProcessZone(nil)
	})
	for _, tc := range []struct {
		tz, file, want string
		unset, summer  bool
	}{
		{unset: true, file: "CET-1CEST,M3.5.0,M10.5.0/3\n", want: "2023-12-31T23:15:00.000Z"},
		{tz: "", file: "CET-1CEST,M3.5.0,M10.5.0/3\n", want: "2024-01-01T00:15:00.000Z"},
		{unset: true, file: "CET-1CEST,M3.5.0,M10.5.0/3\n", summer: true, want: "2024-01-01T00:15:00.000Z"},
		{unset: true, file: "UTC\n", want: "2024-01-01T00:15:00.000Z"},
		{unset: true, file: "EAT-3\n", want: "2023-12-31T21:15:00.000Z"},
		{unset: true, want: "2024-01-01T00:15:00.000Z"}, // no /etc/TZ: musl uses UTC
		{tz: "UTC", file: "CET-1CEST,M3.5.0,M10.5.0/3\n", want: "2024-01-01T00:15:00.000Z"},
	} {
		if tc.unset {
			os.Unsetenv("TZ")
		} else {
			os.Setenv("TZ", tc.tz)
		}
		os.Remove(filepath.Join(root, "etc/TZ"))
		if tc.file != "" {
			if err := os.WriteFile(filepath.Join(root, "etc/TZ"), []byte(tc.file), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		start := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
		if tc.summer {
			start = time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
		}
		jsdate.SetProcessZone(resolveProcessZoneAt(start))
		at, ok := ingest.EventTime(jsvalue.Str("2024-01-01 00:15:00"))
		if !ok || jsdate.ISOString(at) != tc.want {
			t.Errorf("TZ=%q unset=%t /etc/TZ=%q: %s, want %s", tc.tz, tc.unset, tc.file, jsdate.ISOString(at), tc.want)
		}
	}
}

// dailyNamedLocation is a zone by IANA name, or a POSIX rule applied as written.
func dailyNamedLocation(zone string) *time.Location {
	if jstimezone.Canonical(zone) != "" {
		return jstimezone.Location(zone)
	}
	loc, err := jstimezone.POSIX("Local", zone)
	if err != nil {
		return time.UTC
	}
	return loc
}
