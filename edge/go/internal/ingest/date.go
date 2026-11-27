package ingest

import (
	"time"

	"osi-edge/internal/jsvalue"
)

// EventTime models new Date(value) for timestamps carried by uplinks.
func EventTime(value jsvalue.Value) (time.Time, bool) {
	return value.MustDate(nil)
}
