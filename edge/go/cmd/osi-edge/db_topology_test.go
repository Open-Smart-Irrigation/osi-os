package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSharedConnectionTopology: the backend opens farming.db as osi-db-helper
// does, ONE connection for reads and writes with its PRAGMAS
// (osi-db-helper/index.js:14-20), and keeps that connection open.
func TestSharedConnectionTopology(t *testing.T) {
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if got := db.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("MaxOpenConnections = %d, want 1", got)
	}
	want := map[string]string{
		"journal_mode":       "wal",
		"synchronous":        "1", // NORMAL
		"foreign_keys":       "1",
		"busy_timeout":       "5000",
		"wal_autocheckpoint": "1000",
	}
	for name, value := range want {
		var got any
		if err := db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(got) != value {
			t.Errorf("PRAGMA %s = %v, want %s", name, got, value)
		}
	}
	// The order osi-db-helper runs them in.
	var order []string
	for _, p := range sharedConnectionPragmas {
		order = append(order, p[:strings.IndexByte(p, '(')])
	}
	if got := strings.Join(order, ","); got != "journal_mode,synchronous,foreign_keys,busy_timeout,wal_autocheckpoint" {
		t.Errorf("pragma order = %s", got)
	}
	// One statement after another reuses the connection: it stays open.
	for i := 0; i < 3; i++ {
		var one int
		if err := db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
			t.Fatal(err)
		}
	}
	if stats := db.Stats(); stats.OpenConnections != 1 || stats.MaxIdleClosed != 0 || stats.MaxLifetimeClosed != 0 || stats.MaxIdleTimeClosed != 0 {
		t.Errorf("connection was not kept: %+v", stats)
	}
}

// TestSharedConnectionQueuesSecondUser: while a transaction holds the only
// connection, another statement waits for it instead of opening a second one.
func TestSharedConnectionQueuesSecondUser(t *testing.T) {
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		var one int
		done <- db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
	}()
	select {
	case err := <-done:
		t.Fatalf("second statement ran while the transaction held the connection: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if open := db.Stats().OpenConnections; open != 1 {
		t.Errorf("open connections = %d, want 1", open)
	}
}

// The watchdog stays off unless asked for.
func TestDBWatchdogOffByDefault(t *testing.T) {
	if os.Getenv("OSI_EDGE_DB_WATCHDOG") != "" {
		t.Skip("OSI_EDGE_DB_WATCHDOG set in the test environment")
	}
	db, err := openDB(copySeed(t, filepath.Join(t.TempDir())))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startDBWatchdog(ctx, db)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
}
