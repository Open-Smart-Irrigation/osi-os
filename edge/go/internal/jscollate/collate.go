// Package jscollate is String.prototype.localeCompare as the gateway's Node
// runs it: Node 20.18.3 built with small ICU 75.1 (locales en and root), whose
// default collator is the CLDR 45 root collation (en has no tailoring) at
// tertiary strength, alternate non-ignorable, normalization off.
//
// V8 turns ICU's normalization on (ECMA-402 wants canonically equivalent
// strings to compare equal), so this is the UCA (UTS #10, version 15.1) over
// allkeys_CLDR.txt after NFD: contractions match contiguously and then
// discontiguously over unblocked non-starters, Unified_Ideographs take the
// CLDR root radical-stroke order (FractionalUCA's [radical] lines, which
// replaces the UCA's implicit Han weights), and other code points without a
// mapping take UCA implicit weights. edge/vectors/intl-gateway.vectors.json
// (the guest's own output) is the reference; intl_vectors_test.go checks it.
// tables.bin.gz comes from gen_tables.go.
package jscollate

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/binary"
	"io"
	"slices"
	"sync"
	"unicode/utf8"
)

//go:embed tables.bin.gz
var tablesGz []byte

type element struct {
	primary, secondary uint16
	tertiary           uint8
}

type span struct{ first, last rune }

type cccSpan struct {
	first, last rune
	ccc         uint8
}

type data struct {
	single     map[rune][]element
	contracted map[string][]element
	// prefixes holds every proper prefix of a contraction.
	prefixes  map[string]bool
	ccc       []cccSpan
	decompose map[rune][]rune
	// han maps a Unified_Ideograph to its rank in radical-stroke order.
	han map[rune]int32
	// siniform lists the assigned Tangut, Nushu and Khitan code points.
	siniform []span
}

var tables = sync.OnceValue(func() *data {
	zr, err := gzip.NewReader(bytes.NewReader(tablesGz))
	if err != nil {
		panic(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		panic(err)
	}
	pos := 0
	u8 := func() uint8 { pos++; return raw[pos-1] }
	u16 := func() uint16 { pos += 2; return binary.LittleEndian.Uint16(raw[pos-2:]) }
	u24 := func() rune { pos += 3; return rune(raw[pos-3]) | rune(raw[pos-2])<<8 | rune(raw[pos-1])<<16 }
	u32 := func() int { pos += 4; return int(binary.LittleEndian.Uint32(raw[pos-4:])) }
	d := &data{single: make(map[rune][]element), contracted: make(map[string][]element), prefixes: make(map[string]bool)}
	for range u32() {
		key := make([]rune, u8())
		for i := range key {
			key[i] = u24()
		}
		ces := make([]element, u8())
		for i := range ces {
			ces[i] = element{u16(), u16(), u8()}
		}
		if len(key) == 1 {
			d.single[key[0]] = ces
			continue
		}
		d.contracted[string(key)] = ces
		for i := 1; i < len(key); i++ {
			d.prefixes[string(key[:i])] = true
		}
	}
	d.ccc = make([]cccSpan, u32())
	for i := range d.ccc {
		d.ccc[i] = cccSpan{u24(), u24(), u8()}
	}
	steps := make(map[rune][]rune)
	for range u32() {
		c := u24()
		parts := make([]rune, u8())
		for i := range parts {
			parts[i] = u24()
		}
		steps[c] = parts
	}
	d.decompose = make(map[rune][]rune, len(steps))
	var full func(r rune) []rune
	full = func(r rune) []rune {
		parts, ok := steps[r]
		if !ok {
			return []rune{r}
		}
		var out []rune
		for _, p := range parts {
			out = append(out, full(p)...)
		}
		return out
	}
	for c := range steps {
		d.decompose[c] = full(c)
	}
	d.han = make(map[rune]int32, 97680)
	rank := int32(0)
	for range u32() {
		first, last := u24(), u24()
		for c := first; c <= last; c++ {
			d.han[c] = rank
			rank++
		}
	}
	d.siniform = make([]span, u32())
	for i := range d.siniform {
		d.siniform[i] = span{u24(), u24()}
	}
	// Mappings that reach a Han character through UCA implicit weights
	// (Kangxi radicals, CJK strokes, squared ideographs) take its rank.
	remap := func(ces []element) {
		for i := 0; i+1 < len(ces); i++ {
			a, b := rune(ces[i].primary), rune(ces[i+1].primary)
			if a < 0xFB40 || a > 0xFBBF || b < 0x8000 || ces[i+1].secondary != 0 {
				continue
			}
			base := rune(0xFB40)
			if a >= 0xFB80 {
				base = 0xFB80
			}
			if r, ok := d.han[(a-base)<<15|b&0x7FFF]; ok {
				w := hanElements(r)
				ces[i].primary, ces[i+1].primary = w[0].primary, w[1].primary
			}
		}
	}
	for _, ces := range d.single {
		remap(ces)
	}
	for _, ces := range d.contracted {
		remap(ces)
	}
	return d
})

func (d *data) combiningClass(r rune) uint8 {
	i, found := slices.BinarySearchFunc(d.ccc, r, func(s cccSpan, r rune) int {
		switch {
		case s.last < r:
			return -1
		case s.first > r:
			return 1
		}
		return 0
	})
	if found {
		return d.ccc[i].ccc
	}
	return 0
}

func inSpans(spans []span, r rune) bool {
	_, found := slices.BinarySearchFunc(spans, r, func(s span, r rune) int {
		switch {
		case s.last < r:
			return -1
		case s.first > r:
			return 1
		}
		return 0
	})
	return found
}

// hanElements places a Han rank where the UCA puts core Han implicit
// weights: after Tangut, Nushu and Khitan, before unassigned code points.
func hanElements(rank int32) [2]element {
	return [2]element{{uint16(0xFB40 + rank>>15), 0x0020, 0x02}, {uint16(rank&0x7FFF | 0x8000), 0, 0}}
}

// implicit is UTS #10 section 10.1 (UCA 15.1) for a code point with no mapping;
// Unified_Ideographs take their radical-stroke rank instead.
func (d *data) implicit(r rune) [2]element {
	if rank, ok := d.han[r]; ok {
		return hanElements(rank)
	}
	// Unassigned code points in the three blocks take the default base.
	aaaa, bbbb := 0xFBC0+(r>>15), (r&0x7FFF)|0x8000
	if inSpans(d.siniform, r) {
		switch {
		case r >= 0x17000 && r <= 0x18AFF || r >= 0x18D00 && r <= 0x18D8F: // Tangut
			aaaa, bbbb = 0xFB00, (r-0x17000)|0x8000
		case r >= 0x1B170 && r <= 0x1B2FF: // Nushu
			aaaa, bbbb = 0xFB01, (r-0x1B170)|0x8000
		case r >= 0x18B00 && r <= 0x18CFF: // Khitan
			aaaa, bbbb = 0xFB02, (r-0x18B00)|0x8000
		}
	}
	return [2]element{{uint16(aaaa), 0x0020, 0x02}, {uint16(bbbb), 0, 0}}
}

// hangul appends a syllable's jamo (Unicode 3.12), or r itself.
func hangul(out []rune, r rune) []rune {
	const sBase, lBase, vBase, tBase, lCount, vCount, tCount = 0xAC00, 0x1100, 0x1161, 0x11A7, 19, 21, 28
	s := r - sBase
	if s < 0 || s >= lCount*vCount*tCount {
		return append(out, r)
	}
	out = append(out, lBase+s/(vCount*tCount), vBase+(s%(vCount*tCount))/tCount)
	if t := s % tCount; t != 0 {
		out = append(out, tBase+t)
	}
	return out
}

// nfd is the canonical decomposition with canonical reordering.
func (d *data) nfd(input []rune) []rune {
	runes := make([]rune, 0, len(input))
	for _, r := range input {
		if parts, ok := d.decompose[r]; ok {
			runes = append(runes, parts...)
		} else {
			runes = hangul(runes, r)
		}
	}
	for i := 0; i < len(runes); {
		if d.combiningClass(runes[i]) == 0 {
			i++
			continue
		}
		j := i
		for j < len(runes) && d.combiningClass(runes[j]) != 0 {
			j++
		}
		slices.SortStableFunc(runes[i:j], func(a, b rune) int {
			return int(d.combiningClass(a)) - int(d.combiningClass(b))
		})
		i = j
	}
	return runes
}

func (d *data) elements(input []rune) []element {
	runes := d.nfd(input)
	var out []element
	for len(runes) > 0 {
		// S2.1: the longest contiguous match.
		n := 1
		for k := 2; k <= len(runes) && d.prefixes[string(runes[:k-1])]; k++ {
			if _, ok := d.contracted[string(runes[:k])]; ok {
				n = k
			}
		}
		key := slices.Clone(runes[:n])
		rest := runes[n:]
		// S2.1.1-S2.1.3: unblocked non-starters that extend the match.
		if n > 1 || d.prefixes[string(key)] {
			var blocking uint8
			for j := 0; j < len(rest); {
				cc := d.combiningClass(rest[j])
				if cc == 0 {
					break
				}
				if blocking < cc {
					if _, ok := d.contracted[string(append(slices.Clone(key), rest[j]))]; ok {
						key = append(key, rest[j])
						rest = slices.Delete(slices.Clone(rest), j, j+1)
						continue
					}
				}
				blocking = max(blocking, cc)
				j++
			}
		}
		switch {
		case len(key) > 1:
			out = append(out, d.contracted[string(key)]...)
		default:
			if ces, ok := d.single[key[0]]; ok {
				out = append(out, ces...)
			} else {
				implicit := d.implicit(key[0])
				out = append(out, implicit[:]...)
			}
		}
		runes = rest
	}
	return out
}

func compareLevel(a, b []element, weight func(element) uint16) int {
	i, j := 0, 0
	for {
		for i < len(a) && weight(a[i]) == 0 {
			i++
		}
		for j < len(b) && weight(b[j]) == 0 {
			j++
		}
		switch {
		case i == len(a) && j == len(b):
			return 0
		case i == len(a):
			return -1
		case j == len(b):
			return 1
		}
		if wa, wb := weight(a[i]), weight(b[j]); wa != wb {
			if wa < wb {
				return -1
			}
			return 1
		}
		i++
		j++
	}
}

// Compare returns the sign of a.localeCompare(b) on the gateway: -1, 0 or 1.
// The inputs are UTF-8, or WTF-8 where a JS string had a lone surrogate (the
// three-byte form jsvalue's encoder writes). ICU 75.1 collates a lone
// surrogate as its own code point with the UCA implicit weight of an
// unassigned code point (below U+FFFD, above U+0378), not as U+FFFD.
func Compare(a, b string) int {
	if a == b {
		return 0
	}
	d := tables()
	return compareElements(d.elements(wtf8Runes(a)), d.elements(wtf8Runes(b)))
}

// CompareUTF16 is Compare over JS strings' UTF-16 code units, lone
// surrogates included.
func CompareUTF16(a, b []uint16) int {
	if slices.Equal(a, b) {
		return 0
	}
	d := tables()
	return compareElements(d.elements(utf16Runes(a)), d.elements(utf16Runes(b)))
}

// utf16Runes pairs surrogates and keeps unpaired ones as code points, as
// ICU's UTF-16 collation iterator does.
func utf16Runes(text []uint16) []rune {
	out := make([]rune, 0, len(text))
	for i := 0; i < len(text); i++ {
		r := rune(text[i])
		if r >= 0xD800 && r <= 0xDBFF && i+1 < len(text) && text[i+1] >= 0xDC00 && text[i+1] <= 0xDFFF {
			r = 0x10000 + (r-0xD800)<<10 + rune(text[i+1]-0xDC00)
			i++
		}
		out = append(out, r)
	}
	return out
}

// wtf8Runes decodes UTF-8, reading the three-byte encoding of a surrogate
// (ED A0..BF 80..BF) as that surrogate and joining a high one followed by a
// low one; any other invalid byte is U+FFFD, as Go's decoder reads it.
func wtf8Runes(s string) []rune {
	units := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		if i+2 < len(s) && s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF {
			units = append(units, uint16(0xD000|rune(s[i+1]&0x3F)<<6|rune(s[i+2]&0x3F)))
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			hi, lo := 0xD800+(r-0x10000)>>10, 0xDC00+(r-0x10000)&0x3FF
			units = append(units, uint16(hi), uint16(lo))
		} else {
			units = append(units, uint16(r))
		}
		i += size
	}
	return utf16Runes(units)
}

func compareElements(ea, eb []element) int {
	if c := compareLevel(ea, eb, func(e element) uint16 { return e.primary }); c != 0 {
		return c
	}
	if c := compareLevel(ea, eb, func(e element) uint16 { return e.secondary }); c != 0 {
		return c
	}
	return compareLevel(ea, eb, func(e element) uint16 { return uint16(e.tertiary) })
}
