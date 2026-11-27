package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

func TestLinkedLoginLegacyFallbackWithNumericPassword(t *testing.T) {
	path := copySeed(t, t.TempDir())
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	hash, err := auth.HashPassword(jsvalue.Str("synthetic-linked-password"), "$2b$04$abcdefghijklmnopqrstuu")
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO users
		(username,password_hash,created_at,auth_mode,server_username,server_password_hash,server_offline_verifier,server_offline_verifier_version)
		VALUES ('fixture-local','','2026-01-01','server','fixture-linked',?,?,1)`, hash, hash)
	if err != nil {
		t.Fatal(err)
	}

	// Missing v1 identity selects the fallback despite a stored verifier.
	// flows.json auth-process-result:176–181 calls bcryptjs.compareSync
	// with the original number, so auth-catch-http500 answers 500.
	t.Setenv("LINK_GATEWAY_DEVICE_EUI", "")
	t.Setenv("DEVICE_EUI", "")
	b := &backend{db: db}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"fixture-linked","password":123}`))
	r.Header.Set("Content-Type", "application/json")
	b.ServeHTTP(w, r)
	if w.Code != http.StatusInternalServerError || w.Body.String() != `{"message":"Authentication request failed"}` {
		t.Fatalf("linked numeric login = %d %s, want auth 500", w.Code, w.Body.String())
	}
}
