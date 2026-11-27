package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chirpstack/chirpstack/api/go/v4/api"
	"google.golang.org/grpc"

	"osi-edge/internal/jsvalue"
	"osi-edge/internal/procfence"
)

// Sol's final-review probe (runs/review-cron-shared-timer-r6/
// window_http_test.go), adapted to assert the Node behaviour. During a
// timers pass that later throws, an HTTP request (a manual valve dispatch)
// tries to send a fresh ChirpStack enqueue. In Node-RED no HTTP callback
// runs during the pass, and the throw exits the process, so the enqueue
// never reaches ChirpStack. Child process: production fence and os.Exit.
// (The review's two F items in the same probe, the lazy login-secret write
// and a DB-free 404, are registry items and not asserted here.)
func TestReviewIndependentWindow(t *testing.T) {
	if os.Getenv("OSI_REVIEW_WINDOW_CHILD") == "1" {
		reviewWindowChild(t)
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestReviewIndependentWindow$", "-test.count=1")
	cmd.Env = append(os.Environ(), "OSI_REVIEW_WINDOW_CHILD=1", "OSI_CALENDAR_EXIT_CHILD=1")
	out, err := cmd.CombinedOutput()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
		t.Fatalf("child exit: %v (want status 1)\n%s", err, out)
	}
	if !strings.Contains(string(out), "HTTP REQUEST STARTED") || !strings.Contains(string(out), "CALENDAR SCHEDULER FAULT") {
		t.Fatalf("the child did not reach the window:\n%s", out)
	}
	if strings.Contains(string(out), "RADIO STARTED DURING TIMERS PASS") {
		t.Fatalf("a radio enqueue started during the timers pass that faulted:\n%s", out)
	}
}

func reviewWindowChild(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	api.RegisterDeviceServiceServer(server, reviewRadioServer{})
	go server.Serve(listener)
	t.Setenv("CHIRPSTACK_API_URL", "http://"+listener.Addr().String())
	t.Setenv("CHIRPSTACK_API_KEY", "synthetic")
	running := make(chan struct{})
	go func() {
		<-running
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			radio, err := openValveRadio()
			if err != nil {
				panic(err)
			}
			defer radio.conn.Close()
			transport := jsvalue.Obj()
			fmt.Fprintln(os.Stderr, "HTTP REQUEST STARTED")
			radio.enqueueValveFrame(r.Context(), "A840410000000001", 10, []byte{1}, &transport)
			w.WriteHeader(http.StatusNoContent)
		})
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/synthetic-valve", nil))
	}()
	loop := newCalendarLoop(systemLoopClock{start: time.Now()}, time.UTC, nil, func(string) {})
	loop.gid, _ = goroutineID()
	loop.setTimeout(func() {
		close(running)
		time.Sleep(300 * time.Millisecond) // the request reaches its enqueue
		panic("synthetic next-time fault")
	}, 1)
	loop.timersPass(func() { loop.processTimers(10) })
}

type reviewRadioServer struct {
	api.UnimplementedDeviceServiceServer
}

func (reviewRadioServer) Enqueue(context.Context, *api.EnqueueDeviceQueueItemRequest) (*api.EnqueueDeviceQueueItemResponse, error) {
	fmt.Fprintln(os.Stderr, "RADIO STARTED DURING TIMERS PASS")
	return &api.EnqueueDeviceQueueItemResponse{Id: "00000000-0000-4000-8000-000000000001"}, nil
}

// The normal path: timers passes every 2 ms while uplink-style writers and
// HTTP handlers use farming.db concurrently. Every statement completes, the
// rows are exactly the ones written, and passes run throughout. The same
// workload without the loop gives the latency baseline; the test logs both.
func TestTimersPassesDoNotStallConcurrentWork(t *testing.T) {
	const name = "test-calendar-busy-passes"
	var passes atomic.Int64
	registerCalendarTimer(name, func(now time.Time) time.Time { return now.Add(2 * time.Millisecond) },
		func(*backend, context.Context) error { return nil })
	saved := nodeRedCrons
	nodeRedCrons = []nodeRedCron{{name: name}}
	t.Cleanup(func() {
		nodeRedCrons = saved
		delete(timers, name)
	})
	path := filepath.Join(t.TempDir(), "busy.db")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "CREATE TABLE effects (source TEXT, n INTEGER)"); err != nil {
		t.Fatal(err)
	}
	workload := func(label string) []time.Duration {
		var mu sync.Mutex
		var lat []time.Duration
		timed := func(fn func() error) {
			start := time.Now()
			if err := fn(); err != nil {
				t.Errorf("%s: %v", label, err)
			}
			mu.Lock()
			lat = append(lat, time.Since(start))
			mu.Unlock()
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			timed(func() error {
				var n int
				if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM effects").Scan(&n); err != nil {
					return err
				}
				_, err := db.ExecContext(r.Context(), "INSERT INTO effects VALUES (?, ?)", label+"-http", n)
				return err
			})
		}))
		defer srv.Close()
		var wg sync.WaitGroup
		for w := range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range 250 {
					timed(func() error {
						_, err := db.ExecContext(ctx, "INSERT INTO effects VALUES (?, ?)", label+"-uplink", w*1000+i)
						return err
					})
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				resp, err := http.Post(srv.URL, "text/plain", nil)
				if err != nil {
					t.Error(err)
					return
				}
				resp.Body.Close()
			}
		}()
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(60 * time.Second):
			t.Fatalf("%s: concurrent work stalled", label)
		}
		return lat
	}
	baseline := workload("baseline")
	var outsidePass atomic.Int64
	stop := startCalendarLoop(ctx, systemLoopClock{start: time.Now()}, time.UTC, nodeRedCrons, func(string) {
		passes.Add(1)
		if !procfence.InPass() { // the production loop runs every emit inside a held pass
			outsidePass.Add(1)
		}
	})
	during := workload("passes")
	stop()
	for _, label := range []string{"baseline", "passes"} {
		var uplinks, httpRows int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM effects WHERE source = ?", label+"-uplink").Scan(&uplinks); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM effects WHERE source = ?", label+"-http").Scan(&httpRows); err != nil {
			t.Fatal(err)
		}
		if uplinks != 1000 || httpRows != 100 {
			t.Errorf("%s: %d uplink rows and %d HTTP rows, want 1000 and 100", label, uplinks, httpRows)
		}
	}
	if outsidePass.Load() != 0 {
		t.Errorf("%d emits ran outside a held timers pass", outsidePass.Load())
	}
	if passes.Load() < 20 {
		t.Errorf("only %d timers passes ran during the workload", passes.Load())
	}
	pct := func(lat []time.Duration, q float64) time.Duration {
		slices.Sort(lat)
		return lat[int(q*float64(len(lat)-1))]
	}
	msg := fmt.Sprintf("statement latency p50/p99/max: baseline %v/%v/%v; with %d timers passes %v/%v/%v",
		pct(baseline, .5), pct(baseline, .99), pct(baseline, 1), passes.Load(), pct(during, .5), pct(during, .99), pct(during, 1))
	t.Log(msg)
}
