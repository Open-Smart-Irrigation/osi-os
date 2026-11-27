package auth

import (
	"testing"

	"osi-edge/internal/jsvalue"
)

// Node decodes the Authorization header as latin1 before trim(): a 0xA0 byte
// is U+00A0 and is trimmed; the UTF-8 bytes of NBSP (C2 A0) or EM SPACE
// (E2 80 83) are other characters and break the signature.
func TestBearerHeaderLatin1Trim(t *testing.T) {
	secret := func() (string, error) { return "synthetic-smoke-secret", nil }
	token, err := Issue("synthetic-smoke-secret", jsvalue.Num(2), jsvalue.Str("nbsp-review"), jsvalue.Value{}, 1700000000000)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		header string
		valid  bool
	}{
		{"Bearer " + token, true},
		{"Bearer " + token + "\xa0", true},
		{"Bearer \xa0" + token, true},
		{"Bearer " + token + "\xa0\t\xa0", true},
		{"Bearer " + token + "\xc2\xa0", false},
		{"Bearer \xc2\xa0" + token, false},
		{"Bearer " + token + "\xe2\x80\x83", false},
		{"Bearer " + token + "\x85", false},
	} {
		_, failure := VerifyBearerPayload(c.header, secret)
		if (failure == nil) != c.valid {
			t.Errorf("%q: valid %v, want %v", c.header, failure == nil, c.valid)
		}
	}
}
