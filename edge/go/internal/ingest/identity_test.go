package ingest

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"osi-edge/internal/jsvalue"
)

func TestUplinkKeyVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", "uplink-key.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	vectors, err := jsvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	check := func(t *testing.T, got string, want jsvalue.Value) {
		t.Helper()
		if (want.Kind == jsvalue.Null && got != "") ||
			(want.Kind != jsvalue.Null && got != want.ToString()) {
			t.Errorf("got %q, want %s", got, want.ToString())
		}
	}
	for i, vector := range vectors.Get("eventKey").List {
		t.Run(fmt.Sprintf("eventKey/%d", i), func(t *testing.T) {
			check(t, EventKey(vector.Get("source").ToString(), untag(t, vector.Get("envelope"))), vector.Get("expect"))
		})
	}
	for i, vector := range vectors.Get("sdi12Key").List {
		t.Run(fmt.Sprintf("sdi12Key/%d", i), func(t *testing.T) {
			check(t, SDI12Key(untag(t, vector.Get("info"))), vector.Get("expect"))
		})
	}
}

// The seam vectors encode objects as ordered pairs and numbers as IEEE-754 bits.
func untag(t *testing.T, value jsvalue.Value) jsvalue.Value {
	t.Helper()
	switch value.Kind {
	case jsvalue.Array:
		for i, member := range value.List {
			value.List[i] = untag(t, member)
		}
	case jsvalue.Object:
		if bits := value.Get("n"); bits.Kind == jsvalue.String {
			n, err := strconv.ParseUint(bits.ToString(), 16, 64)
			if err != nil {
				t.Fatal(err)
			}
			return jsvalue.Num(math.Float64frombits(n))
		}
		if object := value.Get("o"); object.Kind == jsvalue.Array {
			fields := make([]jsvalue.Field, 0, len(object.List))
			for _, entry := range object.List {
				fields = append(fields, jsvalue.Field{Key: untag(t, entry.List[0]).Text, Value: untag(t, entry.List[1])})
			}
			return jsvalue.Obj(fields...)
		}
		if text := value.Get("u16"); text.Kind == jsvalue.Array {
			units := make([]uint16, 0, len(text.List))
			for _, unit := range text.List {
				units = append(units, uint16(unit.Num))
			}
			return jsvalue.Value{Kind: jsvalue.String, Text: units}
		}
		if value.Get("undef").Bool {
			return jsvalue.Value{}
		}
		t.Fatal("unrecognized tagged object")
	}
	return value
}
