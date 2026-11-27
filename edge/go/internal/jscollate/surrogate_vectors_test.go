package jscollate

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"unicode/utf16"
)

// generate-intl.js collation.lone_surrogate_pairs: UTF-16 code units in hex
// and the sign matrix. Every committed vector file must carry it, so a refresh
// with an older generator cannot drop the gateway's surrogate coverage.
func TestLoneSurrogatePairsMatchNode(t *testing.T) {
	paths := []string{"../../../vectors/intl-x86.vectors.json", vectorsPath(),
		"../../../vectors/intl-gateway-summer.vectors.json", "../../../vectors/intl-gateway-winter.vectors.json",
		"../../../vectors/intl-pi5.vectors.json"}
	checked := 0
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var v struct {
			Sections struct {
				Collation struct {
					Pairs *struct {
						Units [][]string `json:"units"`
						Signs []string   `json:"signs"`
					} `json:"lone_surrogate_pairs"`
				} `json:"collation"`
			} `json:"sections"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		p := v.Sections.Collation.Pairs
		if p == nil {
			t.Fatalf("%s has no lone_surrogate_pairs; regenerate it with edge/vectors/generate-intl.js", path)
		}
		texts := make([][]uint16, len(p.Units))
		for k, units := range p.Units {
			for _, u := range units {
				n, err := strconv.ParseUint(u, 16, 16)
				if err != nil {
					t.Fatal(err)
				}
				texts[k] = append(texts[k], uint16(n))
			}
		}
		for a := range texts {
			for b := range texts {
				want := p.Signs[a][b]
				if got := signOf(CompareUTF16(texts[a], texts[b])); got != want {
					t.Errorf("%s: CompareUTF16(%x, %x) = %c, Node %c", path, texts[a], texts[b], got, want)
				}
				// The same strings through Compare, as jsvalue's WTF-8 bytes.
				if got := signOf(Compare(wtf8(texts[a]), wtf8(texts[b]))); got != want {
					t.Errorf("%s: Compare(WTF-8 %x, %x) = %c, Node %c", path, texts[a], texts[b], got, want)
				}
			}
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no lone-surrogate vectors")
	}
}

func wtf8(text []uint16) string {
	var out []byte
	for _, r := range utf16Runes(text) {
		if utf16.IsSurrogate(r) {
			out = append(out, byte(0xe0|r>>12), byte(0x80|(r>>6)&63), byte(0x80|r&63))
		} else {
			out = append(out, string(r)...)
		}
	}
	return string(out)
}
