package jsdate

import "time"

// LocalWall interprets wall's UTC components in loc, choosing the earlier
// instant in a repeat and advancing by the size of a gap.
func LocalWall(wall time.Time, loc *time.Location) time.Time {
	y, m, d := wall.Date()
	hours, minutes, seconds := wall.Clock()
	probe := time.Date(y, m, d, hours, minutes, seconds, wall.Nanosecond(), loc)
	start, end := probe.ZoneBounds()
	offset := func(at time.Time) time.Duration {
		_, seconds := at.In(loc).Zone()
		return time.Duration(seconds) * time.Second
	}
	var earliest time.Time
	found := false
	check := func(near time.Time) {
		at := wall.Add(-offset(near))
		if at.Add(offset(at)).Equal(wall) && (!found || at.Before(earliest)) {
			earliest, found = at, true
		}
	}
	check(probe)
	if !start.IsZero() {
		check(start.Add(-time.Second))
	}
	if !end.IsZero() {
		check(end)
	}
	if found {
		return earliest
	}
	for _, transition := range []time.Time{start, end} {
		if transition.IsZero() {
			continue
		}
		before := transition.Add(offset(transition.Add(-time.Second)))
		after := transition.Add(offset(transition))
		if !wall.Before(before) && wall.Before(after) {
			return transition.Add(wall.Sub(before))
		}
	}
	return probe
}
