package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"

	"osi-edge/internal/cloudmqtt"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/procfence"
)

// virtualLoopClock drives the calendar loop goroutine on virtual time, as
// node-real.js drives Node's timers: a monotonic part and a wall offset, and
// a clock step changes only the offset. The loop's Sleep hands control to the
// test driver, which moves time only while the loop is idle, so callbacks
// still run on the loop goroutine. With a jitter source the driver also
// yields before each release, delays one release in eight by up to 100 µs
// of real time, and wakes the loop early (time not moved) one time in five.
type virtualLoopClock struct {
	mu        sync.Mutex
	mono, off time.Duration
	idle      chan *loopSleep
	pending   *loopSleep
	jitter    *rand.Rand
	dead      chan struct{} // closed when the loop's process exited (calendarExit)
}

type loopSleep struct {
	until time.Duration
	wake  chan struct{}
}

func newVirtualLoopClock(jitter *rand.Rand) *virtualLoopClock {
	return &virtualLoopClock{idle: make(chan *loopSleep), jitter: jitter, dead: make(chan struct{})}
}

func (c *virtualLoopClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Unix(0, 0).UTC().Add(c.mono + c.off)
}

func (c *virtualLoopClock) Mono() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mono
}

func (c *virtualLoopClock) Sleep(ctx context.Context, until time.Duration) {
	s := &loopSleep{until: until, wake: make(chan struct{})}
	select {
	case c.idle <- s:
	case <-ctx.Done():
		return
	}
	select {
	case <-s.wake:
	case <-ctx.Done():
	}
}

// waitIdle returns the loop's current sleep, waiting until it sleeps, or nil
// once the loop's process has exited.
func (c *virtualLoopClock) waitIdle() *loopSleep {
	if c.pending == nil {
		select {
		case c.pending = <-c.idle:
		case <-c.dead:
		}
	}
	return c.pending
}

func (c *virtualLoopClock) release(s *loopSleep) {
	c.pending = nil
	if c.jitter != nil {
		if c.jitter.Intn(8) == 0 {
			time.Sleep(time.Duration(c.jitter.Intn(100)) * time.Microsecond)
		}
		runtime.Gosched()
	}
	close(s.wake)
}

// advanceTo runs the loop up to monotonic time target: every sleep that ends
// at or before target is released at its end, so timers due exactly at
// target run before a clock step at target, as in node-real.js.
func (c *virtualLoopClock) advanceTo(target time.Duration) {
	for {
		s := c.waitIdle()
		if s == nil { // the process exited: time goes on without it
			c.mu.Lock()
			c.mono = max(c.mono, target)
			c.mu.Unlock()
			return
		}
		if c.jitter != nil && c.jitter.Intn(5) == 0 {
			c.release(s) // an early wake: the loop must find nothing due and sleep again
			continue
		}
		if s.until > target {
			c.mu.Lock()
			c.mono = max(c.mono, target)
			c.mu.Unlock()
			return
		}
		c.mu.Lock()
		c.mono = max(c.mono, s.until)
		c.mu.Unlock()
		c.release(s)
	}
}

func (c *virtualLoopClock) step(wall time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.off = wall - c.mono
}

type cronHistory struct {
	Name   string   `json:"name"`
	Events [][3]any `json:"events"`
	Runs   [][3]any `json:"runs"`
}

type cronRun struct {
	job        string
	mono, wall int64 // milliseconds
}

func (r cronRun) String() string {
	return fmt.Sprintf("%s@%.3fs/%s", r.job, float64(r.mono)/1000, time.UnixMilli(r.wall).UTC().Format("2006-01-02T15:04:05.000"))
}

// Node-RED job names (node-main.js) of the Go calendar timer names.
var cronJobOfTimer = map[string]string{
	"daily-schedule-0600":        "scheduler",
	"dendro-daily-inject":        "dendro",
	"outbox-retention-tick":      "outbox-retention",
	"gateway-health-rollup-tick": "gateway-health-rollup",
	"history-rollups-schedule":   "history-rollups",
}

const cronSimulatedSpan = 6 * 24 * time.Hour

// simulateCalendar replays one clock history through the calendar loop on a
// virtual clock. A boot stops the loop and starts a fresh one (a new
// process). seed > 0 adds real-time jitter to every release.
func simulateCalendar(t *testing.T, events [][3]any, loc *time.Location, seed int64) []cronRun {
	t.Helper()
	return simulateCalendarFault(t, events, loc, seed, nil)
}

// cronFault is one injected fault of the round-4 differential
// (node-real-fault.js): site "next" (the job's n-th next-time calculation),
// "rearm" (the n-th re-arm of the shared wake) or "handler" (the job's n-th
// emit panics in its input handler). Counts restart with every boot.
type cronFault struct {
	Site string `json:"site"`
	Job  string `json:"job"`
	N    int    `json:"n"`
}

func simulateCalendarFault(t *testing.T, events [][3]any, loc *time.Location, seed int64, fault *cronFault) []cronRun {
	t.Helper()
	defer func() { calendarExit = unexpectedCalendarExit }()
	var nextCalls, emits map[string]int
	var rearms int
	if fault != nil {
		calendarFaultHook = func(site, task string) {
			job := cronJobOfTimer[task]
			switch {
			case site == "oncearm" && fault.Site == "oncearm":
				if job == "dendro" {
					panic("injected once-arm fault")
				}
			case site == "next" && (fault.Site == "next" || fault.Site == "mixed"):
				nextCalls[job]++
				if job == fault.Job && nextCalls[job] == fault.N {
					panic("injected next fault")
				}
			case site == "rearm" && fault.Site == "rearm":
				rearms++
				if rearms == fault.N {
					panic("injected rearm fault")
				}
			}
		}
		t.Cleanup(func() { calendarFaultHook = nil })
	}
	var jitter *rand.Rand
	if seed > 0 {
		jitter = rand.New(rand.NewSource(seed))
	}
	// node-main.js sorts the events by uptime (Array.prototype.sort is stable).
	events = slices.Clone(events)
	sort.SliceStable(events, func(i, j int) bool { return cronMillis(t, events[i][1]) < cronMillis(t, events[j][1]) })
	var mu sync.Mutex
	var runs []cronRun
	var clock *virtualLoopClock
	var stop func()
	var mono time.Duration
	for _, e := range events {
		up := time.Duration(cronMillis(t, e[1])) * time.Millisecond
		value := time.Duration(cronMillis(t, e[2])) * time.Millisecond
		if clock != nil {
			clock.advanceTo(up)
		}
		mono = up
		switch e[0] {
		case "boot":
			// A fresh process: nothing of the earlier loop survives.
			if stop != nil {
				stop()
			}
			nextCalls, emits, rearms = map[string]int{}, map[string]int{}, 0
			c := newVirtualLoopClock(jitter)
			c.mono = mono
			c.off = value - mono
			clock = c
			// procd's respawn is the next boot event; the exit itself ends
			// this process's run and is recorded as Node's EXIT.
			calendarExit = func(code int) {
				if code != 1 {
					t.Errorf("calendar exit status %d, want 1", code)
				}
				mu.Lock()
				runs = append(runs, cronRun{"EXIT", c.Mono().Milliseconds(), c.Now().UnixMilli()})
				mu.Unlock()
				close(c.dead)
			}
			// The emit runs the inject's input handler (where the handler
			// fault is injected); the run is recorded at delivery, in the
			// check phase after the pass, as Node-RED's setImmediate router
			// hands it to the next node.
			stop = startCalendarLoopDelivering(context.Background(), c, loc, nodeRedCrons, func(name string) {
				job := cronJobOfTimer[name]
				if fault != nil && ((fault.Site == "handler" && fault.Job == job) || (fault.Site == "mixed" && job == "dendro")) {
					emits[job]++
					if emits[job] == fault.N {
						panic("injected handler fault")
					}
				}
			}, func(name string) {
				job, ok := cronJobOfTimer[name]
				if !ok {
					job = name
				}
				mu.Lock()
				runs = append(runs, cronRun{job, c.Mono().Milliseconds(), c.Now().UnixMilli()})
				mu.Unlock()
			})
			c.waitIdle() // the flows have started
		case "step":
			clock.step(value)
		default:
			t.Fatalf("unknown event %v", e)
		}
	}
	if clock != nil {
		clock.advanceTo(cronSimulatedSpan)
		stop()
	}
	mu.Lock()
	defer mu.Unlock()
	return slices.Clone(runs)
}

func nodeCronRuns(t *testing.T, h cronHistory, keep func(string) bool) []cronRun {
	t.Helper()
	var out []cronRun
	for _, r := range h.Runs {
		job, _ := r[0].(string)
		if keep(job) {
			out = append(out, cronRun{job, cronMillis(t, r[1]), cronMillis(t, r[2])})
		}
	}
	return out
}

// cronMillis reads an integer millisecond count from the Node-side JSON.
func cronMillis(t *testing.T, v any) int64 {
	t.Helper()
	n, ok := v.(json.Number)
	if !ok {
		t.Fatalf("not a number: %v", v)
	}
	ms, err := n.Int64()
	if err != nil {
		t.Fatalf("not an integer millisecond count: %v", v)
	}
	return ms
}

func loadCronHistories(t *testing.T, file string) (string, []cronHistory) {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		TZ        string        `json:"tz"`
		Histories []cronHistory `json:"histories"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&data); err != nil {
		t.Fatal(err)
	}
	return data.TZ, data.Histories
}

func cronHistoryFiles(t *testing.T) []string {
	t.Helper()
	// OSI_CRON_DIFF_DIR points at the full Node-side run (all generator
	// histories); the committed testdata holds the named histories and the
	// first 12 of each generator set.
	// Several directories may be given, separated by ':'.
	dirs := os.Getenv("OSI_CRON_DIFF_DIR")
	if dirs == "" {
		dirs = filepath.Join("testdata", "cron-shared-timer") + ":" + filepath.Join("testdata", "cron-shared-timer-ties")
	}
	var files []string
	for _, dir := range strings.Split(dirs, ":") {
		found, err := filepath.Glob(filepath.Join(dir, "*.json"))
		if err != nil || len(found) == 0 {
			t.Fatalf("no cron histories in %s: %v", dir, err)
		}
		files = append(files, found...)
	}
	return files
}

func compareCronRuns(t *testing.T, zone, name string, got, want []cronRun) bool {
	t.Helper()
	if slices.Equal(got, want) {
		return true
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s / %s:\n  Node-RED:", zone, name)
	for _, r := range want {
		b.WriteString(" " + r.String())
	}
	b.WriteString("\n  Go:      ")
	for _, r := range got {
		b.WriteString(" " + r.String())
	}
	t.Error(b.String())
	return false
}

func withProcessZone(t *testing.T, loc *time.Location) {
	t.Helper()
	before := jsdate.ConfiguredProcessZone()
	jsdate.SetProcessZone(loc)
	t.Cleanup(func() { jsdate.SetProcessZone(before) })
}

// Node-RED main runs its five crontab injects on one shared cronosjs timer:
// a wake dispatches every overdue task, and dendro's task, created 30 s after
// the flows start, dispatches the overdue ones when it starts. The 06:00
// daily schedule is the one of the five that Go ports; it must fire at the
// same monotonic and wall instants as on Node-RED, also when an occurrence
// is still running when the clock steps.
func TestDailyScheduleMatchesNodeRedSharedCronTimer(t *testing.T) {
	for _, file := range cronHistoryFiles(t) {
		zone, histories := loadCronHistories(t, file)
		loc := dailyNamedLocation(zone)
		withProcessZone(t, loc)
		bad := 0
		for _, h := range histories {
			want := nodeCronRuns(t, h, func(job string) bool { return job == "scheduler" })
			got := simulateCalendar(t, h.Events, loc, 0)
			got = slices.DeleteFunc(got, func(r cronRun) bool { return r.job != "scheduler" })
			if !compareCronRuns(t, zone, h.Name, got, want) {
				bad++
			}
		}
		t.Logf("%s: %d histories, %d differ", zone, len(histories), bad)
	}
}

// All five crontab tasks, the four Go keeps only as wake sources included,
// run in the same order at the same instants as on Node-RED: every batch
// wake, every start pass and dendro's once-run.
func TestNodeRedCronWakeSourcesMatchSharedCronTimer(t *testing.T) {
	for _, file := range cronHistoryFiles(t) {
		zone, histories := loadCronHistories(t, file)
		loc := dailyNamedLocation(zone)
		withProcessZone(t, loc)
		bad := 0
		for _, h := range histories {
			want := nodeCronRuns(t, h, func(string) bool { return true })
			got := simulateCalendar(t, h.Events, loc, 0)
			if !compareCronRuns(t, zone, h.Name, got, want) {
				bad++
			}
		}
		t.Logf("%s: %d histories, %d differ", zone, len(histories), bad)
	}
}

// The 06:00 cron Go runs is the timer it registers, not a wake source.
func TestNodeRedCronsPortOnlyTheDailySchedule(t *testing.T) {
	var ported []string
	for _, cron := range nodeRedCrons {
		if timer, ok := timers[cron.name]; ok {
			if timer.next == nil {
				t.Errorf("%s is registered without a calendar", cron.name)
			}
			ported = append(ported, cron.name)
		}
	}
	if !slices.Equal(ported, []string{"daily-schedule-0600"}) {
		t.Fatalf("ported crons = %v", ported)
	}
	for name, timer := range timers {
		if timer.next != nil && !slices.ContainsFunc(nodeRedCrons, func(c nodeRedCron) bool { return c.name == name }) {
			t.Errorf("calendar timer %s is not a Node-RED crontab inject", name)
		}
	}
}

// cronosDailyNext against CronosExpression.nextDate of the real cronosjs
// 1.7.1 (the spike's runs/cron-shared-timer/node/next-vectors.js): every
// 10 minutes for two days around each DST transition of 2026, and around
// each transition and cron time to the second. OSI_CRON_NEXT_DIR points at
// other vector sets (the year sweep). A POSIX rule in /etc/TZ must give the
// same dates as the named zone Node-RED's ICU maps it to (F-TZ-1).
func TestCronosDailyNextMatchesCronosjs(t *testing.T) {
	dir := os.Getenv("OSI_CRON_NEXT_DIR")
	if dir == "" {
		dir = filepath.Join("testdata", "cron-next")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) == 0 {
		t.Fatalf("no vectors in %s", dir)
	}
	posix := map[string]string{
		"Europe/Brussels":     "CET-1CEST,M3.5.0,M10.5.0/3",
		"America/Los_Angeles": "PST8PDT,M3.2.0,M11.1.0",
	}
	exprs := []struct{ hour, minute int }{{6, 0}, {8, 0}, {2, 0}, {2, 10}}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var data struct {
			TZ          string     `json:"tz"`
			Expressions []string   `json:"expressions"`
			Rows        [][]*int64 `json:"rows"`
		}
		if err := json.Unmarshal(raw, &data); err != nil {
			t.Fatal(err)
		}
		zones := []string{data.TZ}
		if rule, ok := posix[data.TZ]; ok {
			zones = append(zones, rule)
		}
		for _, zone := range zones {
			loc := dailyNamedLocation(zone)
			bad := 0
			for _, row := range data.Rows {
				after := time.UnixMilli(*row[0]).UTC()
				for i, e := range exprs {
					got := cronosDailyNext(after, loc, e.hour, e.minute)
					if e.hour == 6 {
						if daily := nextDailyScheduleIn(after, loc); !daily.Equal(got) {
							t.Errorf("%s after %s: nextDailyScheduleIn %s, cronosDailyNext %s", zone, after.Format(time.RFC3339Nano), daily, got)
						}
					}
					want := time.UnixMilli(*row[i+1]).UTC()
					if !got.Equal(want) {
						if bad < 10 {
							t.Errorf("%s %q after %s: got %s, cronosjs %s", zone, data.Expressions[i], after.Format(time.RFC3339Nano), got.UTC().Format(time.RFC3339), want.Format(time.RFC3339))
						}
						bad++
					}
				}
			}
			t.Logf("%s (%s): %d instants x %d expressions, %d differ", zone, filepath.Base(file), len(data.Rows), len(exprs), bad)
		}
	}
}

// The production wiring: startTimers runs the shared scheduler on the system
// clock, a ported cron's occurrence runs its registered tick, a wake source
// runs nothing, and stop waits for a running tick.
func TestCalendarTimersRunRegisteredTickOnSystemClock(t *testing.T) {
	const name = "test-calendar-system-clock"
	target := time.Now().Add(50 * time.Millisecond)
	ran := make(chan struct{}, 4)
	release := make(chan struct{})
	var finished atomic.Bool
	registerCalendarTimer(name, func(now time.Time) time.Time {
		if now.Before(target) {
			return target
		}
		return now.Add(time.Hour)
	}, func(_ *backend, _ context.Context) error {
		ran <- struct{}{}
		<-release
		finished.Store(true)
		return nil
	})
	saved := nodeRedCrons
	nodeRedCrons = []nodeRedCron{{name: name}, {name: "test-wake-source", hour: 2}}
	t.Cleanup(func() {
		nodeRedCrons = saved
		delete(timers, name)
	})
	stop := (&backend{}).startTimers(context.Background())
	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		stop()
		t.Fatal("calendar tick did not run on the system clock")
	}
	// cronosjs compares Date.now() in whole milliseconds.
	if time.Now().Before(target.Truncate(time.Millisecond)) {
		t.Fatal("calendar tick ran before its occurrence")
	}
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("stop returned while the tick was running")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	<-stopped
	if !finished.Load() {
		t.Fatal("stop returned before the tick finished")
	}
	select {
	case <-ran:
		t.Fatal("calendar tick ran twice for one occurrence")
	default:
	}
}

// Cancelling the parent context alone stops the calendar wakes, as the
// per-timer runner's select on ctx.Done did. No tick runs with a cancelled
// context.
func TestCalendarTimersStopOnParentCancel(t *testing.T) {
	const name = "test-calendar-parent-cancel"
	target := time.Now().Add(80 * time.Millisecond)
	ran := make(chan struct{}, 4)
	registerCalendarTimer(name, func(now time.Time) time.Time {
		if now.Before(target) {
			return target
		}
		return now.Add(time.Hour)
	}, func(_ *backend, _ context.Context) error {
		ran <- struct{}{}
		return nil
	})
	saved := nodeRedCrons
	nodeRedCrons = []nodeRedCron{{name: name}}
	t.Cleanup(func() {
		nodeRedCrons = saved
		delete(timers, name)
	})
	ctx, cancel := context.WithCancel(context.Background())
	stop := (&backend{}).startTimers(ctx)
	defer stop()
	cancel()
	time.Sleep(250 * time.Millisecond)
	select {
	case <-ran:
		t.Fatal("calendar tick ran after the parent context was cancelled")
	default:
	}
}

// A panic in the calendar callback itself (here in the cron's next, right
// after the emit) is a scheduler fault: logged, then the process exits with
// status 1 through calendarExit, as Node-RED's uncaughtException handler
// does, before the emit's delivery.
func TestCalendarCallbackPanicIsRecovered(t *testing.T) {
	const name = "test-calendar-panic"
	target := time.Now().Add(50 * time.Millisecond)
	ran := make(chan struct{}, 4)
	exited := make(chan int, 1)
	var calls atomic.Int32
	registerCalendarTimer(name, func(now time.Time) time.Time {
		if calls.Add(1) > 1 {
			panic("calendar next panicked")
		}
		return target
	}, func(_ *backend, _ context.Context) error {
		ran <- struct{}{}
		return nil
	})
	saved := nodeRedCrons
	nodeRedCrons = []nodeRedCron{{name: name}}
	calendarExit = func(code int) { exited <- code }
	t.Cleanup(func() {
		nodeRedCrons = saved
		delete(timers, name)
		calendarExit = unexpectedCalendarExit
	})
	stop := (&backend{}).startTimers(context.Background())
	defer stop()
	select {
	case code := <-exited:
		if code != 1 {
			t.Fatalf("exit status %d, want 1", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a fault in next did not exit")
	}
	// The emit's delivery was queued for the check phase of the pass that
	// faulted: like Node-RED's setImmediate after process.exit, it never runs.
	time.Sleep(100 * time.Millisecond)
	select {
	case <-ran:
		t.Fatal("the faulting pass's tick was delivered")
	default:
	}
}

// Every test in the package runs the calendar loop strictly: a scheduler
// callback or timer call off the loop goroutine panics.
func TestMain(m *testing.M) {
	calendarLoopStrict = true
	// A fenced operation on the loop goroutine during its own timers pass
	// would deadlock in production; every test panics on it instead.
	procfence.ReentryCheck = func() uint64 { id, _ := goroutineID(); return id }
	if os.Getenv("OSI_CALENDAR_EXIT_CHILD") == "" {
		calendarExit = unexpectedCalendarExit
		// A simulated fault must not fence the database of later tests.
		calendarFence = func() {}
	} // the exit children keep the production fence and os.Exit
	os.Exit(m.Run())
}

// unexpectedCalendarExit ends the test binary loudly: a scheduler fault that
// no test expected.
func unexpectedCalendarExit(code int) {
	fmt.Fprintf(os.Stderr, "UNEXPECTED CALENDAR EXIT(%d) in a test\n", code)
	os.Exit(3)
}

// The full history sets under -race with real-time jitter on the virtual
// clock: every release of the loop is delayed by a random real-time amount
// and sometimes the loop is woken early without time moving. The results
// must stay exactly Node-RED's for all five jobs. OSI_CRON_JITTER_SEEDS lists
// the seeds (comma separated); the default runs one.
func TestSharedCronTimerUnderJitter(t *testing.T) {
	seeds := []int64{1}
	if env := os.Getenv("OSI_CRON_JITTER_SEEDS"); env != "" {
		seeds = nil
		for _, f := range strings.Split(env, ",") {
			var seed int64
			if _, err := fmt.Sscan(f, &seed); err != nil || seed <= 0 {
				t.Fatalf("bad seed %q", f)
			}
			seeds = append(seeds, seed)
		}
	}
	for _, seed := range seeds {
		for _, file := range cronHistoryFiles(t) {
			zone, histories := loadCronHistories(t, file)
			loc := dailyNamedLocation(zone)
			withProcessZone(t, loc)
			bad := 0
			for i, h := range histories {
				want := nodeCronRuns(t, h, func(string) bool { return true })
				got := simulateCalendar(t, h.Events, loc, seed*100003+int64(i))
				if !compareCronRuns(t, zone, h.Name, got, want) {
					bad++
				}
			}
			t.Logf("seed %d %s (%s): %d histories, %d differ", seed, zone, filepath.Base(filepath.Dir(file)), len(histories), bad)
		}
	}
}

// Every timer call and callback asserts that it runs on the loop goroutine.
// A call from any other goroutine panics in strict mode (all tests) and is
// logged in production.
func TestCalendarLoopRejectsOffLoopCalls(t *testing.T) {
	clock := newVirtualLoopClock(nil)
	l := newCalendarLoop(clock, time.UTC, nil, func(string) {})
	stop := make(chan struct{})
	go func() {
		defer close(stop)
		l.gid, _ = goroutineID() // this goroutine is the loop
	}()
	<-stop
	for name, call := range map[string]func(){
		"setTimeout":   func() { l.setTimeout(func() {}, 10) },
		"clearTimeout": func() { l.clearTimeout(&nodeTimer{}) },
		"task start": func() {
			l.startTask(&calendarTask{name: "x", next: func(now time.Time) time.Time { return now.Add(time.Hour) }})
		},
		"dispatch": func() { l.dispatch(&calendarTask{name: "x"}) },
		"callback": func() { l.runCallback("timer callback", func() {}) },
	} {
		func() {
			defer func() {
				p := recover()
				if v, ok := p.(calendarLoopViolation); !ok || !strings.HasPrefix(string(v), "CALENDAR LOOP VIOLATION: ") {
					t.Errorf("%s off the loop: recovered %v, want a loop violation", name, p)
				}
			}()
			call()
		}()
	}
}

// runTask's emit runs through dispatch, whose recover must not swallow a
// loop violation (Sol's round-3 probe, seam.log): with the wrong loop id the
// violation reaches the caller and nothing is emitted.
func TestRunTaskDoesNotSwallowLoopViolation(t *testing.T) {
	l := newCalendarLoop(newVirtualLoopClock(nil), time.UTC, nil, func(string) { t.Error("off-loop dispatch reached emit") })
	id, _ := goroutineID()
	l.gid = id + 1
	defer func() {
		if _, ok := recover().(calendarLoopViolation); !ok {
			t.Error("strict off-loop panic swallowed by runTask")
		}
	}()
	l.runTask(&calendarTask{name: "daily-schedule-0600", next: func(now time.Time) time.Time { return now.Add(time.Hour) }})
}

// The goroutine check fails closed: a loop that never recorded its id
// rejects every caller, its own goroutine included.
func TestCalendarLoopCheckFailsClosed(t *testing.T) {
	if id, ok := goroutineID(); !ok || id == 0 {
		t.Fatalf("goroutineID() = %d, %t", id, ok)
	}
	l := newCalendarLoop(newVirtualLoopClock(nil), time.UTC, nil, func(string) {})
	defer func() {
		if _, ok := recover().(calendarLoopViolation); !ok {
			t.Error("an unset loop id accepted the caller")
		}
	}()
	l.setTimeout(func() {}, 10)
}

func faultHistoryFiles(t *testing.T) []string {
	t.Helper()
	dir := os.Getenv("OSI_CRON_FAULT_DIR")
	if dir == "" {
		dir = filepath.Join("testdata", "cron-shared-timer-faults")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) == 0 {
		t.Fatalf("no fault histories in %s", dir)
	}
	return files
}

// Faults by site, against Node 20's real timers with cronosjs 1.7.1 and the
// same injected faults (node-real-fault.js):
//   - next or rearm (inside the scheduler): the cronosjs pass that threw
//     re-inserts nothing more and does not re-arm the shared wake, so every
//     cron task stays dormant until the next task start (dendro's once start
//     or a boot); a throw at flow start loses only that node;
//   - handler (the inject's input handler): logged, the cron goes on.
//
// All five jobs, every instant, in every zone. OSI_CRON_JITTER_SEEDS adds
// jittered runs.
func TestCalendarFaultsMatchNodeRed(t *testing.T) {
	seeds := []int64{0}
	if env := os.Getenv("OSI_CRON_JITTER_SEEDS"); env != "" {
		for _, f := range strings.Split(env, ",") {
			var seed int64
			fmt.Sscan(f, &seed)
			seeds = append(seeds, seed)
		}
	}
	for _, file := range faultHistoryFiles(t) {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var data struct {
			TZ        string `json:"tz"`
			Histories []struct {
				cronHistory
				Fault cronFault `json:"fault"`
			} `json:"histories"`
		}
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.UseNumber()
		if err := dec.Decode(&data); err != nil {
			t.Fatal(err)
		}
		loc := dailyNamedLocation(data.TZ)
		withProcessZone(t, loc)
		for _, seed := range seeds {
			bad := 0
			for i, h := range data.Histories {
				want := nodeCronRuns(t, h.cronHistory, func(string) bool { return true })
				fault := h.Fault
				s := int64(0)
				if seed > 0 {
					s = seed*100003 + int64(i)
				}
				got := simulateCalendarFault(t, h.Events, loc, s, &fault)
				if !compareCronRuns(t, data.TZ, h.Name, got, want) {
					bad++
				}
			}
			t.Logf("seed %d %s: %d fault histories, %d differ", seed, data.TZ, len(data.Histories), bad)
		}
	}
}

// The production exit, in a child process. The scheduler fault here is in
// next, during the pass of the second occurrence, right after its emit. The
// fault logs, then exits with status 1 at once. The first occurrence's tick,
// delivered after its own pass, ran. The second's was queued for the check
// phase and never runs, as Node-RED's setImmediate delivery never runs after
// process.exit. The child's deferred print never runs either (no deferred
// function, no SIGTERM path).
func TestCalendarSchedulerFaultExitsProcess(t *testing.T) {
	if os.Getenv("OSI_CALENDAR_EXIT_CHILD") != "" {
		calendarExitChild()
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCalendarSchedulerFaultExitsProcess$", "-test.count=1")
	cmd.Env = append(os.Environ(), "OSI_CALENDAR_EXIT_CHILD=1")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("child exit: %v (want status 1)\nstdout:\n%s\nstderr:\n%s", err, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "CALENDAR SCHEDULER FAULT") || !strings.Contains(stderr.String(), "exiting with status 1") {
		t.Errorf("child did not log the scheduler fault:\n%s", stderr.String())
	}
	if got := strings.Count(stdout.String(), "TICK\n"); got != 1 {
		t.Errorf("child ticks = %d, want 1\n%s", got, stdout.String())
	}
	if strings.Contains(stdout.String(), "DEFERRED") {
		t.Errorf("a deferred function ran after the exit:\n%s", stdout.String())
	}
}

func calendarExitChild() {
	const name = "test-calendar-exit-child"
	first := time.Now().Add(50 * time.Millisecond)
	second := first.Add(300 * time.Millisecond)
	var calls atomic.Int32
	registerCalendarTimer(name, func(now time.Time) time.Time {
		switch calls.Add(1) {
		case 1:
			return first
		case 2:
			return second
		}
		panic("calendar next panicked")
	}, func(_ *backend, _ context.Context) error {
		fmt.Print("TICK\n")
		return nil
	})
	nodeRedCrons = []nodeRedCron{{name: name}}
	defer fmt.Print("DEFERRED\n")
	stop := (&backend{}).startTimers(context.Background())
	defer stop()
	time.Sleep(3 * time.Second) // the fault exits long before
	fmt.Print("NO EXIT\n")
}

// The write window between a scheduler fault and the exit (Sol's round-5
// probe, window.txt), in a child process with the production fence and
// os.Exit. A transaction that began before the fault tries to commit while
// the fault is being logged, and an autocommit INSERT starts in the same
// window: neither may commit. A statement already running when the fence
// closes would complete, as in node-sqlite3's thread pool; these start
// after it.
func TestCalendarFaultFencesWritesBeforeExit(t *testing.T) {
	if path := os.Getenv("OSI_CALENDAR_WINDOW_DB"); path != "" {
		calendarWindowChild(path)
		return
	}
	path := filepath.Join(t.TempDir(), "window.db")
	cmd := exec.Command(os.Args[0], "-test.run=^TestCalendarFaultFencesWritesBeforeExit$", "-test.count=1")
	cmd.Env = append(os.Environ(), "OSI_CALENDAR_EXIT_CHILD=1", "OSI_CALENDAR_WINDOW_DB="+path)
	out, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("child exit: %v (want status 1)\n%s", err, out)
	}
	if !strings.Contains(string(out), "WINDOW READY") {
		t.Fatalf("the child did not reach the window:\n%s", out)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM effects").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("effects rows after the exit = %d, want 1 (only the row committed before the fault)\n%s", rows, out)
	}
}

// windowWriter stands for the log write of the fault path: it lets the two
// writers go, gives them time to reach the database, then writes.
type windowWriter struct{ entered chan struct{} }

func (w windowWriter) Write(p []byte) (int, error) {
	select {
	case <-w.entered:
	default:
		close(w.entered)
		time.Sleep(300 * time.Millisecond)
	}
	return os.Stderr.Write(p)
}

func calendarWindowChild(path string) {
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		panic(err)
	}
	db, err := openDB(path)
	if err != nil {
		panic(err)
	}
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "CREATE TABLE effects (id INTEGER)"); err != nil {
		panic(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO effects VALUES (0)"); err != nil {
		panic(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		panic(err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO effects VALUES (1)"); err != nil {
		panic(err)
	}
	w := windowWriter{entered: make(chan struct{})}
	log.SetOutput(w)
	go func() {
		<-w.entered
		fmt.Fprintln(os.Stderr, "WINDOW READY")
		if err := tx.Commit(); err != nil { // the open transaction's COMMIT
			panic(err)
		}
		fmt.Fprintln(os.Stderr, "COMMITTED IN THE WINDOW")
	}()
	go func() {
		<-w.entered
		time.Sleep(50 * time.Millisecond) // the transaction holds the gate first
		db.ExecContext(ctx, "INSERT INTO effects VALUES (2)")
	}()
	(&calendarLoop{}).schedulerFault("window probe", "synthetic fault")
}

// Production mode (not strict): an off-loop call is a scheduler fault. The
// fence closes first, then the process exits with status 1.
func TestCalendarLoopViolationExitsInProduction(t *testing.T) {
	var order []string
	calendarLoopStrict = false
	calendarFence = func() { order = append(order, "fence") }
	calendarExit = func(code int) { order = append(order, fmt.Sprintf("exit %d", code)) }
	t.Cleanup(func() {
		calendarLoopStrict = true
		calendarFence = func() {}
		calendarExit = unexpectedCalendarExit
	})
	for _, name := range []string{"wrong goroutine", "unset loop id"} {
		order = nil
		l := newCalendarLoop(newVirtualLoopClock(nil), time.UTC, nil, func(string) {})
		if name == "wrong goroutine" {
			id, _ := goroutineID()
			l.gid = id + 1
		}
		func() {
			defer func() {
				if _, ok := recover().(calendarLoopExited); !ok {
					t.Errorf("%s: no exit unwind", name)
				}
			}()
			l.setTimeout(func() {}, 10)
			t.Errorf("%s: setTimeout returned in production after a violation", name)
		}()
		if !slices.Equal(order, []string{"fence", "exit 1"}) {
			t.Errorf("%s: fault path %v, want [fence exit 1]", name, order)
		}
	}
}

// The effect fence covers the database because every production connection
// to farming.db is opened through nodeTextDriver (sqlite_text.go). The bare
// modernc driver is used only to look up the driver for registration and by
// the tls-check mode, a separate process that never runs the scheduler.
func TestFarmDatabaseOpensOnlyThroughTheFencedDriver(t *testing.T) {
	allowed := map[string]string{
		"sqlite_text.go": `sql.Open("sqlite", "")`,
		"tls_check.go":   `sql.Open("sqlite", dsn.String())`,
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(src), "\n") {
			if !strings.Contains(line, "sql.Open(") || strings.Contains(line, "sql.Open(nodeTextDriver,") {
				continue
			}
			if want, ok := allowed[file]; !ok || !strings.Contains(line, want) {
				t.Errorf("%s:%d opens a database outside the fenced driver: %s", file, i+1, strings.TrimSpace(line))
			}
		}
	}
	// internal/store opens its own pool (Open, integrityCheck); the backend
	// uses only these two helpers from it, neither of which opens a database.
	used := map[string]bool{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, _ := os.ReadFile(file)
		for _, m := range regexp.MustCompile(`\bstore\.([A-Z]\w*)`).FindAllStringSubmatch(string(src), -1) {
			used[m[1]] = true
		}
	}
	for name := range used {
		if name != "ImmediateTxOnConn" && name != "ModTime" {
			t.Errorf("the backend uses store.%s; check that it does not open farming.db outside the fenced driver", name)
		}
	}
}

// After the fence closes no new radio call (the ChirpStack gRPC
// interceptor) or cloud MQTT publish starts. Child process: the fence is
// process-wide and does not reopen.
func TestProcessFenceStopsRadioAndCloudPublish(t *testing.T) {
	if os.Getenv("OSI_CALENDAR_FENCE_CHILD") != "" {
		procfence.Close()
		var started atomic.Int32
		go radioFence(context.Background(), "/api.DeviceService/Enqueue", nil, nil, nil,
			func(context.Context, string, any, any, *grpc.ClientConn, ...grpc.CallOption) error {
				started.Add(1)
				return nil
			})
		go func() {
			(&cloudmqtt.Client{}).Publish("devices/x/status", []byte("{}"))
			started.Add(1)
		}()
		go func() {
			(&cloudmqtt.Client{}).PublishAwait(context.Background(), "devices/x/status", []byte("{}"))
			started.Add(1)
		}()
		time.Sleep(200 * time.Millisecond)
		fmt.Printf("STARTED %d\n", started.Load())
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessFenceStopsRadioAndCloudPublish$", "-test.count=1")
	cmd.Env = append(os.Environ(), "OSI_CALENDAR_FENCE_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "STARTED 0") {
		t.Fatalf("an effect started after the fence closed:\n%s", out)
	}
}
