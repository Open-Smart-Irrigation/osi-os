package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

const testNodeREDModules = "../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red"

func copySeed(t *testing.T, root string) string {
	t.Helper()
	seed, err := os.ReadFile("../../../../database/farming.db")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "/data/db/farming.db")
	writeFixture(t, path, seed)
	return path
}

func writeFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFixture(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func fixtureSQL(t *testing.T, path, statement string) []byte {
	t.Helper()
	output, err := exec.Command("sqlite3", path, statement).CombinedOutput()
	if err != nil {
		t.Fatalf("sqlite3: %v\n%s", err, output)
	}
	return output
}

func TestSessionRefreshStartupParity(t *testing.T) {
	const oldKey = "synthetic-cutover-session-key"
	const firstUser = "cutover-fixture"
	const insert = "INSERT INTO users (id,username,password_hash,created_at) VALUES (1,'cutover-fixture','synthetic-legacy-password','2026-01-01');"
	const otherKey = "synthetic-unused-fallback-key"
	const secondPath = "/var/lib/node-red/.node-red/osi_auth_token_secret"
	const firstPath = "/data/db/osi_auth_token_secret"

	goRoot, nodeRoot := t.TempDir(), t.TempDir()
	writeFixture(t, filepath.Join(goRoot, "etc/osi-backend"), []byte("edge\n"))
	procRoot := t.TempDir()
	goDB := copySeed(t, goRoot)
	fixtureSQL(t, goDB, insert)
	nodeDB := filepath.Join(nodeRoot, "/data/db/farming.db")
	writeFixture(t, nodeDB, readFixture(t, goDB))
	for _, root := range []string{goRoot, nodeRoot} {
		writeFixture(t, filepath.Join(root, firstPath), []byte(oldKey+"\n"))
		writeFixture(t, filepath.Join(root, secondPath), []byte(otherKey+"\n"))
	}
	rowsBefore := fixtureSQL(t, goDB, ".dump")
	t.Setenv("OSI_EDGE_DATA_ROOT", goRoot)
	t.Setenv("OSI_EDGE_PROC_ROOT", procRoot)
	t.Setenv("OSI_EDGE_DB", "")
	t.Setenv("OSI_EDGE_MQTT_URL", "")
	t.Setenv("AUTH_TOKEN_SECRET", "")
	t.Setenv("JWT_SECRET", "")
	t.Setenv("OSI_SCOPED_ACCESS", "0")
	t.Setenv("OSI_EDGE_HTTP_ADDR", "invalid-test-address")

	oldToken, err := auth.Issue(oldKey, jsvalue.Num(1), jsvalue.Str(firstUser), jsvalue.Value{}, time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the real startup path up to ListenAndServe without binding a port.
	var listenErr *net.OpError
	if err := run(); !errors.As(err, &listenErr) || listenErr.Op != "listen" {
		t.Fatalf("startup did not reach the HTTP listener: %v", err)
	}
	marker := readFixture(t, imagePath(sessionRefreshMarker))
	refresh, err := jsvalue.Parse(marker)
	if err != nil || refresh.Get("status").ToString() != "rotated" {
		t.Fatalf("Go startup marker = %q, %v", marker, err)
	}
	now := refresh.Get("at").ToString()
	if _, err := time.Parse(time.RFC3339Nano, now); err != nil {
		t.Fatalf("startup marker time: %v", err)
	}
	runNodeSessionRefresh(t, nodeRoot, nodeDB, now, oldToken)

	if got := readFixture(t, filepath.Join(nodeRoot, sessionRefreshMarker)); !bytes.Equal(got, marker) {
		t.Fatalf("marker mismatch: Go %q, JS %q", marker, got)
	}
	for _, root := range []string{goRoot, nodeRoot} {
		path := filepath.Join(root, firstPath)
		key := readFixture(t, path)
		_, err := hex.DecodeString(string(bytes.TrimSuffix(key, []byte("\n"))))
		if len(key) != 97 || key[96] != '\n' || err != nil {
			t.Fatal("rotated key is not 48 random bytes encoded as hex with a newline")
		}
		if got := readFixture(t, filepath.Join(root, secondPath)); string(got) != otherKey+"\n" {
			t.Fatal("rotation changed the lower-priority secret")
		}
		for _, file := range []string{path, filepath.Join(root, sessionRefreshMarker)} {
			info, err := os.Stat(file)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("mode of %s = %o", filepath.Base(file), info.Mode().Perm())
			}
		}
	}
	for _, db := range []string{goDB, nodeDB} {
		if rows := fixtureSQL(t, db, ".dump"); !bytes.Equal(rows, rowsBefore) {
			t.Fatal("session rotation changed database rows")
		}
	}
	goKey := readFixture(t, imagePath(firstPath))
	if err := run(); !errors.As(err, &listenErr) || listenErr.Op != "listen" {
		t.Fatalf("second startup did not reach the HTTP listener: %v", err)
	}
	if !bytes.Equal(goKey, readFixture(t, imagePath(firstPath))) ||
		!bytes.Equal(marker, readFixture(t, imagePath(sessionRefreshMarker))) {
		t.Fatal("restart repeated the one-time refresh")
	}

	db, err := openDB(goDB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	b := &backend{db: db}
	checkSession := func(token string, want int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("GET /api/me = %d, want %d", w.Code, want)
		}
	}
	checkSession(oldToken, http.StatusUnauthorized)
	newToken, err := auth.Issue(string(bytes.TrimSpace(goKey)), jsvalue.Num(1), jsvalue.Str(firstUser), jsvalue.Value{}, time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	checkSession(newToken, http.StatusOK)
}

func runNodeSessionRefresh(t *testing.T, root, dbPath, now, oldToken string) {
	t.Helper()
	const script = `
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [modulePath, root, dbPath, now, oldToken] = process.argv.slice(1);
const { refreshSessionsOnce, SESSION_REFRESH_MARKER, SESSION_SECRET_PATHS } = require(modulePath + '/osi-local-password-reset');
const { verifyBearer } = require(modulePath + '/osi-scope-helper');
const crypto = require('node:crypto');
const authOptions = { fs: { readFileSync: (file, ...args) => fs.readFileSync(path.join(root, file), ...args) } };
const header = 'Bearer ' + oldToken;
(async () => {
    assert.equal(verifyBearer(header, authOptions).userId, 1);
    const result = await refreshSessionsOnce({
        fs, crypto, execFile: require('node:child_process').execFile,
        env: process.env, now, dbPath, markerPath: path.join(root, SESSION_REFRESH_MARKER),
        secretPaths: SESSION_SECRET_PATHS.map(file => path.join(root, file)),
    });
    assert.equal(result.status, 'rotated');
    assert.throws(() => verifyBearer(header, authOptions), { statusCode: 401, message: 'Invalid token' });
})().catch(err => { console.error(err); process.exitCode = 1; });`
	output, err := exec.Command("node", "-e", script, testNodeREDModules, root, dbPath, now, oldToken).CombinedOutput()
	if err != nil {
		t.Fatalf("Node-RED session refresh: %v\n%s", err, output)
	}
}
