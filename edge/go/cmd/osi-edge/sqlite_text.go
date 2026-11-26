package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"reflect"

	"osi-edge/internal/jsvalue"
	"osi-edge/internal/procfence"
)

// nodeTextDriver is the driver the backend opens farming.db with. It is
// modernc.org/sqlite with one change: every TEXT value a query returns is
// decoded as UTF-8 with replacement, as node-sqlite3 decodes stored TEXT into
// a JavaScript string. The flows hold only the decoded string, so every value
// they reuse (a uuid bound back into a lookup, an id compared in a Set, a
// value written to a ledger row or echoed in a response) carries U+FFFD where
// the stored bytes were invalid, and binds back as its UTF-8 encoding. Valid
// UTF-8 is returned unchanged; BLOBs, numbers and NULL are not touched, and
// comparisons evaluated by SQLite itself still see the stored bytes.
//
// Every statement also passes the process fence (procfence.Admit) before it
// starts: prepare, exec, query, begin, commit and rollback. After a fatal
// scheduler fault closes the fence, no new statement starts, including the
// next statement or the COMMIT of a transaction that is already open. A
// statement already inside modernc completes, as a node-sqlite3 statement
// already in the libuv thread pool does. Reading the rows of a query that
// started before the fence also completes (it writes nothing).
const nodeTextDriver = "sqlite-node-text"

func init() {
	base, err := sql.Open("sqlite", "")
	if err != nil {
		panic(err)
	}
	sql.Register(nodeTextDriver, textDriver{base.Driver()})
	base.Close()
}

type textDriver struct{ driver.Driver }

func (d textDriver) Open(name string) (driver.Conn, error) {
	conn, err := d.Driver.Open(name)
	if err != nil {
		return nil, err
	}
	return &textConn{conn}, nil
}

// textConn forwards exactly the optional interfaces modernc's conn
// implements (Ping, BeginTx, PrepareContext, ExecContext, QueryContext); it
// adds no NamedValueChecker or SessionResetter, so database/sql converts
// arguments and pools connections as it does for the bare driver.
type textConn struct{ driver.Conn }

type moderncConn interface {
	driver.Conn
	driver.Pinger
	driver.ConnBeginTx
	driver.ConnPrepareContext
	driver.ExecerContext
	driver.QueryerContext
}

var _ moderncConn = (*textConn)(nil)

func (c *textConn) base() moderncConn { return c.Conn.(moderncConn) }

// Unwrap lets helpers that need the modernc connection (backup) see through.
func (c *textConn) Unwrap() driver.Conn { return c.Conn }

func (c *textConn) Prepare(query string) (driver.Stmt, error) {
	procfence.Admit()
	stmt, err := c.Conn.Prepare(query)
	if err != nil {
		return nil, err
	}
	return &textStmt{stmt}, nil
}

func (c *textConn) Ping(ctx context.Context) error { return c.base().Ping(ctx) }

func (c *textConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	procfence.Admit()
	tx, err := c.base().BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return fencedTx{tx}, nil
}

// fencedTx admits COMMIT and ROLLBACK through the fence.
type fencedTx struct{ driver.Tx }

func (tx fencedTx) Commit() error {
	procfence.Admit()
	return tx.Tx.Commit()
}

func (tx fencedTx) Rollback() error {
	procfence.Admit()
	return tx.Tx.Rollback()
}

func (c *textConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	procfence.Admit()
	stmt, err := c.base().PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return &textStmt{stmt}, nil
}

func (c *textConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	procfence.Admit()
	return c.base().ExecContext(ctx, query, args)
}

func (c *textConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	procfence.Admit()
	rows, err := c.base().QueryContext(ctx, query, args)
	if err != nil {
		return nil, err
	}
	return wrapTextRows(rows), nil
}

type textStmt struct{ driver.Stmt }

type moderncStmt interface {
	driver.Stmt
	driver.StmtExecContext
	driver.StmtQueryContext
}

var _ moderncStmt = (*textStmt)(nil)

func (s *textStmt) base() moderncStmt { return s.Stmt.(moderncStmt) }

func (s *textStmt) Exec(args []driver.Value) (driver.Result, error) {
	procfence.Admit()
	return s.Stmt.Exec(args)
}

func (s *textStmt) Query(args []driver.Value) (driver.Rows, error) {
	procfence.Admit()
	rows, err := s.Stmt.Query(args)
	if err != nil {
		return nil, err
	}
	return wrapTextRows(rows), nil
}

func (s *textStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	procfence.Admit()
	return s.base().ExecContext(ctx, args)
}

func (s *textStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	procfence.Admit()
	rows, err := s.base().QueryContext(ctx, args)
	if err != nil {
		return nil, err
	}
	return wrapTextRows(rows), nil
}

type textRows struct{ driver.Rows }

type moderncRows interface {
	driver.Rows
	driver.RowsColumnTypeDatabaseTypeName
	driver.RowsColumnTypeLength
	driver.RowsColumnTypeNullable
	driver.RowsColumnTypePrecisionScale
	driver.RowsColumnTypeScanType
}

func wrapTextRows(rows driver.Rows) driver.Rows {
	if typed, ok := rows.(moderncRows); ok {
		return &textTypedRows{textRows{rows}, typed}
	}
	return &textRows{rows}
}

func (r *textRows) Next(dest []driver.Value) error {
	if err := r.Rows.Next(dest); err != nil {
		return err
	}
	for i, value := range dest {
		if text, ok := value.(string); ok {
			dest[i] = jsvalue.DecodeUTF8(text)
		}
	}
	return nil
}

type textTypedRows struct {
	textRows
	typed moderncRows
}

func (r *textTypedRows) ColumnTypeDatabaseTypeName(index int) string {
	return r.typed.ColumnTypeDatabaseTypeName(index)
}

func (r *textTypedRows) ColumnTypeLength(index int) (int64, bool) {
	return r.typed.ColumnTypeLength(index)
}

func (r *textTypedRows) ColumnTypeNullable(index int) (bool, bool) {
	return r.typed.ColumnTypeNullable(index)
}

func (r *textTypedRows) ColumnTypePrecisionScale(index int) (int64, int64, bool) {
	return r.typed.ColumnTypePrecisionScale(index)
}

func (r *textTypedRows) ColumnTypeScanType(index int) reflect.Type {
	return r.typed.ColumnTypeScanType(index)
}
