package store

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// scratchRoot refuses to fall back to /tmp: the spike's rules keep scratch
// under /home/phil/builds/edge-rewrite-20261123/spike (set via env.sh TMPDIR).
func scratchRoot(t *testing.T) string {
	t.Helper()
	root := os.Getenv("TMPDIR")
	if root == "" || strings.HasPrefix(strings.TrimSuffix(root, "/"), "/tmp") {
		t.Fatalf("TMPDIR must point into the spike scratch (source env.sh); got %q", root)
	}
	return root
}

func copySeed(t *testing.T, dir string) string {
	t.Helper()
	source, err := os.Open(filepath.Join("..", "..", "..", "..", "database", "farming.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	dest := filepath.Join(dir, "farming.db")
	// A plain single-file copy: nothing can follow symlinks out of the
	// destination, and the repository file is only ever read.
	destination, err := os.Create(dest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(destination, source); err != nil {
		destination.Close()
		t.Fatal(err)
	}
	if err := destination.Close(); err != nil {
		t.Fatal(err)
	}
	return dest
}

func openCopy(t *testing.T) (*Store, string) {
	t.Helper()
	dir, err := os.MkdirTemp(scratchRoot(t), "osi-store-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	store, err := Open(copySeed(t, dir))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store, dir
}

func pragma(t *testing.T, conn *sql.Conn, name string) string {
	t.Helper()
	var value any
	if err := conn.QueryRowContext(context.Background(), "PRAGMA "+name).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%v", value)
}

func TestOpenSetsWriterPragmas(t *testing.T) {
	store, _ := openCopy(t)
	conn, err := store.DB().Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if got := pragma(t, conn, "journal_mode"); got != "wal" {
		t.Errorf("writer journal_mode = %q, want wal", got)
	}
	if got := pragma(t, conn, "synchronous"); got != "1" { // NORMAL
		t.Errorf("writer synchronous = %q, want 1 (NORMAL)", got)
	}
	if got := pragma(t, conn, "busy_timeout"); got != "5000" {
		t.Errorf("writer busy_timeout = %q, want 5000", got)
	}
	if got := pragma(t, conn, "foreign_keys"); got != "1" {
		t.Errorf("writer foreign_keys = %q, want 1", got)
	}
	if got := pragma(t, conn, "wal_autocheckpoint"); got != "1000" {
		t.Errorf("writer wal_autocheckpoint = %q, want 1000", got)
	}
	if got := store.DB().Stats().MaxOpenConnections; got != 1 {
		t.Errorf("writer MaxOpenConnections = %d, want 1 (osi-db-helper's single shared connection)", got)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	version, err := store.SQLiteVersion()
	if err != nil || version == "" {
		t.Fatalf("sqlite_version = %q, err = %v", version, err)
	}
}

func TestTxBeginImmediateWaitsThenSucceeds(t *testing.T) {
	store, _ := openCopy(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	holderDone := make(chan error, 1)
	go func() {
		holderDone <- store.Tx(ctx, func(tx *sql.Conn) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO app_settings(key, value, updated_at) VALUES('osi-store-test-holder', '1', '2026-01-01T00:00:00.000Z')")
			if err != nil {
				return err
			}
			time.Sleep(400 * time.Millisecond)
			return nil
		})
	}()
	time.Sleep(80 * time.Millisecond) // let the holder take the write lock

	started := time.Now()
	err := store.Tx(ctx, func(tx *sql.Conn) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO app_settings(key, value, updated_at) VALUES('osi-store-test-waiter', '1', '2026-01-01T00:00:00.000Z')")
		return err
	})
	if err != nil {
		t.Fatalf("second BEGIN IMMEDIATE transaction failed: %v", err)
	}
	if waited := time.Since(started); waited < 250*time.Millisecond {
		t.Errorf("second transaction returned after %v; it should have waited for the write lock", waited)
	}
	if err := <-holderDone; err != nil {
		t.Fatalf("holder transaction failed: %v", err)
	}
	var rows int
	if err := store.DB().QueryRowContext(ctx, "SELECT COUNT(*) FROM app_settings WHERE key LIKE 'osi-store-test-%'").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Errorf("committed rows = %d, want 2", rows)
	}
}

func TestTxBeginImmediateFailsBusyAfterShortTimeout(t *testing.T) {
	store, dir := openCopy(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	release := make(chan struct{})
	holderDone := make(chan error, 1)
	go func() {
		holderDone <- store.Tx(ctx, func(tx *sql.Conn) error {
			<-release
			return nil
		})
	}()
	time.Sleep(80 * time.Millisecond)

	// A separate writer with a deliberately short busy_timeout must fail
	// with SQLITE_BUSY once its wait expires, while the holder keeps the
	// write lock.
	impatient, err := sql.Open("sqlite", dsn(filepath.Join(dir, "farming.db"), [][2]string{{"busy_timeout", "300"}, {"foreign_keys", "ON"}}))
	if err != nil {
		t.Fatal(err)
	}
	defer impatient.Close()
	conn, err := impatient.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	started := time.Now()
	_, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE")
	if err == nil {
		conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		close(release)
		t.Fatal("BEGIN IMMEDIATE succeeded while the write lock was held")
	}
	if waited := time.Since(started); waited < 250*time.Millisecond {
		t.Errorf("busy failure after %v; the connection should have waited its timeout", waited)
	}
	if !isBusy(err) {
		t.Errorf("error is not SQLITE_BUSY: %v", err)
	}
	close(release)
	if err := <-holderDone; err != nil {
		t.Fatalf("holder transaction failed: %v", err)
	}
}

// TestBackupQueuesBehindAnOpenTransaction: the shared connection is the only
// one, so a backup asked for while a transaction is open waits for it, as an
// osi-db-helper operation queues behind db.transaction, and then copies the
// committed state, both writes included.
func TestBackupQueuesBehindAnOpenTransaction(t *testing.T) {
	store, dir := openCopy(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	backupDir := filepath.Join(dir, "backup")
	if err := os.Mkdir(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	insert := func(tx *sql.Conn, key string) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO app_settings(key, value, updated_at) VALUES(?, 'x', '2026-01-01T00:00:00.000Z')", key)
		return err
	}
	const first, second = "osi-store-test-0001", "osi-store-test-0002"
	if err := store.Tx(ctx, func(tx *sql.Conn) error { return insert(tx, first) }); err != nil {
		t.Fatal(err)
	}
	staged := make(chan struct{})
	release := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				writerDone <- fmt.Errorf("writer panicked: %v", r)
			}
		}()
		writerDone <- store.Tx(ctx, func(tx *sql.Conn) error {
			if err := insert(tx, second); err != nil {
				return err
			}
			close(staged)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-staged:
	case err := <-writerDone:
		t.Fatalf("writer failed before backup: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}

	type result struct {
		path string
		err  error
	}
	backupDone := make(chan result, 1)
	go func() {
		path, err := store.Backup(ctx, backupDir)
		backupDone <- result{path, err}
	}()
	select {
	case r := <-backupDone:
		close(release)
		t.Fatalf("backup finished while the transaction held the only connection: %v", r.err)
	case <-time.After(300 * time.Millisecond):
	}
	if open := store.DB().Stats().OpenConnections; open != 1 {
		t.Errorf("open connections = %d, want 1", open)
	}
	close(release)
	if err := <-writerDone; err != nil {
		t.Fatalf("writer failed: %v", err)
	}
	r := <-backupDone
	path, err := r.path, r.err
	if err != nil {
		t.Fatalf("backup after the transaction: %v", err)
	}
	if filepath.Base(path) != "farming.db" {
		t.Errorf("backup path = %q, want farming.db inside destDir", path)
	}

	copy, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	var keys []string
	rows, err := copy.QueryContext(ctx, "SELECT key FROM app_settings WHERE key LIKE 'osi-store-test-%' ORDER BY key")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if len(keys) != 2 || keys[0] != first || keys[1] != second {
		t.Fatalf("backup rows = %q, want both committed writes", keys)
	}

	var live int
	if err := store.DB().QueryRowContext(ctx, "SELECT COUNT(*) FROM app_settings WHERE key LIKE 'osi-store-test-%'").Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 2 {
		t.Errorf("live rows = %d, want both writes", live)
	}

	if _, err := store.Backup(ctx, backupDir); err == nil {
		t.Error("second backup into the same directory must refuse to overwrite")
	}
}
