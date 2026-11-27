package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTestFarmDB(driver, dsn string) (*farmDB, error) {
	pool, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(1)
	return &farmDB{pool: pool}, nil
}

func (db *farmDB) Exec(query string, args ...any) (sql.Result, error) {
	return db.ExecContext(context.Background(), query, args...)
}

func (db *farmDB) QueryRow(query string, args ...any) *farmRow {
	return db.QueryRowContext(context.Background(), query, args...)
}

// Queue two real service calls behind a held transaction before releasing it.
// Read the insertion order from SQLite, independent of goroutine wake order.
func TestFarmDBFIFO(t *testing.T) {
	db, err := openTestFarmDB("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE arrivals (id INTEGER PRIMARY KEY, caller TEXT)"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for i := 0; i < 100; i++ {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 2)
		for index, caller := range []string{"A", "B"} {
			go func() {
				_, err := db.ExecContext(ctx, "INSERT INTO arrivals(caller) VALUES (?)", caller)
				done <- err
			}()
			waitForFarmQueue(t, ctx, db, index+2)
		}
		if err := tx.Rollback(); err != nil {
			t.Fatal(err)
		}
		for j := 0; j < 2; j++ {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		var order string
		err = db.QueryRowContext(ctx, "SELECT group_concat(caller, '') FROM (SELECT caller FROM arrivals ORDER BY id DESC LIMIT 2)").Scan(&order)
		if err != nil || order != "BA" {
			t.Fatalf("iteration %d: reverse insertion order = %q, err = %v", i, order, err)
		}
	}
}

func waitForFarmQueue(t *testing.T, ctx context.Context, db *farmDB, want int) {
	t.Helper()
	ticker := time.NewTicker(100 * time.Microsecond)
	defer ticker.Stop()
	for {
		db.gate.mu.Lock()
		count := db.gate.waiters.Len()
		db.gate.mu.Unlock()
		if count == want {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("queue length = %d, want %d: %v", count, want, ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestFarmDBRawPoolBoundary(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		switch file {
		case "farm_db.go", "main.go", "sqlite_text.go", "tls_check.go":
			// Gate, constructor, driver registration, standalone TLS subcommand.
			continue
		}
		code, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, direct := range []string{"sql.Open", "*sql.DB", ".pool", "store.Open("} {
			if strings.Contains(string(code), direct) {
				t.Errorf("%s accesses the raw database through %s", file, direct)
			}
		}
	}
}
