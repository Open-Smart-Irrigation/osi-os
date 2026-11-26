package main

import (
	"container/list"
	"context"
	"database/sql"
	"sync"

	"osi-edge/internal/store"
)

// dbGate grants the connection in enqueue order. The front owns the gate.
// A canceled waiter removes itself, including if it was just granted entry.
type dbGate struct {
	mu      sync.Mutex
	waiters list.List
}

func (g *dbGate) enqueue() (*list.Element, <-chan struct{}) {
	g.mu.Lock()
	defer g.mu.Unlock()
	ready := make(chan struct{})
	entry := g.waiters.PushBack(ready)
	if entry == g.waiters.Front() {
		close(ready)
	}
	return entry, ready
}

func (g *dbGate) remove(entry *list.Element) {
	g.mu.Lock()
	defer g.mu.Unlock()
	wasFront := entry == g.waiters.Front()
	g.waiters.Remove(entry)
	if next := g.waiters.Front(); wasFront && next != nil {
		close(next.Value.(chan struct{}))
	}
}

func (g *dbGate) acquire(ctx context.Context) (func(), error) {
	entry, ready := g.enqueue()
	release := sync.OnceFunc(func() { g.remove(entry) })
	select {
	case <-ready:
	case <-ctx.Done():
	}
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

// farmDB keeps the raw pool private. Statements hold the gate until the
// result is consumed or closed. Transactions hold it through commit/rollback.
type farmDB struct {
	pool *sql.DB
	gate dbGate
}

func (db *farmDB) Close() error       { return db.pool.Close() }
func (db *farmDB) Stats() sql.DBStats { return db.pool.Stats() }

func (db *farmDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	release, err := db.gate.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return db.pool.ExecContext(ctx, query, args...)
}

func (db *farmDB) QueryContext(ctx context.Context, query string, args ...any) (*farmRows, error) {
	release, err := db.gate.acquire(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := db.pool.QueryContext(ctx, query, args...)
	if err != nil {
		release()
		return nil, err
	}
	return &farmRows{Rows: rows, release: release}, nil
}

func (db *farmDB) QueryRowContext(ctx context.Context, query string, args ...any) *farmRow {
	release, err := db.gate.acquire(ctx)
	if err != nil {
		return &farmRow{err: err}
	}
	return &farmRow{row: db.pool.QueryRowContext(ctx, query, args...), release: release}
}

func (db *farmDB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*farmTx, error) {
	release, err := db.gate.acquire(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := db.pool.BeginTx(ctx, opts)
	if err != nil {
		release()
		return nil, err
	}
	return &farmTx{Tx: tx, release: release}, nil
}

func (db *farmDB) Conn(ctx context.Context) (*farmConn, error) {
	release, err := db.gate.acquire(ctx)
	if err != nil {
		return nil, err
	}
	conn, err := db.pool.Conn(ctx)
	if err != nil {
		release()
		return nil, err
	}
	return &farmConn{Conn: conn, release: release}, nil
}

func (db *farmDB) withImmediateTx(ctx context.Context, fn func(*farmConn) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return store.ImmediateTxOnConn(ctx, conn.Conn, func(*sql.Conn) error { return fn(conn) })
}

type farmRows struct {
	*sql.Rows
	release func()
}

func (r *farmRows) Close() error {
	if r.release != nil {
		defer r.release()
	}
	return r.Rows.Close()
}

func (r *farmRows) Next() bool {
	if r.Rows.Next() {
		return true
	}
	r.Close()
	return false
}

type farmRow struct {
	row     *sql.Row
	err     error
	release func()
}

func (r *farmRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if r.release != nil {
		defer r.release()
	}
	return r.row.Scan(dest...)
}

type farmTx struct {
	*sql.Tx
	release func()
}

func (tx *farmTx) Commit() error {
	defer tx.release()
	return tx.Tx.Commit()
}

func (tx *farmTx) Rollback() error {
	defer tx.release()
	return tx.Tx.Rollback()
}

func (tx *farmTx) QueryContext(ctx context.Context, query string, args ...any) (*farmRows, error) {
	rows, err := tx.Tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return &farmRows{Rows: rows}, nil
}

func (tx *farmTx) QueryRowContext(ctx context.Context, query string, args ...any) *farmRow {
	return &farmRow{row: tx.Tx.QueryRowContext(ctx, query, args...)}
}

type farmConn struct {
	*sql.Conn
	release func()
}

func (c *farmConn) Close() error {
	defer c.release()
	return c.Conn.Close()
}

func (c *farmConn) QueryContext(ctx context.Context, query string, args ...any) (*farmRows, error) {
	rows, err := c.Conn.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return &farmRows{Rows: rows}, nil
}

func (c *farmConn) QueryRowContext(ctx context.Context, query string, args ...any) *farmRow {
	return &farmRow{row: c.Conn.QueryRowContext(ctx, query, args...)}
}
