package jscollate

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

// The collator's NFD against the gateway's String.prototype.normalize('NFD')
// over every code point of the sweep.
func TestNFDMatchesGateway(t *testing.T) {
	raw, err := os.ReadFile(vectorsPath())
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Sections struct {
			Normalize struct {
				Vectors []map[string]string `json:"vectors"`
				Sweep   map[string]string   `json:"sweep_sha256"`
			} `json:"normalize"`
		} `json:"sections"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	d := tables()
	for _, c := range v.Sections.Normalize.Vectors {
		if got := string(d.nfd(wtf8Runes(c["input"]))); got != c["NFD"] {
			t.Errorf("nfd(%+q) = %+q, gateway %+q", c["input"], got, c["NFD"])
		}
	}
	var text strings.Builder
	line := func(c rune) {
		if n := d.nfd([]rune{c}); string(n) != string(c) {
			parts := make([]string, len(n))
			for i, r := range n {
				parts[i] = fmt.Sprintf("%04X", r)
			}
			text.WriteString(strconv.FormatInt(int64(c), 16) + ":" + strings.Join(parts, " ") + "\n")
		}
	}
	for c := rune(0); c <= 0x323FF; c++ {
		if c < 0xD800 || c > 0xDFFF {
			line(c)
		}
	}
	for c := rune(0xE0000); c <= 0xE01EF; c++ {
		line(c)
	}
	sum := sha256.Sum256([]byte(text.String()))
	if got := hex.EncodeToString(sum[:]); got != v.Sections.Normalize.Sweep["NFD"] {
		t.Errorf("NFD sweep digest %s, gateway %s", got, v.Sections.Normalize.Sweep["NFD"])
	}
}
