// Package jsvalue models the JSON values used by the JavaScript wire contract.
package jsvalue

import (
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf16"
)

type Kind uint8

const (
	Undefined Kind = iota
	Null
	Boolean
	Number
	String
	Array
	Object
)

// Value distinguishes absent fields, nulls and strings containing lone UTF-16
// surrogates. Object properties retain their creation order.
type Value struct {
	Kind   Kind
	Bool   bool
	Num    float64
	Text   []uint16
	List   []Value
	Fields []Field
}

type Field struct {
	Key   []uint16
	Value Value
}

func Property(key string, value Value) Field {
	return Field{Key: Str(key).Text, Value: value}
}

func Str(s string) Value   { return Value{Kind: String, Text: utf16.Encode([]rune(DecodeUTF8(s)))} }
func Num(n float64) Value  { return Value{Kind: Number, Num: n} }
func Bool(b bool) Value    { return Value{Kind: Boolean, Bool: b} }
func Obj(f ...Field) Value { return Value{Kind: Object, Fields: f} }
func Arr(v ...Value) Value { return Value{Kind: Array, List: v} }
func Nil() Value           { return Value{Kind: Null} }

func (v Value) Get(key string) Value {
	for i := len(v.Fields) - 1; i >= 0; i-- {
		if string(utf16.Decode(v.Fields[i].Key)) == key {
			return v.Fields[i].Value
		}
	}
	return Value{}
}

func (v Value) Truthy() bool {
	switch v.Kind {
	case Undefined, Null:
		return false
	case Boolean:
		return v.Bool
	case Number:
		return v.Num != 0 && !math.IsNaN(v.Num)
	case String:
		return len(v.Text) != 0
	default:
		return true
	}
}

// ToString converts a value without raising exceptions.
//
// Deprecated: Use CoerceString, StringValue or MustString for runtime data.
func (v Value) ToString() string { return v.stringWithoutThrow() }

func (v Value) stringWithoutThrow() string {
	switch v.Kind {
	case Undefined:
		return "undefined"
	case Null:
		return "null"
	case Boolean:
		return strconv.FormatBool(v.Bool)
	case Number:
		if math.IsInf(v.Num, 1) {
			return "Infinity"
		}
		if math.IsInf(v.Num, -1) {
			return "-Infinity"
		}
		return string(appendNumber(nil, v.Num))
	case String:
		return string(utf16.Decode(v.Text))
	case Array:
		parts := make([]string, len(v.List))
		for i, member := range v.List {
			if member.Kind != Undefined && member.Kind != Null {
				parts[i] = member.stringWithoutThrow()
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// PrimitiveConversionError is V8's message for a failed JSON value conversion.
const PrimitiveConversionError = "Cannot convert object to primitive value"

// StringThrows reports whether converting v to a string would throw.
//
// Deprecated: Call the conversion itself and handle its error.
func (v Value) StringThrows() bool {
	_, err := v.StringValue()
	return err != nil
}

func (v Value) OrEmpty() Value {
	if !v.Truthy() {
		return Str("")
	}
	return v
}

// ToNumber converts a value without raising exceptions.
//
// Deprecated: Use CoerceNumber or MustNumber for runtime data.
func (v Value) ToNumber() float64 { return v.numberWithoutThrow() }

func (v Value) numberWithoutThrow() float64 {
	switch v.Kind {
	case Null:
		return 0
	case Boolean:
		if v.Bool {
			return 1
		}
		return 0
	case Number:
		return v.Num
	case String, Array:
		s := Trim(v.stringWithoutThrow())
		switch s {
		case "":
			return 0
		case "Infinity", "+Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		}
		if len(s) > 2 && s[0] == '0' && strings.ContainsRune("xXoObB", rune(s[1])) {
			if strings.ContainsRune(s, '_') {
				return math.NaN()
			}
			n, err := strconv.ParseUint(s, 0, 64)
			if err == nil {
				return float64(n)
			}
			if errors.Is(err, strconv.ErrRange) {
				if integer, ok := new(big.Int).SetString(s, 0); ok {
					n, _ := integer.Float64()
					return n
				}
			}
			return math.NaN()
		}
		if strings.ContainsAny(s, "_xXpPiInN") {
			return math.NaN()
		}
		n, err := strconv.ParseFloat(s, 64)
		if err == nil || math.IsInf(n, 0) {
			return n
		}
	}
	return math.NaN()
}

// Trim implements ECMAScript's WhiteSpace and LineTerminator sets.
func Trim(s string) string { return strings.TrimFunc(s, jsSpace) }

// Latin1 decodes raw bytes one code unit per byte, as Node decodes HTTP
// header values, and returns the result as UTF-8.
func Latin1(raw string) string {
	runes := make([]rune, len(raw))
	for i := 0; i < len(raw); i++ {
		runes[i] = rune(raw[i])
	}
	return string(runes)
}

func (v Value) TrimmedString() Value { return must(v.CoerceTrimmedString()) }

func (v Value) CoerceTrimmedString() (Value, error) {
	text, err := v.StringValue()
	if err != nil {
		return Value{}, err
	}
	start, end := 0, len(text.Text)
	for start < end && jsSpace(rune(text.Text[start])) {
		start++
	}
	for start < end && jsSpace(rune(text.Text[end-1])) {
		end--
	}
	return Value{Kind: String, Text: text.Text[start:end]}, nil
}

func jsSpace(r rune) bool {
	return r >= 0x2000 && r <= 0x200a ||
		strings.ContainsRune("\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
}

// UTF8 returns the equivalent of Node's Buffer.from(string). Bcryptjs uses
// the three-byte encoding of a lone surrogate instead of substituting U+FFFD.
func (v Value) UTF8(bcrypt bool) []byte {
	out := make([]byte, 0, len(v.Text))
	for i := 0; i < len(v.Text); i++ {
		r := rune(v.Text[i])
		if utf16.IsSurrogate(r) {
			if i+1 < len(v.Text) {
				if pair := utf16.DecodeRune(r, rune(v.Text[i+1])); pair != '\ufffd' {
					out = appendRune(out, pair)
					i++
					continue
				}
			}
			if !bcrypt {
				r = '\ufffd'
			}
		}
		out = appendRune(out, r)
	}
	return out
}
