package jsdate

import (
	"encoding/json"
	"os"
	"osi-edge/internal/jstimezone"
	"path/filepath"
	"testing"
)

func TestNodeDateVectors(t *testing.T) {
	file := filepath.Join("..", "..", "..", "vectors", "js-date.vectors.json")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	type instant struct {
		milliseconds int64
		iso          string
	}
	var corpus struct {
		Node  string
		Dates []struct {
			Input  string
			Expect map[string][]json.RawMessage
		}
		Epoch []struct {
			Input  float64
			Expect *string
		}
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Node != "20.18.3" || len(corpus.Dates) == 0 || len(corpus.Epoch) == 0 {
		t.Fatal("missing pinned Node Date cases")
	}
	for _, tz := range []string{"UTC", "Europe/Zurich"} {
		t.Run(tz, func(t *testing.T) {
			loc := jstimezone.Location(tz)
			for _, tc := range corpus.Dates {
				expected, found := tc.Expect[tz]
				if !found {
					t.Fatalf("missing %s expectation for %q", tz, tc.Input)
				}
				got, ok := Parse(tc.Input, loc)
				if expected == nil {
					if ok {
						t.Errorf("Parse(%q) = %s, want Invalid Date", tc.Input, ISOString(got))
					}
					continue
				}
				var want instant
				if len(expected) != 2 || json.Unmarshal(expected[0], &want.milliseconds) != nil ||
					json.Unmarshal(expected[1], &want.iso) != nil {
					t.Fatalf("bad vector for %q: %q", tc.Input, expected)
				}
				if !ok || got.UnixMilli() != want.milliseconds || ISOString(got) != want.iso {
					t.Errorf("Parse(%q) = %s (valid %t), want %s", tc.Input, ISOString(got), ok, want.iso)
				}
			}
		})
	}
	for _, tc := range corpus.Epoch {
		got, ok := FromMilliseconds(tc.Input)
		if tc.Expect == nil {
			if ok {
				t.Errorf("FromMilliseconds(%g) = %s, want Invalid Date", tc.Input, ISOString(got))
			}
		} else if !ok || ISOString(got) != *tc.Expect {
			t.Errorf("FromMilliseconds(%g) = %s (valid %t), want %s", tc.Input, ISOString(got), ok, *tc.Expect)
		}
	}
}
