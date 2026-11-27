package jsvalue

import (
	"math"
	"slices"
	"time"
	"unicode/utf16"

	"osi-edge/internal/jsdate"
)

// JSError is a JavaScript exception raised by a conversion.
type JSError struct {
	Name    string
	Message string
}

func (e *JSError) Error() string { return e.Message }

type Hint uint8

const (
	DefaultHint Hint = iota
	NumberHint
	StringHint
)

// ToPrimitive implements OrdinaryToPrimitive for JSON values. With the string
// hint, toString is tried before valueOf. With the number or default hint,
// valueOf is tried first. In this model valueOf can only be shadowed by a
// non-callable value, or return its receiver, so neither order can obtain a
// primitive from valueOf. JSON cannot supply callable methods or symbol keys.
func (v Value) ToPrimitive(hint Hint) (Value, error) {
	if v.Kind != Object && v.Kind != Array {
		return v, nil
	}
	order := [2]string{"valueOf", "toString"}
	if hint == StringHint {
		order[0], order[1] = order[1], order[0]
	}
	for _, method := range order {
		if v.hasOwn(method) || method == "valueOf" {
			continue
		}
		if v.Kind == Object {
			return Str("[object Object]"), nil
		}
		if v.hasOwn("join") {
			return Str("[object Array]"), nil
		}
		var text []uint16
		for i, element := range v.List {
			if i > 0 {
				text = append(text, ',')
			}
			if element.Kind == Null || element.Kind == Undefined {
				continue
			}
			part, err := element.StringValue()
			if err != nil {
				return Value{}, err
			}
			text = append(text, part.Text...)
		}
		return Value{Kind: String, Text: text}, nil
	}
	return Value{}, &JSError{Name: "TypeError", Message: PrimitiveConversionError}
}

func (v Value) hasOwn(key string) bool {
	units := Str(key).Text
	for _, f := range v.Fields {
		if slices.Equal(f.Key, units) {
			return true
		}
	}
	return false
}

// StringValue retains JS string code units, including lone surrogates.
func (v Value) StringValue() (Value, error) {
	value, err := v.ToPrimitive(StringHint)
	if err != nil {
		return Value{}, err
	}
	if value.Kind == String {
		return value, nil
	}
	return Str(value.stringWithoutThrow()), nil
}

func (v Value) CoerceString() (string, error) {
	value, err := v.StringValue()
	return string(utf16.Decode(value.Text)), err
}

func (v Value) CoerceNumber() (float64, error) {
	value, err := v.ToPrimitive(NumberHint)
	if err != nil {
		return 0, err
	}
	return value.numberWithoutThrow(), nil
}

func (v Value) ToInt32() (int32, error) {
	n, err := v.CoerceNumber()
	if err != nil {
		return 0, err
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, nil
	}
	return int32(uint32(int64(math.Trunc(math.Mod(n, 4294967296))))), nil
}

// Date models new Date(value). An invalid date has ok=false and a nil error.
func (v Value) Date(loc *time.Location) (at time.Time, ok bool, err error) {
	value, err := v.ToPrimitive(DefaultHint)
	if err != nil {
		return time.Time{}, false, err
	}
	if value.Kind == String {
		at, ok = jsdate.Parse(string(utf16.Decode(value.Text)), loc)
	} else {
		at, ok = jsdate.FromMilliseconds(value.numberWithoutThrow())
	}
	return at, ok, nil
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func (v Value) MustString() string  { return must(v.CoerceString()) }
func (v Value) MustNumber() float64 { return must(v.CoerceNumber()) }
func (v Value) MustInt32() int32    { return must(v.ToInt32()) }
func (v Value) MustDate(loc *time.Location) (time.Time, bool) {
	at, ok, err := v.Date(loc)
	return must(at, err), ok
}

// CatchConversion translates a conversion panic into an error at a local
// JavaScript try/catch. Defer it directly from a function with a named error.
func CatchConversion(err *error) {
	if problem := recover(); problem != nil {
		if exception, ok := problem.(*JSError); ok {
			*err = exception
			return
		}
		panic(problem)
	}
}
