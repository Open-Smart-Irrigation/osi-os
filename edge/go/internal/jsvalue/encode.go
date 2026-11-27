package jsvalue

import (
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

func Stringify(v Value) ([]byte, error) { return encode(nil, v, false) }
func Canonical(v Value) ([]byte, error) { return encode(nil, v, true) }

func encode(out []byte, v Value, canonical bool) ([]byte, error) {
	switch v.Kind {
	case Null:
		return append(out, "null"...), nil
	case Boolean:
		return strconv.AppendBool(out, v.Bool), nil
	case Number:
		if math.IsNaN(v.Num) || math.IsInf(v.Num, 0) {
			if canonical {
				return nil, errors.New("TypeError: canonical JSON forbids non-finite numbers")
			}
			return append(out, "null"...), nil
		}
		if canonical && v.Num != 0 {
			return strconv.AppendFloat(out, v.Num, 'f', -1, 64), nil
		}
		return appendNumber(out, v.Num), nil
	case String:
		if canonical {
			v = normalizeString(v)
		}
		return appendString(out, v.Text), nil
	case Array:
		out = append(out, '[')
		for i, member := range v.List {
			if i != 0 {
				out = append(out, ',')
			}
			if member.Kind == Undefined && !canonical {
				member = Nil()
			}
			var err error
			out, err = encode(out, member, canonical)
			if err != nil {
				return nil, err
			}
		}
		return append(out, ']'), nil
	case Object:
		fields := slices.Clone(v.Fields)
		if canonical {
			slices.SortFunc(fields, func(a, b Field) int { return slices.Compare(a.Key, b.Key) })
		} else {
			// JavaScript enumerates array-index property keys before other keys.
			slices.SortStableFunc(fields, func(a, b Field) int {
				return strings.Compare(indexKey(a.Key), indexKey(b.Key))
			})
		}
		out = append(out, '{')
		added := false
		for _, field := range fields {
			if field.Value.Kind == Undefined {
				if canonical {
					return nil, errors.New("TypeError: canonical JSON forbids undefined at " + string(utf16.Decode(field.Key)))
				}
				continue
			}
			if added {
				out = append(out, ',')
			}
			added = true
			out = append(appendString(out, field.Key), ':')
			var err error
			out, err = encode(out, field.Value, canonical)
			if err != nil {
				return nil, err
			}
		}
		return append(out, '}'), nil
	default:
		if canonical {
			return nil, errors.New("TypeError: canonical JSON cannot encode undefined")
		}
		return nil, errors.New("TypeError: undefined")
	}
}

func indexKey(key []uint16) string {
	if len(key) == 0 || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return "x"
	}
	var digits [10]byte
	for i, unit := range key {
		if unit < '0' || unit > '9' {
			return "x"
		}
		digits[len(digits)-len(key)+i] = byte(unit)
	}
	for i := 0; i < len(digits)-len(key); i++ {
		digits[i] = '0'
	}
	if string(digits[:]) >= "4294967295" {
		return "x"
	}
	return string(digits[:])
}

func appendNumber(out []byte, n float64) []byte {
	if n == 0 {
		return append(out, '0')
	}
	magnitude := math.Abs(n)
	if magnitude >= 1e-6 && magnitude < 1e21 {
		return strconv.AppendFloat(out, n, 'f', -1, 64)
	}
	scientific := strconv.FormatFloat(n, 'e', -1, 64)
	i := strings.IndexByte(scientific, 'e')
	if i >= 0 && scientific[i+2] == '0' {
		scientific = scientific[:i+2] + scientific[i+3:]
	}
	return append(out, scientific...)
}

func appendString(out []byte, text []uint16) []byte {
	const hex = "0123456789abcdef"
	out = append(out, '"')
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch c {
		case '"', '\\':
			out = append(out, '\\', byte(c))
		case '\b':
			out = append(out, "\\b"...)
		case '\f':
			out = append(out, "\\f"...)
		case '\n':
			out = append(out, "\\n"...)
		case '\r':
			out = append(out, "\\r"...)
		case '\t':
			out = append(out, "\\t"...)
		default:
			r := rune(c)
			if utf16.IsSurrogate(r) && i+1 < len(text) {
				if pair := utf16.DecodeRune(r, rune(text[i+1])); pair != '\ufffd' {
					out = utf8.AppendRune(out, pair)
					i++
					continue
				}
			}
			if c < 0x20 || utf16.IsSurrogate(r) {
				out = append(out, '\\', 'u', hex[c>>12], hex[(c>>8)&15], hex[(c>>4)&15], hex[c&15])
			} else {
				out = utf8.AppendRune(out, r)
			}
		}
	}
	return append(out, '"')
}

func appendRune(out []byte, r rune) []byte {
	if utf16.IsSurrogate(r) {
		// utf8.AppendRune replaces surrogates, which bcryptjs encodes directly.
		return append(out, byte(0xe0|(r>>12)), byte(0x80|((r>>6)&63)), byte(0x80|(r&63)))
	}
	return utf8.AppendRune(out, r)
}
