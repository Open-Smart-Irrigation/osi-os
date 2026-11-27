package main

import (
	"testing"

	"osi-edge/internal/jsvalue"
)

// The credential checks rely on the driver keeping the storage class.
func TestStoredValueStorageClass(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var text, blob, empty, integer, real, null any
	err = db.QueryRow("SELECT 'x', CAST('x' AS BLOB), x'', 0, 0.0, NULL").Scan(&text, &blob, &empty, &integer, &real, &null)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := text.(string); !ok {
		t.Fatalf("TEXT scanned as %T", text)
	}
	if _, ok := blob.([]byte); !ok {
		t.Fatalf("BLOB scanned as %T", blob)
	}
	for _, c := range []struct {
		value  any
		truthy bool
	}{{text, true}, {blob, true}, {empty, true}, {integer, false}, {real, false}, {null, false}, {"", false}, {int64(2), true}} {
		if storedTruthy(c.value) != c.truthy {
			t.Errorf("storedTruthy(%#v) = %v", c.value, !c.truthy)
		}
	}
}

// node-sqlite3 returns a BLOB as a Buffer: local values must be strings, and
// a linked BLOB hash makes bcryptjs compareSync throw (500).
func TestNonTextCredentials(t *testing.T) {
	const hash = "$2b$04$8genrpi8vDbNy.S5Cj1Xyer3MvIfd19sjNT0yb7/AW9QlmujB9hnG"
	password := jsvalue.Str("synthetic-pass-1")
	if !localPasswordMatches(hash, password) || !localPasswordMatches("synthetic-pass-1", password) {
		t.Fatal("TEXT controls must match")
	}
	for _, stored := range []any{[]byte("synthetic-pass-1"), []byte(hash), int64(12345), float64(1), nil} {
		if localPasswordMatches(stored, password) || localPasswordMatches(stored, jsvalue.Str("12345")) {
			t.Errorf("local %#v matched", stored)
		}
	}
	for _, c := range []struct {
		hash  any
		throw bool
	}{{[]byte(hash), true}, {[]byte{}, true}, {int64(7), true}, {int64(0), false}, {"", false}, {nil, false}} {
		valid, err := linkedPasswordMatches(account{serverPasswordHash: c.hash}, password)
		if valid || (err != nil) != c.throw {
			t.Errorf("linked %#v: valid %v err %v", c.hash, valid, err)
		}
	}
	if valid, err := linkedPasswordMatches(account{serverPasswordHash: hash, offlineVerifier: []byte(hash)}, password); !valid || err != nil {
		t.Errorf("a BLOB verifier is ignored and the TEXT hash used: valid %v err %v", valid, err)
	}
	if (account{mode: []byte("server")}).linkedMode() || !(account{mode: "server"}).linkedMode() {
		t.Error("only TEXT 'server' is linked")
	}
}
