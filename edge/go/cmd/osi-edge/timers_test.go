package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"osi-edge/internal/jsvalue"
)

func TestRegisteredTimerSkipsOverlappingTick(t *testing.T) {
	const name = "test-timer-overlap"
	started := make(chan struct{})
	release := make(chan struct{})
	var running atomic.Int32
	registerTimer(name, time.Millisecond, time.Millisecond, func(_ *backend, ctx context.Context) error {
		if n := running.Add(1); n != 1 {
			t.Errorf("overlapping timer tick: %d running", n)
		}
		defer running.Add(-1)
		select {
		case <-started:
		default:
			close(started)
		}
		select {
		case <-ctx.Done():
		case <-release:
		}
		return nil
	})
	t.Cleanup(func() { delete(timers, name) })

	b := &backend{}
	stop := b.startTimers(context.Background())
	defer stop()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("registered timer did not run with test hooks off")
	}

	// The automatic tick is blocked inside the timer. A second entry point
	// must skip it even when it is requested synchronously.
	if err := b.tick(t.Context(), name); err != nil {
		t.Fatal(err)
	}
	if got := running.Load(); got != 1 {
		t.Fatalf("running ticks = %d, want 1", got)
	}
	close(release)
}

func TestValveInjectCadence(t *testing.T) {
	for _, test := range []struct {
		name string
		boot time.Duration
	}{
		{"valve-once-tick", 20 * time.Second},
		{"valve-clock-tick", 90 * time.Second},
	} {
		timer := timers[test.name]
		if timer.boot != test.boot || timer.period != time.Minute {
			t.Errorf("%s: boot=%v repeat=%v", test.name, timer.boot, timer.period)
		}
	}

	const name = "test-inject-cadence"
	const boot, repeat = 75 * time.Millisecond, 45 * time.Millisecond
	fired := make(chan time.Time, 8)
	registerTimer(name, repeat, boot, func(_ *backend, _ context.Context) error {
		select {
		case fired <- time.Now():
		default:
		}
		return nil
	})
	t.Cleanup(func() { delete(timers, name) })
	start := time.Now()
	stop := (&backend{}).startTimers(context.Background())
	defer stop()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for i := range 3 {
		select {
		case at := <-fired:
			earliest := boot + time.Duration(i)*repeat
			if elapsed := at.Sub(start); elapsed < earliest {
				t.Fatalf("tick %d fired after %v, want at least %v", i, elapsed, earliest)
			}
		case <-deadline.C:
			t.Fatal("timed out waiting for inject ticks")
		}
	}
}

func TestTimerConversionCatchAllowsNextTick(t *testing.T) {
	const name = "test-timer-coercion"
	ticks := 0
	registerTimer(name, time.Second, 0, func(_ *backend, _ context.Context) error {
		ticks++
		if ticks == 1 {
			jsvalue.Obj(jsvalue.Property("toString", jsvalue.Nil())).MustNumber()
			t.Error("timer continued after conversion error")
		}
		return nil
	})
	t.Cleanup(func() { delete(timers, name) })
	b := &backend{}
	for i := 0; i < 2; i++ {
		if err := b.tick(t.Context(), name); err != nil {
			t.Fatal(err)
		}
	}
	if ticks != 2 {
		t.Fatalf("runs after conversion catch = %d", ticks)
	}
}
