package history

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"osi-edge/internal/jsvalue"
)

func parsed(t *testing.T, raw json.RawMessage) jsvalue.Value {
	t.Helper()
	value, err := jsvalue.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func untag(t *testing.T, tagged jsvalue.Value) jsvalue.Value {
	t.Helper()
	switch tagged.Kind {
	case jsvalue.Array:
		for i, v := range tagged.List {
			tagged.List[i] = untag(t, v)
		}
	case jsvalue.Object:
		if bits := tagged.Get("n"); bits.Kind != jsvalue.Undefined {
			n, err := strconv.ParseUint(bits.ToString(), 16, 64)
			if err != nil {
				t.Fatal(err)
			}
			return jsvalue.Num(math.Float64frombits(n))
		}
		if text := tagged.Get("u16"); text.Kind != jsvalue.Undefined {
			units := make([]uint16, len(text.List))
			for i, unit := range text.List {
				units[i] = uint16(unit.Num)
			}
			return jsvalue.Value{Kind: jsvalue.String, Text: units}
		}
		if obj := tagged.Get("o"); obj.Kind != jsvalue.Undefined {
			fields := make([]jsvalue.Field, len(obj.List))
			for i, entry := range obj.List {
				fields[i] = jsvalue.Field{Key: untag(t, entry.List[0]).Text, Value: untag(t, entry.List[1])}
			}
			return jsvalue.Obj(fields...)
		}
		if tagged.Get("undef").Bool {
			return jsvalue.Value{}
		}
		t.Fatal("unrecognized tagged object")
	}
	return tagged
}

func TestHistoryRowHashVectors(t *testing.T) {
	// The '2026-11-23 17:03:41' vector was recorded on a UTC+1 host: Node's
	// fallback parser reads the space form as local time.
	previous := localZone
	localZone = time.FixedZone("CET", 3600)
	defer func() { localZone = previous }()

	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", "history-row-hash.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Vectors []struct {
			Table      string
			GatewayEUI string
			Input      json.RawMessage
			Expect     json.RawMessage
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for i, vector := range fixture.Vectors {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			row := untag(t, parsed(t, vector.Input))
			var expect struct {
				OK         bool
				HistoryKey *string
				Columns    json.RawMessage
				SHA256     string
				Error      string
			}
			if err := json.Unmarshal(vector.Expect, &expect); err != nil {
				t.Fatal(err)
			}
			var key *string
			if computed, err := HistoryKey(vector.Table, vector.GatewayEUI, row); err == nil {
				key = &computed
			}
			if !expect.OK {
				_, err := HashHistoryRow(vector.Table, "", row)
				if err == nil || err.Error() != expect.Error {
					t.Fatalf("got error %v, want %q", err, expect.Error)
				}
				return
			}
			if key == nil || *key != *expect.HistoryKey {
				t.Fatalf("historyKey: got %v, want %q", key, *expect.HistoryKey)
			}
			columns, err := BuildCanonicalColumns(vector.Table, row)
			if err != nil {
				t.Fatalf("columns: %v", err)
			}
			var rendered = jsvalue.Arr()
			for _, column := range columns {
				rendered.List = append(rendered.List, jsvalue.Arr(
					jsvalue.Str(column.Name), jsvalue.Str(column.Type), column.Value))
			}
			if want := untag(t, parsed(t, expect.Columns)); !reflect.DeepEqual(rendered, want) {
				t.Errorf("columns: got %#v, want %#v", rendered, want)
			}
			hash, err := HashHistoryRow(vector.Table, *key, row)
			if err != nil {
				t.Fatal(err)
			}
			if hash != expect.SHA256 {
				t.Errorf("sha256: got %s, want %s", hash, expect.SHA256)
			}
		})
	}
}
