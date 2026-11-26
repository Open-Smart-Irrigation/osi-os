package jscollate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// vectorsPath is the gateway guest's generate-intl.js output.
// OSI_INTL_VECTORS points the test at another run (the x86 oracle's).
func vectorsPath() string {
	if p := os.Getenv("OSI_INTL_VECTORS"); p != "" {
		return p
	}
	return "../../../vectors/intl-gateway.vectors.json"
}

type collationVectors struct {
	Sections struct {
		Facts struct {
			Versions map[string]string `json:"versions"`
		} `json:"facts"`
		Collation struct {
			Strings []string `json:"strings"`
			Signs   []string `json:"signs"`
			Sorted  []string `json:"sorted"`
		} `json:"collation"`
		CollationSweep struct {
			Count  int    `json:"count"`
			SHA256 string `json:"sha256"`
		} `json:"collation_sweep"`
		CollationFuzz struct {
			Seed  int32  `json:"seed"`
			Count int    `json:"count"`
			Signs string `json:"signs"`
		} `json:"collation_fuzz"`
	} `json:"sections"`
}

func loadVectors(t *testing.T) collationVectors {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath())
	if err != nil {
		t.Fatal(err)
	}
	var v collationVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Sections.Facts.Versions["icu"] != "75.1" || v.Sections.Facts.Versions["cldr"] != "45.0" {
		t.Fatalf("vectors come from ICU %s / CLDR %s; the tables are CLDR 45 (ICU 75.1)",
			v.Sections.Facts.Versions["icu"], v.Sections.Facts.Versions["cldr"])
	}
	return v
}

func signOf(c int) byte {
	switch {
	case c < 0:
		return '-'
	case c > 0:
		return '+'
	}
	return '0'
}

func TestCompareMatchesGatewayPairs(t *testing.T) {
	v := loadVectors(t).Sections.Collation
	if len(v.Strings) == 0 || len(v.Signs) != len(v.Strings) {
		t.Fatal("no collation vectors")
	}
	failures := 0
	for i, a := range v.Strings {
		for j, b := range v.Strings {
			if got, want := signOf(Compare(a, b)), v.Signs[i][j]; got != want {
				failures++
				if failures <= 25 {
					t.Errorf("Compare(%+q, %+q) = %c, gateway %c", a, b, got, want)
				}
			}
		}
	}
	if failures > 0 {
		t.Errorf("%d of %d pairs differ", failures, len(v.Strings)*len(v.Strings))
	}
	sorted := slices.Clone(v.Strings)
	slices.SortStableFunc(sorted, Compare)
	if !slices.Equal(sorted, v.Sorted) {
		t.Errorf("stable sort differs from the gateway's [...].sort((a, b) => a.localeCompare(b))")
	}
}

// The gateway sorts every single code point of planes 0-3 and U+E0000-E01EF
// (surrogates excluded); the digest covers the order and the tie classes.
func TestCompareMatchesGatewayCodePointSweep(t *testing.T) {
	want := loadVectors(t).Sections.CollationSweep
	d := tables()
	var cps []rune
	for c := rune(0); c <= 0x323FF; c++ {
		if c < 0xD800 || c > 0xDFFF {
			cps = append(cps, c)
		}
	}
	for c := rune(0xE0000); c <= 0xE01EF; c++ {
		cps = append(cps, c)
	}
	if len(cps) != want.Count {
		t.Fatalf("sweep has %d code points, gateway %d", len(cps), want.Count)
	}
	elements := make([][]element, len(cps))
	for i, c := range cps {
		elements[i] = d.elements([]rune{c})
	}
	order := make([]int, len(cps))
	for i := range order {
		order[i] = i
	}
	compare := func(a, b int) int { return compareElements(elements[a], elements[b]) }
	slices.SortFunc(order, func(a, b int) int {
		if c := compare(a, b); c != 0 {
			return c
		}
		return a - b
	})
	var text strings.Builder
	for k, i := range order {
		if k > 0 {
			if compare(order[k-1], i) == 0 {
				text.WriteByte('=')
			} else {
				text.WriteByte('<')
			}
		}
		text.WriteString(strconv.FormatInt(int64(cps[i]), 16))
	}
	if dump := os.Getenv("OSI_INTL_SWEEP_DUMP"); dump != "" {
		_ = os.WriteFile(dump, []byte(text.String()), 0o644)
	}
	sum := sha256.Sum256([]byte(text.String()))
	if got := hex.EncodeToString(sum[:]); got != want.SHA256 {
		t.Errorf("code-point sweep digest %s, gateway %s", got, want.SHA256)
	}
}

// generate-intl.js fuzzStrings, ported: mulberry32 over the same pools.
var fuzzPools = [][2]rune{
	{0x20, 0x7e}, {0x41, 0x5a}, {0x61, 0x7a}, {0x30, 0x39}, {0x00, 0x1f}, {0xc0, 0x24f}, {0x300, 0x36f}, {0x370, 0x3ff},
	{0x400, 0x4ff}, {0x591, 0x5f4}, {0x600, 0x6ff}, {0x900, 0x97f}, {0xe01, 0xe5b}, {0xe81, 0xedf}, {0xf00, 0xfda},
	{0x1100, 0x11ff}, {0x1e00, 0x1eff}, {0x2000, 0x206f}, {0x20a0, 0x20c0}, {0x2150, 0x218b}, {0x2460, 0x24ff},
	{0x3040, 0x30ff}, {0x3131, 0x318e}, {0x4e00, 0x4e40}, {0xac00, 0xac40}, {0xfb00, 0xfb4f}, {0xfe00, 0xfe0f},
	{0xff00, 0xffef}, {0xfff0, 0xffff}, {0x1f300, 0x1f64f}, {0x1f900, 0x1faff}, {0x20000, 0x20010}, {0x2ebf0, 0x2ec00},
	{0x31350, 0x31360}, {0x17000, 0x17010}, {0xe0000, 0xe007f}, {0x0378, 0x0379}, {0xd7b0, 0xd7fb},
}

func fuzzStrings(seed int32, count int) []string {
	state := seed
	rnd := func() float64 {
		state += 0x6d2b79f5
		t := uint32(state)
		t = (t ^ t>>15) * (t | 1)
		t ^= t + (t^t>>7)*(t|61)
		return float64(t^t>>14) / 4294967296
	}
	var out []string
	for i := range count {
		n := int(math.Floor(rnd() * 6))
		var s strings.Builder
		for range n {
			pool := fuzzPools[int(math.Floor(rnd()*float64(len(fuzzPools))))]
			c := pool[0] + rune(math.Floor(rnd()*float64(pool[1]-pool[0]+1)))
			if c >= 0xd800 && c <= 0xdfff {
				c = 0xfffd
			}
			s.WriteRune(c)
		}
		text := s.String()
		if i%4 == 3 && len(out) > 0 {
			text = out[len(out)-1] + text
		}
		out = append(out, text)
	}
	return out
}

func TestCompareMatchesGatewayFuzz(t *testing.T) {
	v := loadVectors(t).Sections.CollationFuzz
	strs := fuzzStrings(v.Seed, v.Count)
	if len(v.Signs) != len(strs)-1 {
		t.Fatalf("fuzz signs %d, strings %d", len(v.Signs), len(strs))
	}
	failures := 0
	for i := 1; i < len(strs); i++ {
		if got, want := signOf(Compare(strs[i-1], strs[i])), v.Signs[i-1]; got != want {
			failures++
			if failures <= 25 {
				t.Errorf("fuzz %d: Compare(%+q, %+q) = %c, gateway %c", i, strs[i-1], strs[i], got, want)
			}
		}
	}
	if failures > 0 {
		t.Errorf("%d of %d fuzz pairs differ", failures, len(v.Signs))
	}
}
