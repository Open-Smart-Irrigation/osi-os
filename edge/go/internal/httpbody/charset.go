package httpbody

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

var charsetDecoration = regexp.MustCompile(`:[0-9]{4}$|[^a-z0-9]`)

func decodeJSONCharset(data []byte, charset string) ([]byte, error) {
	if !strings.HasPrefix(charset, "utf-") {
		return nil, errors.New("unsupported JSON charset")
	}
	var units []uint16
	switch charsetDecoration.ReplaceAllString(charset, "") {
	case "utf8":
		return decodeUTF8(data), nil
	case "utf16":
		units = decodeUTF16(data, utf16Order(data))
	case "utf16le":
		units = decodeUTF16(data, binary.LittleEndian)
	case "utf16be":
		units = decodeUTF16(data, binary.BigEndian)
	case "utf7":
		units = decodeUTF7(data, '+', '/')
	case "utf7imap":
		units = decodeUTF7(data, '&', ',')
	default:
		return nil, errors.New("unsupported JSON charset")
	}
	return jsonFromUTF16(units)
}

// iconv-lite's unsuffixed UTF-16 uses the BOM, then the first 64 bytes to
// infer byte order, with little endian as the default.
func utf16Order(data []byte) binary.ByteOrder {
	if len(data) >= 2 {
		switch binary.BigEndian.Uint16(data) {
		case 0xfeff:
			return binary.BigEndian
		case 0xfffe:
			return binary.LittleEndian
		}
	}
	bigEndian := 0
	for i := 0; i+1 < min(64, len(data)); i += 2 {
		switch {
		case data[i] == 0 && data[i+1] != 0:
			bigEndian++
		case data[i] != 0 && data[i+1] == 0:
			bigEndian--
		}
	}
	if bigEndian > 0 {
		return binary.BigEndian
	}
	return binary.LittleEndian
}

func decodeUTF16(data []byte, order binary.ByteOrder) []uint16 {
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = order.Uint16(data[2*i:])
	}
	return units
}

func decodeUTF7(data []byte, shift, slash byte) []uint16 {
	units := make([]uint16, 0, len(data))
	for i := 0; i < len(data); {
		if data[i] != shift {
			units = append(units, uint16(data[i]&0x7f))
			i++
			continue
		}
		i++
		start := i
		for i < len(data) && utf7Digit(data[i], slash) {
			i++
		}
		encoded := strings.ReplaceAll(string(data[start:i]), string(slash), "/")
		if start == i && i < len(data) && data[i] == '-' {
			units = append(units, uint16(shift))
		} else {
			decoded, _ := base64.RawStdEncoding.DecodeString(encoded)
			segment := decodeUTF16(decoded, binary.BigEndian)
			units = append(units, stripUTF16BOM(segment)...)
		}
		if i < len(data) && data[i] == '-' {
			i++
		}
	}
	return units
}

func utf7Digit(c, slash byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		c == '+' || c == '/' || c == slash
}

func stripUTF16BOM(units []uint16) []uint16 {
	if len(units) != 0 && units[0] == 0xfeff {
		return units[1:]
	}
	return units
}

// JSON.parse preserves lone UTF-16 surrogates in strings. Escape those units
// before passing the source to jsvalue, which uses UTF-8 input.
func jsonFromUTF16(units []uint16) ([]byte, error) {
	units = stripUTF16BOM(units)
	data := make([]byte, 0, len(units))
	quoted, escaped := false, false
	for i := 0; i < len(units); i++ {
		r := rune(units[i])
		if utf16.IsSurrogate(r) {
			if !quoted || escaped {
				return nil, errors.New("invalid UTF-16 in JSON syntax")
			}
			if i+1 < len(units) {
				if pair := utf16.DecodeRune(r, rune(units[i+1])); pair != utf8.RuneError {
					data = utf8.AppendRune(data, pair)
					i++
					continue
				}
			}
			const hex = "0123456789abcdef"
			data = append(data, '\\', 'u', hex[r>>12], hex[(r>>8)&15], hex[(r>>4)&15], hex[r&15])
			continue
		}
		switch {
		case escaped:
			escaped = false
		case quoted && r == '\\':
			escaped = true
		case r == '"':
			quoted = !quoted
		}
		data = utf8.AppendRune(data, r)
	}
	return data, nil
}
