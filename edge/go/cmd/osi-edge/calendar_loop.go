package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"math"
	"os"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"sync"
	"time"

	"osi-edge/internal/procfence"
)

// Node-RED main runs its five crontab injects as tasks of one cronosjs 1.7.1
// scheduler inside Node's single event loop. This file reproduces that:
//
//   - calendarLoop is the loop. One goroutine runs every scheduler callback,
//     one at a time and to completion, as Node runs JavaScript.
//   - nodeTimers is Node 20's timer phase (lib/internal/timers.js,
//     insert/processTimers/listOnTimeout and lib/timers.js unenroll): timers
//     are kept in one list per duration, lists are ordered by (expiry, list
//     id), each list runs first in, first out, and one processTimers call
//     uses one fixed `now`.
//   - The cronosjs scheduler (dist-node/index.js:807-958) and the inject
//     node's once timer (20-inject.js:88-92) run on those timers.
//
// Every timer source goes through setTimeout/clearTimeout and every callback
// through runCallback; all of them assert that they run on the loop goroutine.

// nodeRedCron is one crontab inject of the shipped flows.json. The four that
// Go does not port are kept as wake sources: their occurrences wake the
// shared timer, and a wake dispatches every overdue task, including the 06:00
// daily schedule.
type nodeRedCron struct {
	name         string // the Go timer name for a ported cron, else the inject id
	hour, minute int
	once         time.Duration // once:true inject: first run and task start after this delay
}

// nodeRedCrons lists the crontab injects in flows.json order, which is the
// order Node-RED constructs them in: their timers are created in this order,
// and cronosjs breaks timestamp ties by insertion order.
var nodeRedCrons = []nodeRedCron{
	{name: "daily-schedule-0600", hour: 6},                         // 4b7b6d3b8d1f0d31 '00 06 * * *'
	{name: "dendro-daily-inject", hour: 8, once: 30 * time.Second}, // '0 8 * * *', once after 30 s
	{name: "outbox-retention-tick", hour: 2},                       // '0 2 * * *'
	{name: "gateway-health-rollup-tick", hour: 2, minute: 10},      // '10 2 * * *'
	{name: "history-rollups-schedule", hour: 2},                    // '0 2 * * *'
}

// nodeRedCronNext is the cron's next occurrence: the ported timer's own next
// for a cron Go runs, else cronosjs's for "minute hour * * *" in the process
// zone.
func nodeRedCronNext(cron nodeRedCron, loc *time.Location) func(time.Time) time.Time {
	if timer, ok := timers[cron.name]; ok && timer.next != nil {
		return timer.next
	}
	return func(after time.Time) time.Time { return cronosDailyNext(after, loc, cron.hour, cron.minute) }
}

// loopClock is the loop's time: Now is the wall clock (Date.now), Mono the
// monotonic clock (libuv's loop time). Sleep returns once Mono has reached
// until or ctx is done; it may return early, and the loop then checks again.
type loopClock interface {
	Now() time.Time
	Mono() time.Duration
	Sleep(ctx context.Context, until time.Duration)
}

type systemLoopClock struct{ start time.Time }

func (c systemLoopClock) Now() time.Time      { return time.Now() }
func (c systemLoopClock) Mono() time.Duration { return time.Since(c.start) }

func (c systemLoopClock) Sleep(ctx context.Context, until time.Duration) {
	d := until - c.Mono()
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// calendarLoopStrict makes an off-loop callback panic instead of only being
// logged. Tests set it.
var calendarLoopStrict = false

// cronosMaxTimeout is the longest delay cronosjs gives setTimeout, in ms.
const cronosMaxTimeout = 1<<31 - 1

// nodeTimer is a Timeout of Node's timers module.
type nodeTimer struct {
	cb        func()
	msecs     int64
	start     int64
	list      *nodeTimerList
	destroyed bool
}

type nodeTimerList struct {
	msecs, expiry, id int64
	timers            []*nodeTimer
}

type calendarTask struct {
	name string
	next func(time.Time) time.Time
	at   int64 // ms since the epoch; cronosjs's _timestamp
	// deaf: the node's constructor threw after scheduleTask had inserted
	// the task. 20-inject.js registers its input handler (:97) after the
	// cron setup (:84-95), so the task still wakes the shared timer and
	// keeps its timestamps, but its emits reach no handler and nothing is
	// delivered.
	deaf bool
}

// calendarLoop is Node's event loop for the calendar crons.
type calendarLoop struct {
	clock loopClock
	loc   *time.Location
	crons []nodeRedCron
	fire  func(name string) // the inject's emit (its input handler)
	// deliver hands an emitted message to the flow: the daily tick. Node-RED
	// delivers with setImmediate (runtime/lib/flows/Flow.js:817-818; the
	// shipped settings.js leaves runtimeSyncDelivery unset), so it runs in
	// the check phase after the whole timers pass. Emits of a pass that ends
	// in a scheduler fault are never delivered: the process exits first.
	deliver    func(name string)
	immediates []string
	gid        uint64
	lists      map[int64]*nodeTimerList
	listID     int64

	// cronosjs module state: scheduledTasks (descending timestamp) and
	// runningTimer.
	tasks   []*calendarTask
	running *nodeTimer
}

func newCalendarLoop(clock loopClock, loc *time.Location, crons []nodeRedCron, fire func(name string)) *calendarLoop {
	return &calendarLoop{clock: clock, loc: loc, crons: crons, fire: fire, lists: map[int64]*nodeTimerList{}}
}

// runCalendarLoop runs the loop until ctx is done. The flows start first:
// the crontab injects are constructed in flows.json order.
func (l *calendarLoop) run(ctx context.Context) {
	if id, ok := goroutineID(); ok {
		l.gid = id
	}
	l.timersPass(func() { l.runCallback("flow start", l.flowStart) })
	l.checkPhase()
	for ctx.Err() == nil {
		until := time.Duration(math.MaxInt64)
		if list := l.peek(); list != nil {
			until = time.Duration(list.expiry) * time.Millisecond
		}
		l.clock.Sleep(ctx, until)
		if ctx.Err() != nil {
			return
		}
		l.timersPass(func() { l.processTimers(l.monoMs()) })
		l.checkPhase()
	}
}

// timersPass runs one timers pass (or the flow start) holding the process
// pass lock exclusively: no new fenced operation (farming.db statement,
// radio call, cloud publish) starts in any goroutine while it runs, as no
// other JavaScript runs during Node's timers pass. A fault inside the pass
// closes the fence and exits before the lock would be released. The pass
// itself performs no fenced operation: the daily tick is handed over in the
// check phase, after the lock is released.
func (l *calendarLoop) timersPass(pass func()) {
	procfence.PassBegin(l.gid)
	defer procfence.PassEnd()
	pass()
}

// checkPhase runs the setImmediate deliveries queued during the timers pass.
// A delivery that panics is the downstream node's error: logged, the others
// still run.
func (l *calendarLoop) checkPhase() {
	l.assertLoop("check phase")
	queued := l.immediates
	l.immediates = nil
	for _, name := range queued {
		func() {
			defer func() {
				if p := recover(); p != nil {
					switch p.(type) {
					case calendarLoopViolation, calendarLoopExited:
						panic(p)
					}
					log.Printf("CALENDAR HANDLER PANIC delivering %s (logged, the cron goes on): %v\n%s", name, p, debug.Stack())
				}
			}()
			l.deliver(name)
		}()
	}
}

func (l *calendarLoop) flowStart() {
	for _, cron := range l.crons {
		task := &calendarTask{name: cron.name, next: nodeRedCronNext(cron, l.loc)}
		l.constructNode(task, func() {
			if cron.once <= 0 {
				l.startTask(task) // 20-inject.js:94 repeaterSetup -> scheduleTask
				return
			}
			// 20-inject.js:88-92: arm the once timer in the constructor; it
			// emits once, then creates the cron task. An error in the emit is
			// the input handler's and is caught there (dispatch); a fault in
			// the task start escapes the timer callback (runCallback).
			if calendarFaultHook != nil {
				calendarFaultHook("oncearm", task.name)
			}
			l.setTimeout(func() {
				l.dispatch(task)
				l.startTask(task)
			}, cron.once.Milliseconds())
		})
	}
}

// constructNode is one inject node's construction at flow start. Node-RED's
// createNode catches a throw from a node constructor, logs it and goes on
// with the next node (runtime/lib/flows/util.js:190-197); whatever the
// failed scheduleTask had already done to the shared scheduler stays.
func (l *calendarLoop) constructNode(task *calendarTask, construct func()) {
	defer func() {
		if p := recover(); p != nil {
			switch p.(type) {
			case calendarLoopViolation, calendarLoopExited:
				panic(p)
			}
			task.deaf = true
			log.Printf("CALENDAR SCHEDULER FAULT constructing %s (node not created; a task it already inserted still wakes the shared timer but delivers nothing): %v\n%s", task.name, p, debug.Stack())
		}
	}()
	construct()
}

func (l *calendarLoop) monoMs() int64 { return int64(l.clock.Mono() / time.Millisecond) }

// dateNow is Date.now(): wall milliseconds.
func (l *calendarLoop) dateNow() int64 { return l.clock.Now().UnixMilli() }

// calendarLoopViolation is the panic value of a strict loop violation. No
// recover in the loop treats it as an ordinary fault.
type calendarLoopViolation string

func (v calendarLoopViolation) String() string { return string(v) }

// assertLoop reports a scheduler callback or timer call that is not running
// on the loop goroutine. It fails closed: an unreadable goroutine id, or a
// loop that has not recorded its own, is a violation.
func (l *calendarLoop) assertLoop(what string) {
	id, ok := goroutineID()
	if ok && l.gid != 0 && id == l.gid {
		return
	}
	msg := fmt.Sprintf("CALENDAR LOOP VIOLATION: %s ran on goroutine %d (id read: %t), loop is %d", what, id, ok, l.gid)
	if calendarLoopStrict {
		panic(calendarLoopViolation(msg))
	}
	// Production: the scheduler can no longer be trusted to run Node's
	// order, so the violation is a scheduler fault: fence, log, exit.
	l.schedulerFault(what, msg)
}

// runCallback runs one loop callback to completion. A panic escaping it is
// a fault inside the scheduler: in Node an exception escaping the timer
// callback, which reaches Node-RED's uncaughtException handler. That handler
// logs the error and calls process.exit(1) (node-red/red.js:499-514), and
// procd respawns the service. Go does the same (schedulerFault).
func (l *calendarLoop) runCallback(what string, cb func()) {
	l.assertLoop(what)
	defer func() {
		if p := recover(); p != nil {
			switch p.(type) {
			case calendarLoopViolation, calendarLoopExited:
				panic(p)
			}
			l.schedulerFault(what, p)
		}
	}()
	cb()
}

// calendarFence closes the process effect fence. Tests replace it so a
// simulated fault does not fence the test binary's other tests.
var calendarFence = procfence.Close

// calendarExit ends the process after a scheduler fault. Tests replace it.
var calendarExit = func(code int) { os.Exit(code) }

// calendarLoopExited unwinds the loop goroutine after calendarExit returned
// (only a test's calendarExit returns).
type calendarLoopExited struct{}

// schedulerFault is Node-RED's uncaughtException handler: log the error,
// then exit(1) at once. Like Node's process.exit it runs nothing else: no
// deferred function, no shutdown hook, no SIGTERM path, no further dispatch
// or calendar write. procd respawns the service (respawn 3600 5 -1).
// In-flight work is cut off as in Node-RED's exit: an open SQLite
// transaction is never committed (SQLite discards it when the database is
// next opened), MQTT connections drop without a DISCONNECT, and pending
// HTTP requests and responses are reset.
func (l *calendarLoop) schedulerFault(what string, p any) {
	// First, before anything that can take time (the log write), close the
	// effect fence: no new SQLite statement, radio call or MQTT publish
	// starts in any goroutine from here on (procfence).
	calendarFence()
	log.Printf("CALENDAR SCHEDULER FAULT in %s: %v (exiting with status 1; procd respawns the service)\n%s", what, p, debug.Stack())
	_ = os.Stderr.Sync()
	calendarExit(1)
	panic(calendarLoopExited{})
}

// setTimeout is Node's setTimeout plus timers.js insert.
func (l *calendarLoop) setTimeout(cb func(), after int64) *nodeTimer {
	l.assertLoop("setTimeout")
	if !(after >= 1 && after <= cronosMaxTimeout) {
		after = 1
	}
	t := &nodeTimer{cb: cb, msecs: after, start: l.monoMs()}
	list := l.lists[after]
	if list == nil {
		list = &nodeTimerList{msecs: after, expiry: t.start + after, id: l.listID}
		l.listID++
		l.lists[after] = list
	}
	t.list = list
	list.timers = append(list.timers, t)
	return t
}

// clearTimeout is Node's clearTimeout (timers.js unenroll): the timer leaves
// its list, and an empty list leaves the queue.
func (l *calendarLoop) clearTimeout(t *nodeTimer) {
	l.assertLoop("clearTimeout")
	if t == nil || t.destroyed {
		return
	}
	t.destroyed = true
	if t.list != nil {
		t.list.timers = slices.DeleteFunc(t.list.timers, func(x *nodeTimer) bool { return x == t })
		t.list = nil
	}
	if list := l.lists[t.msecs]; list != nil && len(list.timers) == 0 {
		delete(l.lists, t.msecs)
	}
}

// peek is timerListQueue.peek(): the list with the smallest (expiry, id).
func (l *calendarLoop) peek() *nodeTimerList {
	var best *nodeTimerList
	for _, list := range l.lists {
		if best == nil || list.expiry < best.expiry || list.expiry == best.expiry && list.id < best.id {
			best = list
		}
	}
	return best
}

// processTimers is Node 20's processTimers(now).
func (l *calendarLoop) processTimers(now int64) {
	l.assertLoop("processTimers")
	for {
		list := l.peek()
		if list == nil || list.expiry > now {
			return
		}
		l.listOnTimeout(list, now)
	}
}

// listOnTimeout is Node 20's listOnTimeout(list, now).
func (l *calendarLoop) listOnTimeout(list *nodeTimerList, now int64) {
	for len(list.timers) > 0 {
		t := list.timers[0]
		if now-t.start < list.msecs {
			list.expiry = max(t.start+list.msecs, now+1)
			list.id = l.listID
			l.listID++
			return
		}
		list.timers = list.timers[1:]
		t.list = nil
		if t.destroyed {
			continue
		}
		t.destroyed = true
		l.runCallback("timer callback", t.cb)
	}
	if l.lists[list.msecs] == list {
		delete(l.lists, list.msecs)
	}
}

// addTask is cronosjs addTask: insert before the first task with a smaller
// timestamp, so equal timestamps keep insertion order.
func (l *calendarLoop) addTask(task *calendarTask) {
	i := slices.IndexFunc(l.tasks, func(t *calendarTask) bool { return t.at < task.at })
	if i < 0 {
		i = len(l.tasks)
	}
	l.tasks = slices.Insert(l.tasks, i, task)
}

// startTask is CronosTask.start: first timestamp, add, run the scheduler.
func (l *calendarLoop) startTask(task *calendarTask) {
	l.assertLoop("task start")
	task.at = l.nextOf(task)
	l.addTask(task)
	l.runScheduledTasks()
}

// calendarFaultHook, when set by a test, is called at each scheduler fault
// site ("next" with the task name, "rearm") and may panic there.
var calendarFaultHook func(site, task string)

// nextOf is CronosTask._updateTimestamp's nextDate(new Date()).
func (l *calendarLoop) nextOf(task *calendarTask) int64 {
	if calendarFaultHook != nil {
		calendarFaultHook("next", task.name)
	}
	return task.next(time.UnixMilli(l.dateNow())).UnixMilli()
}

// runScheduledTasks is cronosjs runScheduledTasks (skipRun false): clear the
// running timer, run every task whose timestamp is not after Date.now() once
// in list order, give each its next timestamp from a fresh Date, and arm one
// timer toward the earliest task.
func (l *calendarLoop) runScheduledTasks() {
	l.clearTimeout(l.running)
	l.running = nil
	now := l.dateNow()
	i := slices.IndexFunc(l.tasks, func(t *calendarTask) bool { return t.at <= now })
	var due []*calendarTask
	if i >= 0 {
		due = slices.Clone(l.tasks[i:])
		l.tasks = l.tasks[:i]
	}
	for _, task := range due {
		l.runTask(task)
		l.addTask(task)
	}
	if len(l.tasks) == 0 {
		return
	}
	delay := min(l.tasks[len(l.tasks)-1].at-l.dateNow(), cronosMaxTimeout)
	if calendarFaultHook != nil {
		calendarFaultHook("rearm", "")
	}
	l.running = l.setTimeout(func() { l.runScheduledTasks() }, delay)
}

// runTask is one iteration of cronosjs's task loop: emit, then the next
// timestamp. A fault in the next-time calculation escapes the pass (see
// runCallback); the caller has not re-inserted this task or the ones after
// it, as in cronosjs.
func (l *calendarLoop) runTask(task *calendarTask) {
	l.dispatch(task)
	task.at = l.nextOf(task)
}

// dispatch is the inject node's emit: the cron's occurrence. A panic in it
// is the input handler's: Node-RED's Node._emitInput catches and logs it
// (runtime/lib/nodes/Node.js:213-221), and cronosjs goes on.
func (l *calendarLoop) dispatch(task *calendarTask) {
	name := task.name
	l.assertLoop("dispatch " + name)
	if task.deaf {
		return // the node never registered its input handler
	}
	defer func() {
		if p := recover(); p != nil {
			switch p.(type) {
			case calendarLoopViolation, calendarLoopExited:
				panic(p)
			}
			log.Printf("CALENDAR HANDLER PANIC in %s (logged, the cron goes on): %v\n%s", name, p, debug.Stack())
		}
	}()
	l.fire(name)
	if l.deliver != nil {
		l.immediates = append(l.immediates, name) // Node.send -> setImmediate
	}
}

// goroutineID reads the current goroutine's id from its stack header
// ("goroutine N [..."). ok is false when the header does not parse.
func goroutineID() (id uint64, ok bool) {
	var buf [64]byte
	b := buf[:runtime.Stack(buf[:], false)]
	rest, found := bytes.CutPrefix(b, []byte("goroutine "))
	if !found {
		return 0, false
	}
	i := bytes.IndexByte(rest, ' ')
	if i <= 0 {
		return 0, false
	}
	id, err := strconv.ParseUint(string(rest[:i]), 10, 64)
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

// startCalendarLoop starts the loop goroutine. stop cancels it and waits
// until it has returned.
func startCalendarLoop(ctx context.Context, clock loopClock, loc *time.Location, crons []nodeRedCron, fire func(name string)) (stop func()) {
	return startCalendarLoopDelivering(ctx, clock, loc, crons, fire, nil)
}

// startCalendarLoopDelivering is startCalendarLoop with a check-phase
// delivery of every emit (see calendarLoop.deliver).
func startCalendarLoopDelivering(ctx context.Context, clock loopClock, loc *time.Location, crons []nodeRedCron, fire, deliver func(name string)) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	l := newCalendarLoop(clock, loc, crons, fire)
	l.deliver = deliver
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() {
			p := recover()
			switch p.(type) {
			case nil, calendarLoopExited:
				return
			case calendarLoopViolation:
				panic(p)
			}
			// A fault in the loop's own bookkeeping is a scheduler fault too.
			func() {
				defer func() {
					if q := recover(); q != nil {
						if _, ok := q.(calendarLoopExited); !ok {
							panic(q)
						}
					}
				}()
				l.schedulerFault("calendar loop", p)
			}()
		}()
		l.run(ctx)
	}()
	return func() {
		cancel()
		<-done
	}
}

func (b *backend) startCalendarTimers(ctx context.Context, workers *sync.WaitGroup) (stop func()) {
	var gate sync.Mutex
	closed := false
	emit := func(string) {}
	stopLoop := startCalendarLoopDelivering(ctx, systemLoopClock{start: time.Now()}, dailyScheduleLocation(), nodeRedCrons, emit, func(name string) {
		if timer, ok := timers[name]; !ok || timer.next == nil {
			return // a Node-RED cron Go does not port: a wake source only
		}
		gate.Lock()
		defer gate.Unlock()
		// A wake that races shutdown never starts a tick on a cancelled
		// context.
		if closed || ctx.Err() != nil {
			return
		}
		// The tick runs off the loop, handed over in the check phase after
		// the timers pass, as Node-RED delivers the inject's message with
		// setImmediate.
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := b.tick(ctx, name); err != nil {
				log.Printf("timer %s: %v", name, err)
			}
		}()
	})
	return func() {
		gate.Lock()
		closed = true
		gate.Unlock()
		stopLoop()
	}
}
