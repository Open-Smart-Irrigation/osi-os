package main

import (
	"testing"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

func TestSplicedLiteralError(t *testing.T) {
	cases := []struct {
		values []string
		want   string
	}{
		{[]string{"farmer"}, ""},
		{[]string{"nul\x00user"}, `SQLITE_ERROR: unrecognized token: "'nul"`},
		{[]string{"\x00nul"}, `SQLITE_ERROR: unrecognized token: "'"`},
		{[]string{"o'nul\x00x"}, `SQLITE_ERROR: unrecognized token: "'o''nul"`},
		{[]string{"A840410000005000\x00"}, `SQLITE_ERROR: unrecognized token: "'A840410000005000"`},
		// Statement order: the first failing value decides.
		{[]string{"ok", "b\x00", "a\x00"}, `SQLITE_ERROR: unrecognized token: "'b"`},
	}
	for _, c := range cases {
		err := splicedLiteralError(c.values...)
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != c.want {
			t.Errorf("splicedLiteralError(%q) = %q, want %q", c.values, got, c.want)
		}
	}
	session := auth.Session{UserID: 1, Username: jsvalue.Str("x\x00")}
	if err := legacyUserLookupError(session); err == nil || err.Error() != `SQLITE_ERROR: unrecognized token: "'x"` {
		t.Errorf("legacyUserLookupError = %v", err)
	}
}

func TestSignedNullPayload(t *testing.T) {
	text := func(s string) *auth.AuthError {
		return &auth.AuthError{Status: 401, Message: "Invalid token", SignedPayload: &s}
	}
	for raw, want := range map[string]bool{
		"null":          true,
		" \n\tnull\r ":  true,
		"\u00a0null":    false, // JSON.parse refuses NBSP; String.prototype.trim would not
		"\ufeffnull":    false,
		"null\x00":      false,
		"{\"userId\":1": false,
		"nul":           false,
	} {
		if got := signedNullPayload(text(raw)); got != want {
			t.Errorf("signedNullPayload(%q) = %v, want %v", raw, got, want)
		}
	}
	if signedNullPayload(nil) || signedNullPayload(&auth.AuthError{Status: 401}) {
		t.Error("signedNullPayload without a signed payload")
	}
}

func TestValveWriterDevice(t *testing.T) {
	for eui, want := range map[string]string{
		"A840410000006010":                  "A840410000006010",
		"a840410000006010":                  "A840410000006010",
		"  A840410000006011\t":              "A840410000006011",
		"A84041000000600":                   "",
		"A8404100000060011":                 "",
		"A84041000000600Z":                  "",
		"A8-40-41-00-00-00-60-02":           "",
		"A840410000006003,A840410000006003": "",
		"A8404100 00006004":                 "",
	} {
		got, err := valveWriterDevice(eui)
		if want == "" {
			if err == nil || err.Error() != "device_eui must be a 16-character hexadecimal EUI" {
				t.Errorf("valveWriterDevice(%q) = %q, %v; want the dispatch.js error", eui, got, err)
			}
		} else if err != nil || got != want {
			t.Errorf("valveWriterDevice(%q) = %q, %v; want %q", eui, got, err, want)
		}
	}
}

// Expected texts from JSON.parse in Node (V8 templates without the
// "(line N column M)" suffix, which V8 11.3 does not print).
func TestLegacyConfigTokenErrorUnexpectedToken(t *testing.T) {
	for raw, want := range map[string]string{
		"\u00a0null":     "Unexpected token '\u00a0', \"\u00a0null\" is not valid JSON",
		"\ufeffnull":     "Unexpected token '\ufeff', \"\ufeffnull\" is not valid JSON",
		"x":              "Unexpected token 'x', \"x\" is not valid JSON",
		"[1,]":           "Unexpected token ']', \"[1,]\" is not valid JSON",
		"{\"a\":\u00e9}": "Unexpected token '\u00e9', \"{\"a\":\u00e9}\" is not valid JSON",
		"undefined":      "\"undefined\" is not valid JSON",
		"\u00a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":               "Unexpected token '\u00a0', \"\u00a0aaaaaaaaa\"... is not valid JSON",
		"[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,]": "Unexpected token ']', ...\"1,1,1,1,1,]\" is not valid JSON",
		"[1,1,1,1,1,1,1,1,1,1,1,x,1,1,1,1,1,1,1,1,1,1,1,1,1,1]":  "Unexpected token 'x', ...\"1,1,1,1,1,x,1,1,1,1,\"... is not valid JSON",
		"[1 2]":           "Expected ',' or ']' after array element in JSON at position 3",
		"{\"a\":1 \"b\"}": "Expected ',' or '}' after property value in JSON at position 7",
	} {
		if got := legacyConfigTokenError(raw); got != want {
			t.Errorf("legacyConfigTokenError(%q) = %q, want %q", raw, got, want)
		}
	}
}
