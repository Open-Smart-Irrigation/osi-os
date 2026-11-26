package main

import (
	"context"
	"encoding/base64"
	"math"
	"testing"

	"osi-edge/internal/jsvalue"
)

// storedValue follows what node-sqlite3 hands the flows for each storage class.
func TestStoredValueJSSemantics(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var text, blob, empty, integer, real, null, invalid storedValue
	err = db.QueryRow("SELECT 'u-1', CAST('u-1' AS BLOB), x'', 2, 2.5, NULL, CAST(x'ff' AS TEXT)").
		Scan(&text, &blob, &empty, &integer, &real, &null, &invalid)
	if err != nil {
		t.Fatal(err)
	}
	if !blob.truthy() || !empty.truthy() || null.truthy() || !empty.notNull() || null.notNull() {
		t.Fatal("truthiness or != null differs from a Buffer/null")
	}
	if _, ok := blob.key(); ok {
		t.Fatal("a Buffer has no Set key")
	}
	if storedStrictEqual(blob, blob) || !storedStrictEqual(text, storedOf("u-1")) || !storedStrictEqual(null, null) {
		t.Fatal("=== differs")
	}
	if !storedOf("admin").is("admin") || storedOf([]byte("admin")).is("admin") {
		t.Fatal("=== 'admin' differs")
	}
	if got, _ := jsvalue.Stringify(blob.json()); string(got) != `{"type":"Buffer","data":[117,45,49]}` {
		t.Fatalf("Buffer JSON = %s", got)
	}
	if got, _ := jsvalue.Stringify(empty.json()); string(got) != `{"type":"Buffer","data":[]}` {
		t.Fatalf("empty Buffer JSON = %s", got)
	}
	if invalid.jsString() != "�" || storedOf([]byte{0xff}).jsString() != "�" {
		t.Fatal("String() must decode with replacement")
	}
	if integer.number() != 2 || real.number() != 2.5 || storedOf([]byte("0x2")).number() != 2 || !math.IsNaN(storedOf("abc").number()) {
		t.Fatal("Number() differs")
	}
	if storedOf(math.Inf(1)).number() != math.Inf(1) {
		t.Fatal("Number(Infinity) differs")
	}
}

// Number(user.server_offline_verifier_version || 1), as the login flow reads it.
func TestVerifierVersionNumber(t *testing.T) {
	for _, c := range []struct {
		raw  any
		want float64
	}{
		{nil, 1}, {int64(0), 1}, {int64(2), 2}, {2.5, 2.5}, {math.Inf(1), math.Inf(1)}, {"", 1},
		{" 2 ", 2}, {[]byte("2"), 2}, {[]byte{}, 0}, {[]byte("0x2"), 2},
	} {
		got := account{verifierVersion: storedOf(c.raw)}.verifierVersionNumber()
		if got != c.want {
			t.Errorf("Number(%#v || 1) = %v, want %v", c.raw, got, c.want)
		}
	}
	if !math.IsNaN(account{verifierVersion: storedOf("abc")}.verifierVersionNumber()) {
		t.Error("Number('abc') must be NaN")
	}
}

// A BLOB user_uuid binds back as a BLOB: the scope helpers find the BLOB row
// and only BLOB grants, never the TEXT twin with the same bytes.
func TestScopeHelpersBindStorageClass(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, user_uuid TEXT UNIQUE, role TEXT, disabled_at TEXT)`,
		`CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY, user_id INTEGER, zone_uuid TEXT, deleted_at TEXT)`,
		`CREATE TABLE user_zone_assignments (user_uuid TEXT, zone_uuid TEXT, deleted_at TEXT)`,
		`INSERT INTO users VALUES (1,'u-twin','admin',NULL), (2,CAST('u-twin' AS BLOB),'viewer',x'')`,
		`INSERT INTO irrigation_zones VALUES (10,1,'z-text',NULL), (11,2,CAST('z-blob' AS BLOB),NULL)`,
		`INSERT INTO user_zone_assignments VALUES ('u-twin','z-granted',NULL), (CAST('u-twin' AS BLOB),'z-blob-grant',NULL)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	blobUUID := storedOf([]byte("u-twin"))
	user, problem := loadScopeUser(ctx, db, blobUUID)
	if problem != nil || user.id != 2 || !user.disabled {
		t.Fatalf("BLOB uuid loaded %+v %v, want the disabled BLOB row", user, problem)
	}
	if _, problem := assertFreshRole(ctx, db, blobUUID, storedOf("viewer")); problem == nil || problem.message != "account disabled" {
		t.Fatalf("assertFreshRole = %v", problem)
	}
	if _, problem := loadScopeUser(ctx, db, storedOf([]byte{})); problem == nil || problem.status != 403 {
		t.Fatalf("an empty Buffer is truthy and finds no row: %v", problem)
	}
	if _, problem := loadScopeUser(ctx, db, storedOf("")); problem == nil || problem.status != 500 {
		t.Fatalf("an empty string is falsy: %v", problem)
	}
	keys, problem := zoneScopeKeys(ctx, db, scopeUser{id: 2}, blobUUID)
	if problem != nil {
		t.Fatal(problem)
	}
	if len(keys) != 1 || !keys["s:z-blob-grant"] {
		t.Fatalf("zone keys %v: the owned BLOB zone has no key, only the BLOB grant matches", keys)
	}
	if _, problem := assertFreshRole(ctx, db, storedOf("u-twin"), storedOf([]byte("admin"))); problem == nil || problem.message != "insufficient role" {
		t.Fatalf("a Buffer role is never === the stored role: %v", problem)
	}
}

// linkedGatewayDeviceEui reads String(user.server_sync_token || ”).trim():
// a BLOB token decodes as text, and an empty Buffer is ” (DEVICE_EUI wins).
func TestLinkedGatewayStoredToken(t *testing.T) {
	t.Setenv("LINK_GATEWAY_DEVICE_EUI", "")
	t.Setenv("DEVICE_EUI", "0016C001F1000001")
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"gateway_device_eui":"0016c001f1000002"}`))
	for _, c := range []struct {
		token any
		want  string
	}{
		{[]byte(" h." + payload + ".s "), "0016C001F1000002"},
		{"h." + payload + ".s", "0016C001F1000002"},
		{[]byte{}, "0016C001F1000001"},
		{nil, "0016C001F1000001"},
	} {
		if got := linkedGateway(account{syncToken: storedOf(c.token)}); got != c.want {
			t.Errorf("linkedGateway(%#v) = %q, want %q", c.token, got, c.want)
		}
	}
}
