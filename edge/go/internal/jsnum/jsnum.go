// Package jsnum reproduces the JavaScript number semantics the flows depend
// on: Math.round (halves toward +Infinity), Number.prototype.toFixed and
// String(number). Vectors: edge/vectors/js-number.vectors.json.
package jsnum

import (
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// String renders n as JavaScript's Number::toString(10): the shortest decimal
// that round-trips, positional for 1e-6 <= |n| < 1e21, scientific outside,
// with -0 rendered as "0".
func String(n float64) string {
	if math.IsNaN(n) {
		return "NaN"
	}
	if math.IsInf(n, 1) {
		return "Infinity"
	}
	if math.IsInf(n, -1) {
		return "-Infinity"
	}
	return string(appendNumber(nil, n))
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
	if i := strings.IndexByte(scientific, 'e'); i >= 0 && scientific[i+2] == '0' {
		scientific = scientific[:i+2] + scientific[i+3:]
	}
	return append(out, scientific...)
}

// Round is Math.round: halves round toward +Infinity, values in (-0.5, 0]
// keep the negative zero sign, and NaN/Inf pass through. The fractional part
// is compared exactly rather than adding 0.5 in float64, which would round
// 0.49999999999999994 up to 1 before the floor ever runs.
func Round(n float64) float64 {
	if math.IsNaN(n) || math.IsInf(n, 0) || n == 0 {
		return n
	}
	if math.Abs(n) >= 4503599627370496 { // 2^52: already integral
		return n
	}
	floor := math.Floor(n)
	frac := n - floor // exact: both operands share magnitude class
	r := floor
	if frac >= 0.5 { // includes exact ties, which move toward +Infinity
		r = floor + 1
	}
	if r == 0 && math.Signbit(n) {
		return math.Copysign(0, -1)
	}
	return r
}

// ToFixed is Number.prototype.toFixed(digits): the exact binary value of n
// rounded to digits decimals, ties choosing the larger scaled integer (the
// sign is handled before scaling, so ties move away from zero). |n| >= 1e21
// returns String(n), as the specification does.
func ToFixed(n float64, digits int) (string, error) {
	if digits < 0 || digits > 100 {
		return "", errors.New("RangeError: toFixed() digits argument must be between 0 and 100")
	}
	if math.IsNaN(n) {
		return "NaN", nil
	}
	if math.IsInf(n, 1) {
		return "Infinity", nil
	}
	if math.IsInf(n, -1) {
		return "-Infinity", nil
	}
	if math.Abs(n) >= 1e21 {
		return String(n), nil
	}
	sign := ""
	if n < 0 {
		sign = "-"
	}
	scaled := new(big.Rat).Mul(new(big.Rat).SetFloat64(math.Abs(n)), pow10(digits))
	k, rem := new(big.Int).QuoRem(scaled.Num(), scaled.Denom(), new(big.Int))
	doubled := rem.Lsh(rem, 1)
	if doubled.Cmp(scaled.Denom()) >= 0 {
		k.Add(k, big.NewInt(1))
	}
	digitsText := k.String()
	if digits == 0 {
		return sign + digitsText, nil
	}
	if len(digitsText) <= digits {
		digitsText = strings.Repeat("0", digits+1-len(digitsText)) + digitsText
	}
	return sign + digitsText[:len(digitsText)-digits] + "." + digitsText[len(digitsText)-digits:], nil
}

func pow10(n int) *big.Rat {
	r := new(big.Rat).SetInt64(1)
	return r.Mul(r, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)))
}
