package jsvalue

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
)

// The gateway guest's edge/vectors/generate-intl.js output; OSI_INTL_VECTORS
// points at another run. case_tables.go was generated on the x86 oracle
// (Node 20.18.3, full ICU); these checks tie it to the gateway's small ICU.
func intlVectorsPath() string {
	if p := os.Getenv("OSI_INTL_VECTORS"); p != "" {
		return p
	}
	return "../../../vectors/intl-gateway.vectors.json"
}

func sweepHex(s string) string {
	var parts []string
	for _, r := range s {
		parts = append(parts, fmt.Sprintf("%04X", r))
	}
	return strings.Join(parts, " ")
}

func TestCaseMappingMatchesGateway(t *testing.T) {
	raw, err := os.ReadFile(intlVectorsPath())
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Sections struct {
			Case struct {
				Vectors []struct{ Input, Upper, Lower, Locale_upper, Locale_lower string }
			}
			CaseSweep struct {
				UpperSHA256        string `json:"upper_sha256"`
				LowerSHA256        string `json:"lower_sha256"`
				LocaleUpperDiffers string `json:"locale_upper_differs"`
				LocaleLowerDiffers string `json:"locale_lower_differs"`
			} `json:"case_sweep"`
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Sections.Case.Vectors) == 0 {
		t.Fatal("no case vectors")
	}
	for _, c := range v.Sections.Case.Vectors {
		if got := Upper(c.Input); got != c.Upper {
			t.Errorf("Upper(%+q) = %+q, gateway %+q", c.Input, got, c.Upper)
		}
		if got := Lower(c.Input); got != c.Lower {
			t.Errorf("Lower(%+q) = %+q, gateway %+q", c.Input, got, c.Lower)
		}
		// The default locale (en-US) maps like the locale-independent methods.
		if c.Locale_upper != c.Upper || c.Locale_lower != c.Lower {
			t.Errorf("%+q: toLocale*Case differs from to*Case on the gateway", c.Input)
		}
	}
	if v.Sections.CaseSweep.LocaleUpperDiffers != "" || v.Sections.CaseSweep.LocaleLowerDiffers != "" {
		t.Errorf("toLocale*Case differs from to*Case for single code points on the gateway")
	}
	var upper, lower strings.Builder
	sweep := func(c rune) {
		s := string(c)
		if u := Upper(s); u != s {
			upper.WriteString(strconv.FormatInt(int64(c), 16) + ":" + sweepHex(u) + "\n")
		}
		if l := Lower(s); l != s {
			lower.WriteString(strconv.FormatInt(int64(c), 16) + ":" + sweepHex(l) + "\n")
		}
	}
	for c := rune(0); c <= 0x323FF; c++ {
		if c < 0xD800 || c > 0xDFFF {
			sweep(c)
		}
	}
	for c := rune(0xE0000); c <= 0xE01EF; c++ {
		sweep(c)
	}
	for name, got := range map[string]string{v.Sections.CaseSweep.UpperSHA256: upper.String(), v.Sections.CaseSweep.LowerSHA256: lower.String()} {
		sum := sha256.Sum256([]byte(got))
		if hex.EncodeToString(sum[:]) != name {
			t.Errorf("case sweep digest %x, gateway %s", sum, name)
		}
	}
}
