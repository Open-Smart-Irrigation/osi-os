package jsdate

import (
	"fmt"
	"math"
	"time"
)

const maxMilliseconds = 8_640_000_000_000_000

// FromMilliseconds applies ECMAScript TimeClip to an epoch-millisecond value.
func FromMilliseconds(ms float64) (time.Time, bool) {
	if math.IsNaN(ms) || math.Abs(ms) > maxMilliseconds {
		return time.Time{}, false
	}
	return time.UnixMilli(int64(ms)).UTC(), true
}

// ISOString renders a valid Date as Date.prototype.toISOString does.
func ISOString(at time.Time) string {
	at = at.UTC()
	const suffix = "-01-02T15:04:05.000Z"
	if year := at.Year(); year < 0 || year > 9999 {
		return fmt.Sprintf("%+07d%s", year, at.Format(suffix))
	}
	return at.Format("2006" + suffix)
}
