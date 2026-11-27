// Package csv reproduces the history CSV export bytes of
// osi-history-helper: toCsv (BOM, quoting, formula guard, per-column number
// texts) and the Java-compatible number texts the cloud writes.
// Vectors: edge/vectors/csv.vectors.json.
package csv

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"

	"osi-edge/internal/jsvalue"
)

const (
	maxRows  = 200000
	maxBytes = 8 * 1024 * 1024
)

// JavaDoubleText is Java's Double.toString(x): plain notation with at least
// one fractional digit for 1e-3 <= |x| < 1e7, otherwise d.dddE<n>.
func JavaDoubleText(x float64) string {
	if x == 0 {
		if math.Signbit(x) {
			return "-0.0"
		}
		return "0.0"
	}
	sign := ""
	if x < 0 {
		sign = "-"
	}
	digits, exponent := javaDoubleDecimal(math.Abs(x))
	magnitude := math.Abs(x)
	if magnitude >= 1e-3 && magnitude < 1e7 {
		if exponent < 0 {
			return sign + "0." + strings.Repeat("0", -exponent-1) + digits
		}
		whole := digits
		if len(digits) > exponent+1 {
			whole = digits[:exponent+1]
		} else {
			whole = digits + strings.Repeat("0", exponent+1-len(digits))
		}
		fraction := "0"
		if exponent+1 < len(digits) {
			fraction = digits[exponent+1:]
		}
		return sign + whole + "." + fraction
	}
	fraction := "0"
	if len(digits) > 1 {
		fraction = digits[1:]
	}
	return sign + digits[:1] + "." + fraction + "E" + strconv.Itoa(exponent)
}

// JavaPlainDecimalText is BigDecimal.valueOf(x).stripTrailingZeros()
// .toPlainString(): the same digits as Double.toString, never exponential.
func JavaPlainDecimalText(x float64) string {
	if x == 0 {
		return "0"
	}
	sign := ""
	if x < 0 {
		sign = "-"
	}
	digits, exponent := javaDoubleDecimal(math.Abs(x))
	switch {
	case exponent < 0:
		return sign + "0." + strings.Repeat("0", -exponent-1) + digits
	case exponent+1 >= len(digits):
		return sign + digits + strings.Repeat("0", exponent+1-len(digits))
	default:
		return sign + digits[:exponent+1] + "." + digits[exponent+1:]
	}
}

// javaDoubleDecimal returns the significant digits and decimal exponent of
// the shortest form that round-trips, with the JDK's one-or-two-digit pick
// when a single digit would do.
func javaDoubleDecimal(magnitude float64) (string, int) {
	mantissa, exponent := splitExponential(strconv.FormatFloat(magnitude, 'e', -1, 64))
	if len(mantissa) == 1 {
		twoDigits := strconv.FormatFloat(magnitude, 'e', 1, 64)
		if parsed, err := strconv.ParseFloat(twoDigits, 64); err == nil && parsed == magnitude {
			mantissa, exponent = splitExponential(twoDigits)
		}
	}
	digits := strings.TrimRight(strings.Replace(mantissa, ".", "", 1), "0")
	return digits, exponent
}

func splitExponential(text string) (string, int) {
	separator := strings.IndexByte(text, 'e')
	exponent, _ := strconv.Atoi(text[separator+1:])
	return text[:separator], exponent
}

var (
	pfChannel = regexp.MustCompile(`^swt_.*_pf$`)
	swtPrefix = regexp.MustCompile(`^swt_`)
	formula   = regexp.MustCompile(`^[=+\-@\t\r]`)
)

// ToCsv renders columns and rows with the export limits' default budget
// (200k rows, 8 MiB) enforced.
func ToCsv(columns []string, rows []jsvalue.Value) (string, error) {
	var b strings.Builder
	b.WriteString("\uFEFF")
	b.WriteString(strings.Join(columns, ","))
	b.WriteByte('\n')
	written := 0
	for _, row := range rows {
		if written+1 > maxRows {
			return "", errors.New("Error: export exceeds " + strconv.Itoa(maxRows) + " rows")
		}
		line := renderRow(columns, row)
		if b.Len()+len(line) > maxBytes {
			return "", errors.New("Error: export exceeds the CSV byte budget")
		}
		b.WriteString(line)
		written++
	}
	return b.String(), nil
}

func renderRow(columns []string, row jsvalue.Value) string {
	cells := make([]string, len(columns))
	for i, column := range columns {
		cells[i] = rowCell(row, column)
	}
	return strings.Join(cells, ",") + "\n"
}

func rowCell(row jsvalue.Value, column string) string {
	if column == "value" {
		if text, ok := swtCsvValueText(row); ok {
			return text
		}
	}
	return cell(row.Get(column))
}

// swtCsvValueText carries the matric-potential contract: kPa as a plain
// decimal, derived pF as Java Double.toString.
func swtCsvValueText(row jsvalue.Value) (string, bool) {
	value := row.Get("value")
	if value.Kind != jsvalue.Number || math.IsNaN(value.Num) || math.IsInf(value.Num, 0) {
		return "", false
	}
	channel := ""
	if key := row.Get("channel_key"); key.Truthy() {
		channel = key.MustString()
	}
	unit := row.Get("unit").MustString()
	if unit == "pF" && pfChannel.MatchString(channel) {
		return JavaDoubleText(value.Num), true
	}
	if unit == "kPa" && swtPrefix.MatchString(channel) {
		return JavaPlainDecimalText(value.Num), true
	}
	return "", false
}

func cell(value jsvalue.Value) string {
	if value.Kind == jsvalue.Null || value.Kind == jsvalue.Undefined {
		return ""
	}
	text := value.MustString()
	if value.Kind != jsvalue.Number && formula.MatchString(text) {
		text = "'" + text
	}
	if strings.ContainsAny(text, "\",\n\r") {
		return "\"" + strings.ReplaceAll(text, "\"", "\"\"") + "\""
	}
	return text
}
