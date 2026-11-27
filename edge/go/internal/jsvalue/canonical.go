package jsvalue

import (
	"regexp"
	"time"

	"osi-edge/internal/jsdate"
)

var (
	uuid = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	eui  = regexp.MustCompile(`(?i)^[0-9a-f]{16}$`)
	iso  = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:?[0-9]{2})$`)
)

func normalizeString(v Value) Value {
	s := v.MustString()
	switch {
	case uuid.MatchString(s):
		return Str(Lower(s))
	case eui.MatchString(s):
		return Str(Upper(s))
	case iso.MatchString(s):
		if date, ok := normalizeDate(s); ok {
			return Str(date)
		}
	}
	return v
}

func normalizeDate(s string) (string, bool) {
	date, ok := jsdate.Parse(s, time.UTC)
	if !ok {
		return "", false
	}
	return jsdate.ISOString(date), true
}
