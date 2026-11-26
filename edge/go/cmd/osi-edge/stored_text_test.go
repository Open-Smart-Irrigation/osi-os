package main

import (
	"context"
	"math"
	"net/http/httptest"
	"testing"
)

// The backend's driver returns TEXT as node-sqlite3 hands it to the flows
// (UTF-8 decoded with V8's maximal-subpart replacement) and leaves BLOBs,
// numbers and NULL alone; comparisons inside SQLite still see stored bytes.
func TestNodeTextDriverDecodesText(t *testing.T) {
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cases := []struct{ hex, want string }{
		{"752D38FF", "u-8\uFFFD"},
		{"752D61E282", "u-a\uFFFD"},               // truncated sequence: one replacement
		{"752D62EDA080", "u-b\uFFFD\uFFFD\uFFFD"}, // encoded surrogate: three
		{"752D63C0AF", "u-c\uFFFD\uFFFD"},         // overlong: two
		{"7A2D6F6B", "z-ok"},                      // valid text unchanged
		{"EFBBBF61", "\uFEFFa"},                   // a BOM is kept
		{"6100FF", "a\x00\uFFFD"},                 // NUL kept, then replaced byte
	}
	for _, c := range cases {
		var got string
		if err := db.QueryRow("SELECT CAST(X'" + c.hex + "' AS TEXT)").Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("TEXT X'%s' = %q, want %q", c.hex, got, c.want)
		}
	}
	var blob []byte
	var stored storedValue
	if err := db.QueryRow("SELECT X'FF00', CAST(X'FF' AS BLOB)").Scan(&blob, &stored); err != nil {
		t.Fatal(err)
	}
	if string(blob) != "\xff\x00" {
		t.Errorf("BLOB changed: %x", blob)
	}
	if raw, ok := stored.raw.([]byte); !ok || string(raw) != "\xff" {
		t.Errorf("storedValue BLOB = %#v", stored.raw)
	}
	// Binding the decoded string finds no row whose stored bytes are invalid,
	// as node-sqlite3's rebinding of the decoded string does not.
	if _, err := db.Exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES(CAST(X'752D38FF' AS TEXT))"); err != nil {
		t.Fatal(err)
	}
	var decoded string
	if err := db.QueryRow("SELECT v FROM t").Scan(&decoded); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT count(*) FROM t WHERE v=?", decoded).Scan(&n); err != nil || n != 0 {
		t.Errorf("rebinding the decoded value matched %d rows (err %v)", n, err)
	}
	if err := db.QueryRow("SELECT count(*) FROM t WHERE v=CAST(X'752D38FF' AS TEXT)").Scan(&n); err != nil || n != 1 {
		t.Errorf("an SQL comparison must still see the stored bytes: %d (err %v)", n, err)
	}
}

// Number(owner) !== userId, as the valve, schedule and cancel routes compare.
func TestOwnedByOther(t *testing.T) {
	for _, c := range []struct {
		raw   any
		other bool
	}{
		{nil, false}, {int64(160), false}, {int64(161), true},
		{"0xA0", false}, {" 160", false}, {"160.0", false}, {[]byte(" 160"), false}, {[]byte("+160"), false},
		{"abc", true}, {"", true}, {[]byte{}, true}, {"160abc", true}, {160.5, true}, {1e300, true}, {math.Inf(1), true},
	} {
		if got := ownedByOther(storedOf(c.raw), 160); got != c.other {
			t.Errorf("owner %#v: ownedByOther=%t, want %t", c.raw, got, c.other)
		}
	}
}

// The claim fence compares String(stored) with String(Number(existing)).
func TestSameClaimValue(t *testing.T) {
	n := func(v float64) *float64 { return &v }
	for _, c := range []struct {
		stored any
		fence  *float64
		same   bool
	}{
		{nil, nil, true}, {nil, n(0), false}, {int64(240), nil, false},
		{int64(240), n(240), true}, {[]byte("240"), n(240), true}, {"0xF0", n(240), false},
		{[]byte(" 240"), n(240), false}, {[]byte("+240"), n(240), false}, {240.5, n(240.5), true},
		{"abc", n(math.NaN()), false},
	} {
		if got := sameClaimValue(storedOf(c.stored), c.fence); got != c.same {
			t.Errorf("stored %#v fence %v: same=%t, want %t", c.stored, c.fence, got, c.same)
		}
	}
}

// `${owner}` in SQL text: NaN and ±Infinity stay in the text as identifiers.
func TestSQLiteNumberText(t *testing.T) {
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, c := range []struct {
		n    float64
		want string
	}{
		{math.NaN(), "SQLITE_ERROR: no such column: NaN"},
		{math.Inf(1), "SQLITE_ERROR: no such column: Infinity"},
		{math.Inf(-1), "SQLITE_ERROR: no such column: Infinity"},
	} {
		text, args := sqliteNumberText(c.n)
		var id int64
		err := db.QueryRow("SELECT id FROM irrigation_zones WHERE id=1 AND user_id="+text, args...).Scan(&id)
		if err == nil || zoneDBMessage(err) != c.want {
			t.Errorf("%v: err %v, want %s", c.n, err, c.want)
		}
	}
	if text, args := sqliteNumberText(240.5); text != "?" || len(args) != 1 {
		t.Errorf("a finite owner binds: %q %v", text, args)
	}
}

// N1/N2: a SQLite failure inside the dispatch re-check, or while queuing its
// rejection, reaches live-authorize's outer catch: 503 with error.code.
func TestValveDispatchFailureLabels(t *testing.T) {
	if got := jsErrorCode("SQLITE_BUSY: database is locked"); got != "SQLITE_BUSY" {
		t.Errorf("code = %s", got)
	}
	if got := jsErrorCode("resolveScope called without user_uuid"); got != "write_failed" {
		t.Errorf("code = %s", got)
	}
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	b := &backend{db: db}
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO users(id,username,password_hash,created_at,role,user_uuid) VALUES(300,'n1','x','2026-01-01','admin','u-n1');
		INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,created_at,updated_at) VALUES(300,'Z',300,'UTC','z-n1','2026-01-01','2026-01-01');
		INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES('A840410000003001','V','STREGA_VALVE',300,'2026-01-01','2026-01-01',300);
		DROP TABLE user_zone_assignments`); err != nil {
		t.Fatal(err)
	}
	refusal := b.valveDispatchScopeProblem(ctx, "A840410000003001", "u-n1")
	if refusal == nil || refusal.status != 503 || refusal.code != "SQLITE_ERROR" ||
		refusal.message != "SQLITE_ERROR: no such table: user_zone_assignments" {
		t.Fatalf("re-check failure = %+v", refusal)
	}
	if _, err := db.Exec("DROP TABLE applied_commands"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	b.refuseValveDispatch(ctx, w, "A840410000003001", &valveDispatchRefusal{403, "scope_denied", "unknown user"})
	if w.Code != 503 || w.Body.String() != `{"error":"SQLITE_ERROR","message":"SQLITE_ERROR: no such table: applied_commands"}` {
		t.Fatalf("ledger failure = %d %s", w.Code, w.Body.String())
	}
}
