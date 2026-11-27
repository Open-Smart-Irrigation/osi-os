package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime/pprof"
	"strconv"
	"time"
)

// startDBWatchdog is the deadlock detector for the single shared connection.
// With OSI_EDGE_DB_WATCHDOG=<seconds> set, it joins the FIFO queue for the
// connection every second; when it cannot have it within that many seconds,
// some goroutine holds it (a transaction, an open Rows or a sql.Conn) while
// another one, possibly the holder itself, waits for it. The watchdog then
// writes every goroutine's stack to stderr and exits with status 70, so a
// replay fails at the site instead of hanging until its timeout. Unset (the
// default), it does nothing.
func startDBWatchdog(ctx context.Context, db *farmDB) {
	seconds, err := strconv.Atoi(os.Getenv("OSI_EDGE_DB_WATCHDOG"))
	if err != nil || seconds <= 0 {
		return
	}
	limit := time.Duration(seconds) * time.Second
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			wait, cancel := context.WithTimeout(ctx, limit)
			conn, err := db.Conn(wait)
			cancel()
			if err == nil {
				conn.Close()
				continue
			}
			if ctx.Err() != nil {
				return
			}
			stats := db.Stats()
			fmt.Fprintf(os.Stderr, "DB WATCHDOG: the shared connection was not free for %v (open=%d in_use=%d wait_count=%d): %v\n",
				limit, stats.OpenConnections, stats.InUse, stats.WaitCount, err)
			if dumpErr := pprof.Lookup("goroutine").WriteTo(os.Stderr, 2); dumpErr != nil {
				log.Printf("DB WATCHDOG: goroutine dump: %v", dumpErr)
			}
			os.Exit(70)
		}
	}()
}
