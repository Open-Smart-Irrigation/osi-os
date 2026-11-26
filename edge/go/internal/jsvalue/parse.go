package jsvalue

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

func Parse(data []byte) (Value, error) {
	data = DecodeUTF8(data)
	if !json.Valid(data) {
		return Value{}, errors.New("invalid JSON")
	}
	p := parser{data: data}
	return p.value(), nil
}

// Grammar is validated above. Decoding strings here preserves the original
// UTF-16 code units, including unpaired escaped surrogates.
type parser struct {
	data []byte
	at   int
}

func (p *parser) space() {
	for p.at < len(p.data) && strings.ContainsRune(" \t\r\n", rune(p.data[p.at])) {
		p.at++
	}
}

func (p *parser) value() Value {
	p.space()
	switch p.data[p.at] {
	case 'n':
		p.at += 4
		return Nil()
	case 't':
		p.at += 4
		return Bool(true)
	case 'f':
		p.at += 5
		return Bool(false)
	case '"':
		return Value{Kind: String, Text: p.text()}
	case '[':
		p.at++
		p.space()
		result := Arr()
		for p.data[p.at] != ']' {
			result.List = append(result.List, p.value())
			p.space()
			if p.data[p.at] == ',' {
				p.at++
			}
		}
		p.at++
		return result
	case '{':
		return p.object()
	default:
		start := p.at
		for p.at < len(p.data) && strings.ContainsRune("-+.eE0123456789", rune(p.data[p.at])) {
			p.at++
		}
		number, _ := strconv.ParseFloat(string(p.data[start:p.at]), 64)
		return Num(number)
	}
}

func (p *parser) object() Value {
	const indexThreshold = 12
	p.at++
	p.space()
	result := Obj()
	var positions map[string]int
	for p.data[p.at] != '}' {
		key := p.text()
		p.space()
		p.at++ // colon
		field := Field{Key: key, Value: p.value()}
		if positions == nil && len(result.Fields) == indexThreshold {
			positions = make(map[string]int, 2*indexThreshold)
			for i, existing := range result.Fields {
				positions[objectKey(existing.Key)] = i
			}
		}
		if positions == nil {
			result.Set(field)
		} else {
			encoded := objectKey(key)
			if i, exists := positions[encoded]; exists {
				result.Fields[i].Value = field.Value
			} else {
				positions[encoded] = len(result.Fields)
				result.Fields = append(result.Fields, field)
			}
		}
		p.space()
		if p.data[p.at] == ',' {
			p.at++
			p.space()
		}
	}
	p.at++
	return result
}

// The index uses code units so different lone surrogates stay distinct.
func objectKey(units []uint16) string {
	bytes := make([]byte, 0, 2*len(units))
	for _, unit := range units {
		bytes = binary.LittleEndian.AppendUint16(bytes, unit)
	}
	return string(bytes)
}

func (v *Value) Set(field Field) {
	for i := range v.Fields {
		if slices.Equal(v.Fields[i].Key, field.Key) {
			v.Fields[i].Value = field.Value
			return
		}
	}
	v.Fields = append(v.Fields, field)
}

func (p *parser) text() []uint16 {
	p.at++ // opening quote
	var text []uint16
	for p.data[p.at] != '"' {
		if p.data[p.at] != '\\' {
			r, size := utf8.DecodeRune(p.data[p.at:])
			text = utf16.AppendRune(text, r)
			p.at += size
			continue
		}
		p.at++
		c := p.data[p.at]
		p.at++
		switch c {
		case 'u':
			unit, _ := strconv.ParseUint(string(p.data[p.at:p.at+4]), 16, 16)
			text = append(text, uint16(unit))
			p.at += 4
		case 'b':
			text = append(text, '\b')
		case 'f':
			text = append(text, '\f')
		case 'n':
			text = append(text, '\n')
		case 'r':
			text = append(text, '\r')
		case 't':
			text = append(text, '\t')
		default:
			text = append(text, uint16(c))
		}
	}
	p.at++
	return text
}
