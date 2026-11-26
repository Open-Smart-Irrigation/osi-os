package csv_test

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

	"osi-edge/internal/csv"
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

func render(t *testing.T, text string) renderResult {
	t.Helper()
	raw := []byte(text)
	hash := sha256.Sum256(raw)
	return renderResult{OK: true, Text: &text, UTF8Hex: hex.EncodeToString(raw), SHA256: hex.EncodeToString(hash[:])}
}

func TestCSVVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", "csv.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		CSV []struct {
			Columns []string
			Input   json.RawMessage
			Expect  renderResult
		}
		JavaText []struct {
			Input                json.RawMessage
			JavaDoubleText       renderResult
			JavaPlainDecimalText renderResult
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for i, vector := range fixture.CSV {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			rows := untag(t, parsed(t, vector.Input))
			text, err := csv.ToCsv(vector.Columns, rows.List)
			if err != nil {
				failure := renderResult{Error: err.Error()}
				if !reflect.DeepEqual(failure, vector.Expect) {
					t.Errorf("got error %#v, want %#v", failure, vector.Expect)
				}
				return
			}
			if got := render(t, text); !reflect.DeepEqual(got, vector.Expect) {
				if wantText := vector.Expect.Text; wantText != nil && *wantText != text {
					for i := 0; i < len(*wantText) && i < len(text); i++ {
						if (*wantText)[i] != text[i] {
							t.Errorf("first diff at %d: got %q want %q", i, text[max(0, i-20):i+20], (*wantText)[max(0, i-20):i+20])
							break
						}
					}
					if len(*wantText) != len(text) {
						t.Errorf("length: got %d want %d", len(text), len(*wantText))
					}
				}
				t.Errorf("got %#v, want %#v", got, vector.Expect)
			}
		})
	}
	for i, vector := range fixture.JavaText {
		t.Run("java/"+strconv.Itoa(i), func(t *testing.T) {
			in := untag(t, parsed(t, vector.Input)).Num
			text, err := csv.JavaDoubleText(in), error(nil)
			checkRender(t, "JavaDoubleText", text, err, vector.JavaDoubleText)
			checkRender(t, "JavaPlainDecimalText", csv.JavaPlainDecimalText(in), error(nil), vector.JavaPlainDecimalText)
		})
	}
}

func checkRender(t *testing.T, name, text string, err error, expect renderResult) {
	t.Helper()
	if err != nil {
		failure := renderResult{Error: err.Error()}
		if !reflect.DeepEqual(failure, expect) {
			t.Errorf("%s: got error %#v, want %#v", name, failure, expect)
		}
		return
	}
	if got := render(t, text); !reflect.DeepEqual(got, expect) {
		t.Errorf("%s: got %#v, want %#v", name, got, expect)
	}
}
