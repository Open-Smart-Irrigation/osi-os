package ingest

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"slices"

	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

// EventKey uses the network event identity. An empty result leaves the
// event unkeyed. Keep the original timestamp precision in the frame hash.
func EventKey(source string, envelope jsvalue.Value) string {
	if source == "" || envelope.Kind != jsvalue.Object {
		return ""
	}

	id := envelope.Get("deduplicationId")
	if id.Kind == jsvalue.String {
		if id = id.TrimmedString(); id.Truthy() {
			return hashIdentity(jsvalue.Arr(jsvalue.Str(source), jsvalue.Arr(jsvalue.Str("id"), id)))
		}
	}

	count := envelope.Get("fCnt")
	stamp := envelope.Get("time")
	if count.Kind != jsvalue.Number || count.Num < 0 || math.IsInf(count.Num, 0) ||
		math.Trunc(count.Num) != count.Num || stamp.Kind != jsvalue.String {
		return ""
	}
	if _, valid := jsdate.Parse(stamp.MustString(), nil); !valid {
		return ""
	}

	address := envelope.Get("devAddr")
	if !address.Truthy() {
		address = jsvalue.Nil()
	}
	port := envelope.Get("fPort")
	if port.Kind == jsvalue.Undefined {
		port = jsvalue.Nil()
	}
	frame := jsvalue.Arr(jsvalue.Str("frame"), address, count, port, stamp)
	return hashIdentity(jsvalue.Arr(jsvalue.Str(source), frame))
}

// SDI12Key identifies an assembled observation regardless of reception order
// or repeated constituent frames.
func SDI12Key(info jsvalue.Value) string {
	frames := info.Get("frames")
	if frames.Kind != jsvalue.Array || len(frames.List) == 0 {
		return ""
	}
	keys := make([]string, 0, len(frames.List))
	for _, frame := range frames.List {
		key := EventKey("sdi12", frame.Get("event"))
		if key == "" {
			return ""
		}
		keys = append(keys, key)
	}
	slices.Sort(keys)
	distinct := slices.Compact(keys)
	values := make([]jsvalue.Value, 0, len(distinct))
	for _, key := range distinct {
		values = append(values, jsvalue.Str(key))
	}
	return hashIdentity(jsvalue.Arr(values...))
}

func hashIdentity(value jsvalue.Value) string {
	bytes, err := jsvalue.Stringify(value)
	if err != nil {
		return ""
	}
	hash := sha256.Sum256(bytes)
	return hex.EncodeToString(hash[:])
}
