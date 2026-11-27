package jsnum_test

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

	"osi-edge/internal/jsnum"
)

type renderResult struct {
	OK      bool
	Text    *string
	UTF8Hex string
	SHA256  string
	Error   string
}

type taggedNumber struct {
	N string
}

func number(t *testing.T, raw json.RawMessage) float64 {
	t.Helper()
	var tagged taggedNumber
	if err := json.Unmarshal(raw, &tagged); err != nil {
		t.Fatal(err)
	}
	bits, err := strconv.ParseUint(tagged.N, 16, 64)
	if err != nil {
		t.Fatal(err)
	}
	return math.Float64frombits(bits)
}

func bits(n float64) string {
	return strconv.FormatUint(math.Float64bits(n), 16)
}

func TestJSNumberVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", "js-number.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Vectors []struct {
			Input      json.RawMessage
			MathRound  json.RawMessage
			ToFixed1   renderResult
			ToFixed2   renderResult
			String     string
			RoundTenth json.RawMessage
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for i, vector := range fixture.Vectors {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			in := number(t, vector.Input)
			if got, want := bits(jsnum.Round(in)), bits(number(t, vector.MathRound)); got != want {
				t.Errorf("Round: got bits %s, want %s", got, want)
			}
			if got, want := jsnum.String(in), vector.String; got != want {
				t.Errorf("String: got %q, want %q", got, want)
			}
			if got, want := bits(jsnum.Round(in*10)/10), bits(number(t, vector.RoundTenth)); got != want {
				t.Errorf("RoundTenth: got bits %s, want %s", got, want)
			}
			for _, tc := range []struct {
				digits int
				expect renderResult
			}{{1, vector.ToFixed1}, {2, vector.ToFixed2}} {
				text, err := jsnum.ToFixed(in, tc.digits)
				if err != nil {
					failure := renderResult{Error: err.Error()}
					if !reflect.DeepEqual(failure, tc.expect) {
						t.Errorf("ToFixed(%d): got error %#v, want %#v", tc.digits, failure, tc.expect)
					}
					continue
				}
				s := text
				raw := []byte(s)
				hash := sha256.Sum256(raw)
				got := renderResult{OK: true, Text: &s, UTF8Hex: hex.EncodeToString(raw), SHA256: hex.EncodeToString(hash[:])}
				if !reflect.DeepEqual(got, tc.expect) {
					t.Errorf("ToFixed(%d): got %#v, want %#v", tc.digits, got, tc.expect)
				}
			}
		})
	}
}
