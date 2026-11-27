package canon_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"osi-edge/internal/canon"
	"osi-edge/internal/jsvalue"
)

type renderResult struct {
	OK      bool
	Text    *string
	UTF8Hex string
	SHA256  string
	Error   string
}

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

func TestCanonicalV1Vectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", "canonical-v1.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Vectors []struct {
			Input  json.RawMessage
			Expect renderResult
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for i, vector := range fixture.Vectors {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			text, err := canon.Canonicalize(untag(t, parsed(t, vector.Input)))
			if err != nil {
				failure := renderResult{Error: err.Error()}
				if !reflect.DeepEqual(failure, vector.Expect) {
					t.Errorf("got error %#v, want %#v", failure, vector.Expect)
				}
				return
			}
			raw := []byte(text)
			hash := sha256.Sum256(raw)
			got := renderResult{OK: true, Text: &text, UTF8Hex: hex.EncodeToString(raw), SHA256: hex.EncodeToString(hash[:])}
			if !reflect.DeepEqual(got, vector.Expect) {
				t.Errorf("got %#v, want %#v", got, vector.Expect)
			}
		})
	}
}
