package auth

import (
	"errors"
	"regexp"
	"strings"

	"osi-edge/internal/jsvalue"
)

var installationUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func GatewayEUI(value string) string {
	raw := jsvalue.Upper(strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F' {
			return r
		}
		return -1
	}, value))
	if len(raw) == 12 {
		return raw[:6] + "FFFE" + raw[6:]
	}
	if len(raw) == 16 && raw != "0101010101010101" {
		return raw
	}
	return ""
}

func VerifierSubject(password, version jsvalue.Value, installation, gateway string) (jsvalue.Value, error) {
	var identity string
	if version.MustNumber() >= 2 {
		identity = jsvalue.Lower(jsvalue.Trim(installation))
		if !installationUUID.MatchString(identity) {
			return jsvalue.Value{}, errors.New("installation identity is required for verifier v2")
		}
	} else {
		identity = GatewayEUI(gateway)
		if identity == "" {
			return jsvalue.Value{}, errors.New("gateway identity is required for verifier v1")
		}
	}
	subject := password.OrEmpty()
	if subject.Kind != jsvalue.String {
		subject = jsvalue.Str(subject.MustString())
	}
	text := append([]uint16(nil), subject.Text...)
	text = append(text, jsvalue.Str("::"+identity).Text...)
	return jsvalue.Value{Kind: jsvalue.String, Text: text}, nil
}
