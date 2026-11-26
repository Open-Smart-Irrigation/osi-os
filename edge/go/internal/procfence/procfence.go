// Package procfence is the process-wide effect fence for a fatal scheduler
// fault. Node-RED's main thread is stuck in the timers pass once a throw
// escapes it, until its uncaughtException handler calls process.exit(1): no
// new JavaScript callback can start a database statement, a radio call or an
// MQTT publish, while a statement node-sqlite3 already handed to the libuv
// thread pool runs to completion. Close copies that: every effect entry
// point calls Admit before it starts, and after Close Admit never returns, so
// the caller blocks until the process exits. Work that passed Admit before
// Close completes.
//
// The pass lock makes each calendar timers pass exclusive against the start
// of new fenced operations, as Node's single thread is: no HTTP callback or
// SQLite continuation runs while a timers pass runs. The calendar loop holds
// it exclusively for the pass (PassBegin/PassEnd); Admit takes it shared for
// its check only, so an operation that was admitted before the pass keeps
// running during it (Node's thread-pool work), and one that would start
// during the pass waits until the pass ends. A pass that faults closes the
// fence before it releases the lock (it never does: the process exits), so
// nothing new starts between the pass and the exit.
package procfence

import (
	"sync"
	"sync/atomic"
)

var (
	closed atomic.Bool
	pass   sync.RWMutex
	// holder is the goroutine id the current pass was begun with, 0 outside
	// a pass. Only ReentryCheck reads it.
	holder atomic.Uint64
)

// never is not closed: a fenced caller waits on it until the process exits.
var never = make(chan struct{})

// ReentryCheck, when set (tests), returns the calling goroutine's id; Admit
// then panics if the goroutine holding the pass lock tries to admit a fenced
// operation, which would deadlock in production.
var ReentryCheck func() uint64

// Close closes the fence. It is idempotent.
func Close() { closed.Store(true) }

// Closed reports whether the fence is closed.
func Closed() bool { return closed.Load() }

// Admit returns at once while the fence is open and no timers pass runs,
// waits while a pass runs, and never returns once the fence is closed.
func Admit() {
	if ReentryCheck != nil {
		if h := holder.Load(); h != 0 && ReentryCheck() == h {
			panic("procfence: a fenced operation inside the timers pass that holds the pass lock")
		}
	}
	pass.RLock()
	c := closed.Load()
	pass.RUnlock()
	if c {
		<-never
	}
}

// PassBegin takes the pass lock exclusively for one timers pass; gid is the
// loop goroutine's id (0 if unknown).
func PassBegin(gid uint64) {
	pass.Lock()
	holder.Store(gid)
}

// PassEnd releases the pass lock.
func PassEnd() {
	holder.Store(0)
	pass.Unlock()
}

// InPass reports whether a timers pass holds the pass lock (tests).
func InPass() bool { return holder.Load() != 0 }
