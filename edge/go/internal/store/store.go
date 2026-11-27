// Package store contains SQLite utilities for the farm database.
package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"modernc.org/sqlite"
)

// Store owns the shared connection.
type Store struct {
	db   *sql.DB
	path string
}

func dsn(path string, pragmas [][2]string) string {
	values := url.Values{}
	for _, pragma := range pragmas {
		values.Add("_pragma", pragma[0]+"("+pragma[1]+")")
	}
	uri := url.URL{Scheme: "file", Path: path}
	uri.RawQuery = values.Encode()
	return uri.String()
}

// writerPragmas are osi-db-helper's PRAGMAS in its order (index.js:14-20).
var writerPragmas = [][2]string{
	{"journal_mode", "WAL"},
	{"synchronous", "NORMAL"},
	{"foreign_keys", "ON"},
	{"busy_timeout", "5000"},
	{"wal_autocheckpoint", "1000"},
}

// Open enables WAL on the database at path and verifies the mode.
func Open(path string) (*Store, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dsn(absolute, writerPragmas))
	if err != nil {
		return nil, err
	}
	// One connection for reads and writes, kept open, as osi-db-helper's
	// ensureSharedDatabase: statements queue for it instead of opening more.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		db.Close()
		return nil, fmt.Errorf("enable database WAL: %w", err)
	}
	if mode != "wal" {
		db.Close()
		return nil, fmt.Errorf("expected database WAL mode, got %q", mode)
	}
	return &Store{db: db, path: absolute}, nil
}

// DB exposes the shared connection (a pool of exactly one).
func (s *Store) DB() *sql.DB { return s.db }

// SQLiteVersion reports SELECT sqlite_version().
func (s *Store) SQLiteVersion() (string, error) {
	var version string
	if err := s.db.QueryRowContext(context.Background(), "SELECT sqlite_version()").Scan(&version); err != nil {
		return "", err
	}
	return version, nil
}

// Close releases the shared connection.
func (s *Store) Close() error { return s.db.Close() }

// Tx runs fn inside one BEGIN IMMEDIATE transaction on the shared
// connection: commit on success, rollback on any failure (a failed rollback
// is joined onto the original error, as the JS attaches rollbackError).
// fn must use only tx: the pool has one connection, and fn holds it.
func (s *Store) Tx(ctx context.Context, fn func(tx *sql.Conn) error) error {
	return WithImmediateTx(ctx, s.db, fn)
}

// WithImmediateTx reserves the SQLite writer before reading rows to be changed.
func WithImmediateTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Conn) error) (err error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return ImmediateTxOnConn(ctx, conn, fn)
}

// ImmediateTxOnConn runs a transaction on a connection owned by the caller.
func ImmediateTxOnConn(ctx context.Context, conn *sql.Conn, fn func(*sql.Conn) error) (err error) {
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			if _, rollbackErr := conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK"); rollbackErr != nil {
				err = errors.Join(err, fmt.Errorf("rollback failed: %w", rollbackErr))
			}
		}
	}()
	if err := fn(conn); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	committed = err == nil
	return err
}

// Backup writes an online backup (SQLite's backup API, not VACUUM INTO) to
// destDir/farming.db and runs PRAGMA integrity_check on the copy, refusing
// to overwrite an existing file. It returns the copy's path.
func (s *Store) Backup(ctx context.Context, destDir string) (string, error) {
	info, err := os.Stat(destDir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("backup destination is not a directory: %s", destDir)
	}
	dest := filepath.Join(destDir, "farming.db")
	if _, err := os.Stat(dest); err == nil {
		return "", fmt.Errorf("backup destination already exists: %s", dest)
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	err = conn.Raw(func(driverConn any) error {
		return backupTo(unwrapConn(driverConn), dest, ctx)
	})
	if err != nil {
		return "", err
	}
	return dest, integrityCheck(dest)
}

// unwrapConn sees through wrapper connections the way modernc.org/sqlite's
// own helpers do (sql.Conn.Raw passes the driver connection, possibly
// wrapped by an interposing Connector).
func unwrapConn(v any) any {
	for {
		wrapper, ok := v.(interface{ Unwrap() driver.Conn })
		if !ok {
			return v
		}
		v = wrapper.Unwrap()
	}
}

// backupTo drives modernc.org/sqlite's Backup (sqlite3_backup_init/step/
// finish). The driver exposes NewBackup only on the unexported *conn type, so
// the constructor is reached reflectively through sql.Conn.Raw; everything
// after construction uses the exported Backup methods.
func backupTo(v any, dest string, ctx context.Context) error {
	method := reflect.ValueOf(v).MethodByName("NewBackup")
	if !method.IsValid() {
		return fmt.Errorf("sqlite driver connection %T has no NewBackup", v)
	}
	result := method.Call([]reflect.Value{reflect.ValueOf(dest)})
	if !result[1].IsNil() {
		return result[1].Interface().(error)
	}
	backup, ok := result[0].Interface().(*sqlite.Backup)
	if !ok || backup == nil {
		return fmt.Errorf("sqlite NewBackup returned %T", result[0].Interface())
	}
	defer backup.Finish()
	for {
		more, err := backup.Step(-1)
		if err == nil {
			if !more {
				return nil
			}
			continue // source restarted the copy; keep stepping
		}
		if isBusy(err) {
			if err := ctx.Err(); err != nil {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(25 * time.Millisecond):
			}
			continue
		}
		return err
	}
}

func isBusy(err error) bool {
	var sqliteErr *sqlite.Error
	if errors.As(err, &sqliteErr) {
		return sqliteErr.Code() == 5 // SQLITE_BUSY
	}
	return strings.Contains(err.Error(), "SQLITE_BUSY") || strings.Contains(err.Error(), "database is locked")
}

func integrityCheck(path string) error {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	var findings []string
	for rows.Next() {
		var finding string
		if err := rows.Scan(&finding); err != nil {
			return err
		}
		findings = append(findings, finding)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(findings) != 1 || findings[0] != "ok" {
		return fmt.Errorf("integrity_check on backup: %s", strings.Join(findings, "; "))
	}
	return nil
}
