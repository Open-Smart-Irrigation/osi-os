package main

import (
	"context"
	"fmt"
	"log"
	"runtime/debug"
	"sync"
	"time"

	"osi-edge/internal/jsvalue"
)

// Timer names match edge/harness/timers.json. Inject initial delays are also
// followed by the periodic runs, as in Node-RED’s Inject node.
type timerFunc func(b *backend, ctx context.Context) error

type edgeTimer struct {
	fn           timerFunc
	period, boot time.Duration
	next         func(time.Time) time.Time
	running      sync.Mutex
}

var timers = map[string]*edgeTimer{}

func registerTimer(name string, period, boot time.Duration, fn timerFunc) {
	if _, dup := timers[name]; dup {
		panic("duplicate timer " + name)
	}
	timers[name] = &edgeTimer{fn: fn, period: period, boot: boot}
}

func registerCalendarTimer(name string, next func(time.Time) time.Time, fn timerFunc) {
	registerTimer(name, 0, 0, fn)
	timers[name].next = next
}

func (b *backend) tick(ctx context.Context, name string) (err error) {
	timer, ok := timers[name]
	if !ok {
		return fmt.Errorf("unknown timer %q", name)
	}
	if !timer.running.TryLock() {
		return nil
	}
	defer timer.running.Unlock()
	defer func() {
		if p := recover(); p != nil {
			if exception, ok := p.(*jsvalue.JSError); ok {
				log.Printf("timer %s: %s: %s", name, exception.Name, exception.Message)
				return
			}
			err = fmt.Errorf("timer %s panic: %v", name, p)
			log.Printf("%v\n%s", err, debug.Stack())
		}
	}()
	b.writes.RLock()
	defer b.writes.RUnlock()
	return timer.fn(b, ctx)
}

func (b *backend) startTimers(parent context.Context) (stop func()) {
	if b.testHooks {
		return func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	stopCalendar := b.startCalendarTimers(ctx, &workers)
	for name, timer := range timers {
		if timer.next != nil {
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() {
				if p := recover(); p != nil {
					log.Printf("timer %s scheduler panic: %v\n%s", name, p, debug.Stack())
				}
			}()
			if timer.boot > 0 {
				initial := time.NewTimer(timer.boot)
				defer initial.Stop()
				select {
				case <-ctx.Done():
					return
				case <-initial.C:
				}
			}
			cadence := time.NewTicker(timer.period)
			defer cadence.Stop()
			var lastDone time.Time
			if timer.boot > 0 {
				if err := b.tick(ctx, name); err != nil {
					log.Printf("timer %s: %v", name, err)
				}
				lastDone = time.Now()
			}
			for ctx.Err() == nil {
				var at time.Time
				select {
				case <-ctx.Done():
					return
				case at = <-cadence.C:
				}
				if at.Before(lastDone) {
					continue
				}
				if err := b.tick(ctx, name); err != nil {
					log.Printf("timer %s: %v", name, err)
				}
				lastDone = time.Now()
			}
		}()
	}
	return func() {
		cancel()
		stopCalendar()
		workers.Wait()
	}
}
