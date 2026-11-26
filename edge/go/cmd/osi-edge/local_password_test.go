package main

import (
	"testing"

	"osi-edge/internal/jsvalue"
)

func TestLegacyPasswordPreservesUTF16Equality(t *testing.T) {
	// A TEXT column scanned into any arrives as a Go string.
	var stored any = "legacy\ufffdpassword"
	for _, tc := range []struct {
		input string
		match bool
	}{
		{`"legacy\ufffdpassword"`, true},
		{`"legacy\ud800password"`, false},
	} {
		password, err := jsvalue.Parse([]byte(tc.input))
		if err != nil {
			t.Fatal(err)
		}
		if got := localPasswordMatches(stored, password); got != tc.match {
			t.Errorf("password comparison for %s = %t, want %t", tc.input, got, tc.match)
		}
	}
}
