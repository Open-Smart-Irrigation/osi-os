package jsvalue

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"testing"
	"time"
	"unicode/utf8"

	"osi-edge/internal/jsdate"
)

func TestCoercionVectors(t *testing.T) {
	type result struct {
		Value json.RawMessage
		Error *JSError
	}
	var data struct {
		Vectors []struct {
			Input  string
			Expect map[string]result
		}
		MappedDigest map[string]string
		Casing       []struct{ Input, Upper, Lower json.RawMessage }
		UTF8         []struct{ Input, Expect string }
	}
	raw, err := os.ReadFile("../../../vectors/js-coercion.vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}

	parse := func(raw []byte) Value {
		t.Helper()
		v, err := Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	ops := map[string]func(Value) (Value, error){
		"string": Value.StringValue,
		"number": func(v Value) (Value, error) {
			n, err := v.CoerceNumber()
			if n == 0 && math.Signbit(n) {
				return Str("-0"), err
			}
			if err != nil {
				return Value{}, err
			}
			return Num(n).StringValue()
		},
		"int32": func(v Value) (Value, error) {
			i, err := v.ToInt32()
			return Num(float64(i)), err
		},
		"shift": func(v Value) (Value, error) {
			i, err := v.ToInt32()
			return Num(float64(i >> 3)), err
		},
		"date": func(v Value) (Value, error) {
			at, ok, err := v.Date(time.UTC)
			if !ok {
				return Nil(), err
			}
			return Str(jsdate.ISOString(at)), err
		},
		"template": Value.StringValue,
		"concat": func(v Value) (Value, error) {
			value, err := v.ToPrimitive(DefaultHint)
			if err != nil {
				return Value{}, err
			}
			return value.StringValue()
		},
	}
	for _, row := range data.Vectors {
		for name, op := range ops {
			expect, ok := row.Expect[name]
			if !ok {
				t.Fatalf("missing %s(%s)", name, row.Input)
			}
			got, err := op(parse([]byte(row.Input)))
			if expect.Error != nil {
				var exception *JSError
				if !errors.As(err, &exception) || *exception != *expect.Error {
					t.Errorf("%s(%s): got %v, want %+v", name, row.Input, err, expect.Error)
				}
				continue
			}
			// Re-encode both values to compare their code units, independent
			// of which escapes the vector generator chose.
			expected, _ := Stringify(parse(expect.Value))
			actual, _ := Stringify(got)
			if err != nil || string(actual) != string(expected) {
				t.Errorf("%s(%s): got %s (%v), want %s", name, row.Input, actual, err, expected)
			}
		}
	}
	for _, row := range data.Casing {
		in := parse(row.Input)
		for _, entry := range []struct {
			raw json.RawMessage
			got Value
		}{{row.Upper, in.UpperCase()}, {row.Lower, in.LowerCase()}} {
			want, _ := Stringify(parse(entry.raw))
			got, _ := Stringify(entry.got)
			if string(got) != string(want) {
				t.Errorf("case mapping %s: got %s, want %s", row.Input, got, want)
			}
		}
	}
	for name, casing := range map[string]func(string) string{"upper": Upper, "lower": Lower} {
		hash := sha256.New()
		for code := rune(0); code <= utf8.MaxRune; code++ {
			if code >= 0xd800 && code <= 0xdfff {
				continue
			}
			in := string(code)
			if mapped := casing(in); mapped != in {
				fmt.Fprintf(hash, "%d:%s\n", code, mapped)
			}
		}
		if actual := hex.EncodeToString(hash.Sum(nil)); actual != data.MappedDigest[name] {
			t.Errorf("%s single-code-point mappings: digest %s, want %s", name, actual, data.MappedDigest[name])
		}
	}

	for _, row := range data.UTF8 {
		data, err := hex.DecodeString(row.Input)
		if err != nil {
			t.Fatal(err)
		}
		if got := Str(string(data)).MustString(); got != row.Expect {
			t.Errorf("decode %s: got %q, want %q", row.Input, got, row.Expect)
		}
	}
	t.Logf("%d conversions, %d case mappings, %d UTF-8 decodes", len(data.Vectors)*len(ops), len(data.Casing)*2, len(data.UTF8))
}
