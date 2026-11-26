package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"

	"osi-edge/internal/jsnum"
	"osi-edge/internal/jsvalue"
)

// Decode the Gen1 fields consumed by local reporting and the plan ACK ledger.
// The vendor decoder returns a telemetry object even for an unrecognized frame.
func decodeValveGen1(raw, port jsvalue.Value) jsvalue.Value {
	if !raw.Truthy() {
		return jsvalue.Value{}
	}
	encoded, err := raw.CoerceString()
	if err != nil {
		return jsvalue.Value{}
	}
	// The vendor call coerces fPort even though the fields ported here
	// depend on the bytes. Its fallback catches conversion exceptions.
	if _, err := port.OrEmpty().CoerceNumber(); err != nil {
		return jsvalue.Value{}
	}
	payload := strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/':
			return r
		case r == '-':
			return '+'
		case r == '_':
			return '/'
		default:
			return -1
		}
	}, strings.SplitN(encoded, "=", 2)[0])
	frame, _ := base64.RawStdEncoding.DecodeString(payload)
	p := jsvalue.Property
	decoded := jsvalue.Obj()
	if len(frame) == 0 {
		return decoded
	}
	kind := frame[0] >> 4
	part := func(start, end int) string {
		return string(frame[min(start, len(frame)):min(end, len(frame))])
	}
	switch kind {
	case 3, 7, 11, 15:
		if kind == 3 || kind == 11 {
			battery := part(0, 4)
			if kind == 11 {
				battery = fmt.Sprintf("%x%s", frame[0]&15, part(2, 5))
			}
			voltage := jsvalue.Str(battery).MustNumber()
			decoded.Set(p("Battery", jsvalue.Num(jsnum.Round((voltage-2000)/16))))
		}
		if len(frame) >= 5 && frame[4]>>4 >= 3 && frame[4]>>4 <= 9 {
			decoded.Set(p("Valve", jsvalue.Str(strconv.Itoa(int(frame[4]&1)))))
		}
		if len(frame) >= 6 && frame[5] == '@' {
			port, _ := strconv.ParseUint(part(6, 8), 16, 8)
			status := jsvalue.Str(part(8, 10))
			switch {
			case port == 12 || port == 13:
				decoded.Set(p("RTC_Port", jsvalue.Num(float64(port))))
				decoded.Set(p("RTC_status", status))
			case port >= 14 && port <= 20:
				decoded.Set(p("Schl_Port", jsvalue.Num(float64(port))))
				decoded.Set(p("Schl_status", status))
			case port == 21:
				decoded.Set(p("Schl_status_Port", jsvalue.Num(21)))
				decoded.Set(p("Schl_status_ack", status))
			}
		}
		if len(frame) >= 8 && gen1HasEnvironment(frame) {
			temp := binary.BigEndian.Uint16(frame[6:8])
			humidity := uint16(0)
			if len(frame) >= 10 {
				humidity = binary.BigEndian.Uint16(frame[8:10])
			}
			if temp != 65535 || humidity != 65535 {
				decoded.Set(p("Temperature", jsvalue.Num(jsnum.Round((float64(temp)*165/65536-40)*100)/100)))
				if len(frame) >= 9 {
					if len(frame) == 9 {
						humidity = uint16(frame[8])
					}
					decoded.Set(p("Hygrometry", jsvalue.Num(jsnum.Round(float64(humidity)*10000/65536)/100)))
				}
			}
		}
	}
	return decoded
}

func gen1HasEnvironment(frame []byte) bool {
	byteAt := func(index int) byte {
		if index >= len(frame) {
			return 0
		}
		return frame[index]
	}
	return byteAt(5) == '#' && byteAt(12) != 'V' &&
		(byteAt(10) == 'C' || byteAt(17) != 'V')
}
