package jsvalue

import (
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// DecodeUTF8 uses Node's replacement rules for malformed UTF-8, preserving a BOM.
func DecodeUTF8[T ~string | ~[]byte](data T) T {
	raw := []byte(data)
	if utf8.Valid(raw) {
		return data
	}
	decoded := make([]byte, 0, len(raw))
	for len(raw) != 0 {
		r, size := utf8.DecodeRune(raw)
		if r == utf8.RuneError && size == 1 {
			// Replace the longest prefix that could still be one valid rune.
			for size < len(raw) && !utf8.FullRune(raw[:size+1]) {
				size++
			}
		}
		decoded = utf8.AppendRune(decoded, r)
		raw = raw[size:]
	}
	return T(decoded)
}

type runeRange struct{ first, last rune }

type caseSpan struct {
	first, last   rune
	delta, stride rune
}

func hasRune(r rune, ranges []runeRange) bool {
	i, _ := slices.BinarySearchFunc(ranges, r, func(span runeRange, r rune) int {
		return int(span.last - r)
	})
	return i < len(ranges) && ranges[i].first <= r
}

func mapCase(r rune, spans []caseSpan) rune {
	i, _ := slices.BinarySearchFunc(spans, r, func(span caseSpan, r rune) int {
		return int(span.last - r)
	})
	if i < len(spans) {
		span := spans[i]
		if r >= span.first && (r-span.first)%span.stride == 0 {
			return r + span.delta
		}
	}
	return r
}

// Upper and Lower implement the locale-independent JavaScript string methods.
func Upper(s string) string { return caseText(DecodeUTF8(s), upperSpans, upperExpansions, false) }
func Lower(s string) string { return caseText(DecodeUTF8(s), lowerSpans, lowerExpansions, true) }

func caseText(s string, spans []caseSpan, expansions map[rune]string, lower bool) string {
	var result strings.Builder
	copied := 0
	precededByCased := false
	hasSigma := lower && strings.ContainsRune(s, 'Σ')
	for i, r := range s {
		mapped := mapCase(r, spans)
		width := utf8.RuneLen(r)
		if hasSigma {
			if r == 'Σ' && precededByCased && !followedByCased(s[i+width:]) {
				mapped = 'ς'
			}
			if !hasRune(r, caseIgnorableRanges) {
				precededByCased = hasRune(r, casedRanges)
			}
		}
		expansion := expansions[r]
		if mapped == r && expansion == "" {
			continue
		}
		if result.Cap() == 0 {
			result.Grow(len(s))
		}
		result.WriteString(s[copied:i])
		if expansion != "" {
			result.WriteString(expansion)
		} else {
			result.WriteRune(mapped)
		}
		copied = i + width
	}
	if copied == 0 {
		return s
	}
	result.WriteString(s[copied:])
	return result.String()
}

func followedByCased(s string) bool {
	for _, r := range s {
		if !hasRune(r, caseIgnorableRanges) {
			return hasRune(r, casedRanges)
		}
	}
	return false
}

// UpperCase and LowerCase preserve lone surrogates in JS strings.
func (v Value) UpperCase() Value { return v.caseString(Upper) }
func (v Value) LowerCase() Value { return v.caseString(Lower) }

func (v Value) caseString(casing func(string) string) Value {
	source := must(v.StringValue()).Text
	var result []uint16
	start := 0
	for i := 0; i < len(source); i++ {
		if !utf16.IsSurrogate(rune(source[i])) {
			continue
		}
		if i+1 < len(source) && utf16.DecodeRune(rune(source[i]), rune(source[i+1])) != utf8.RuneError {
			i++
			continue
		}
		result = append(result, Str(casing(string(utf16.Decode(source[start:i])))).Text...)
		result = append(result, source[i])
		start = i + 1
	}
	result = append(result, Str(casing(string(utf16.Decode(source[start:])))).Text...)
	return Value{Kind: String, Text: result}
}
