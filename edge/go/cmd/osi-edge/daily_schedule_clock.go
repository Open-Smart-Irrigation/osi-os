package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jstimezone"
)

// Node-RED 3.1.15 gives CronosJS "00 06 * * *" without a timezone option. It
// uses the gateway process's local wall clock and finds the first occurrence
// strictly after now. A repeated wall time runs once. CronosJS constructs the
// local Date for a missing wall time, advancing it by the size of the gap.
func nextDailySchedule(now time.Time) time.Time {
	return nextDailyScheduleIn(now, dailyScheduleLocation())
}

func nextDailyScheduleIn(now time.Time, loc *time.Location) time.Time {
	y, m, d := now.In(loc).Date()
	date := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	for {
		if at := jsdate.LocalWall(date.Add(6*time.Hour), loc); at.After(now) {
			return at
		}
		date = date.AddDate(0, 0, 1)
	}
}

// dailyScheduleLocation is the process timezone. V8 reads it once at start,
// so osi-edge resolves it once in run() (jsdate.SetProcessZone).
func dailyScheduleLocation() *time.Location {
	if zone := jsdate.ConfiguredProcessZone(); zone != nil {
		return zone
	}
	return resolveProcessZone()
}

// resolveProcessZone finds the zone Node-RED's process runs in, as V8 does
// at start: from ICU's host detection over musl (jstimezone.HostZone).
// node-red.init sets no TZ, so on the gateway musl reads /etc/TZ, which holds
// system.timezone (a POSIX rule; the image ships no zoneinfo).
func resolveProcessZone() *time.Location { return resolveProcessZoneAt(time.Now()) }

func resolveProcessZoneAt(now time.Time) *time.Location {
	loc, _ := jstimezone.HostZone(processHost(), now)
	return loc
}

// processHost reads TZ and the image's files (OSI_EDGE_DATA_ROOT in tests).
func processHost() jstimezone.Host {
	host := jstimezone.Host{
		Read: func(path string) ([]byte, error) { return os.ReadFile(imagePath(path)) },
		Resolve: func(path string) (string, error) {
			real, err := filepath.EvalSymlinks(imagePath(path))
			if err != nil {
				return "", err
			}
			if root := os.Getenv("OSI_EDGE_DATA_ROOT"); root != "" {
				if rel, err := filepath.Rel(root, real); err == nil && !strings.HasPrefix(rel, "..") {
					real = "/" + rel
				}
			}
			return real, nil
		},
	}
	if zone, set := os.LookupEnv("TZ"); set {
		host.TZ = &zone
	}
	return host
}

// cronosDailyNext is CronosExpression.nextDate (cronosjs 1.7.1,
// dist-node/index.js:626-698) for "minute hour * * *" with no timezone
// option, as an inject node gives it: the defaults skipRepeatedHour true and
// missingHour "insert", local time in the process zone loc, second
// resolution. Node-RED's other four crontab injects use it; Go keeps them
// only as wake sources of the shared timer.
func cronosDailyNext(after time.Time, loc *time.Location, hour, minute int) time.Time {
	const hourMs = time.Hour
	fields := func(at time.Time) time.Time {
		y, mo, d := at.In(loc).Date()
		h, mi, s := at.In(loc).Clock()
		return time.Date(y, mo, d, h, mi, s, 0, time.UTC)
	}
	from := fields(after)
	// skipRepeatedHour: in the second pass of a repeated hour, search from
	// the end of that hour without the extra second.
	if from.Equal(fields(after.Add(-hourMs))) {
		next := cronosDailyField(from.Truncate(time.Hour).Add(59*time.Minute+60*time.Second), hour, minute, false)
		return jsdate.LocalWall(next, loc)
	}
	next := cronosDailyField(from, hour, minute, true)
	at := jsdate.LocalWall(next, loc)
	// missingHour "insert": an occurrence in a skipped hour runs at the
	// start of that hour, as new Date(...hour, 0, 0) gives it.
	if jsdate.LocalWall(next.Add(hourMs), loc).Equal(at) {
		return jsdate.LocalWall(next.Truncate(time.Hour), loc)
	}
	return at
}

// cronosDailyField is CronosExpression._next on calendar fields (a UTC
// time.Time stands for the local fields): the first hour:minute:00 at or
// after from, or strictly after it (from plus one second) when strict.
func cronosDailyField(from time.Time, hour, minute int, strict bool) time.Time {
	if strict {
		from = from.Add(time.Second)
	}
	y, mo, d := from.Date()
	at := time.Date(y, mo, d, hour, minute, 0, 0, time.UTC)
	if at.Before(from) {
		at = at.AddDate(0, 0, 1)
	}
	return at
}
