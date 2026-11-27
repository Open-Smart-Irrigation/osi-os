package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"math/big"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func tlsCheckServer(t *testing.T) (pool *x509.CertPool, port string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	root := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "OSI Test Root"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	rootDER, err := x509.CreateCertificate(rand.Reader, root, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	rootCert, _ := x509.ParseCertificate(rootDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, rootCert, &leafKey.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); conn.(*tls.Conn).Handshake() }()
		}
	}()
	pool = x509.NewCertPool()
	pool.AddCert(rootCert)
	_, port, _ = net.SplitHostPort(listener.Addr().String())
	return pool, port
}

func TestTLSCheckUsesBrokerAndCloudLink(t *testing.T) {
	pool, port := tlsCheckServer(t)
	root := t.TempDir()
	dbPath := filepath.Join(root, "farming.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, server_url TEXT, server_linked_at TEXT);
		INSERT INTO users VALUES (1, 'https://old.invalid', '2026-01-01'), (2, ' https://localhost:` + port + `/ ', '2026-02-01'), (3, '', '2026-03-01')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	t.Setenv("OSI_EDGE_DATA_ROOT", root)
	t.Setenv("OSI_EDGE_DB", dbPath)
	t.Setenv("OSI_CLOUD_BROKER_URL", "wss://localhost:"+port+"/mqtt")

	var out bytes.Buffer
	if status := runTLSCheck(&out, pool); status != 0 {
		t.Fatalf("status %d with the test root: %s", status, out.String())
	}
	if strings.Count(out.String(), "verified") != 2 || !strings.Contains(out.String(), "cloud REST localhost:"+port) {
		t.Errorf("output: %s", out.String())
	}
	out.Reset()
	// The binary passes nil: exactly Node's roots, which lack the test root.
	if status := runTLSCheck(&out, nil); status != 1 || strings.Count(out.String(), "certificate not signed by a trusted root") != 2 {
		t.Errorf("status %d with the production roots: %s", status, out.String())
	}

	out.Reset()
	t.Setenv("OSI_CLOUD_BROKER_URL", "ws://localhost:"+port+"/mqtt")
	t.Setenv("OSI_EDGE_DB", filepath.Join(root, "absent.db"))
	if status := runTLSCheck(&out, pool); status != 1 || !strings.Contains(out.String(), "read the cloud link") {
		t.Errorf("an unreadable database must refuse: %d %s", status, out.String())
	}
}

// On a gateway Node-RED holds farming.db in WAL mode while the check runs;
// the read-only open must still read the cloud link.
func TestTLSCheckReadsWALDatabaseWhileAWriterHoldsIt(t *testing.T) {
	root := t.TempDir()
	dbPath := filepath.Join(root, "farming.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var mode string
	if err := db.QueryRow("PRAGMA journal_mode=WAL").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode %q, %v", mode, err)
	}
	if _, err := db.Exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, server_url TEXT, server_linked_at TEXT);
		INSERT INTO users VALUES (1, 'https://127.0.0.1:1', '2026-02-01')`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("INSERT INTO users VALUES (2, 'https://uncommitted.invalid', '2026-03-01')"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OSI_EDGE_DATA_ROOT", root)
	t.Setenv("OSI_EDGE_DB", dbPath)
	t.Setenv("OSI_CLOUD_BROKER_URL", "")
	server, err := cloudServerURL()
	if err != nil || server != "https://127.0.0.1:1" {
		t.Fatalf("cloud link %q, %v; want the committed row", server, err)
	}
}
