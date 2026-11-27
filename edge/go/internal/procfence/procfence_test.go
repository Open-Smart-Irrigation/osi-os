package procfence

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestAdmitBlocksOnceClosed(t *testing.T) {
	const child = "OSI_PROCFENCE_TEST_CLOSE_CHILD"
	if os.Getenv(child) != "1" {
		// Close is permanent. Isolate it from other tests and repetitions.
		cmd := exec.Command(os.Args[0], "-test.run=^TestAdmitBlocksOnceClosed$", "-test.timeout=5s")
		cmd.Env = append(os.Environ(), child+"=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("close fence in child: %v\n%s", err, output)
		}
		return
	}

	Admit() // open: returns
	Close()
	Close() // idempotent
	if !Closed() {
		t.Fatal("fence not closed")
	}
	done := make(chan struct{})
	go func() {
		Admit()
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("Admit returned after Close")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAdmitWaitsForThePass(t *testing.T) {
	PassBegin(1)
	done := make(chan struct{})
	go func() {
		Admit()
		close(done)
	}()
	select {
	case <-done:
		PassEnd()
		t.Fatal("Admit returned during a timers pass")
	case <-time.After(100 * time.Millisecond):
	}
	PassEnd()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Admit did not return after the timers pass")
	}
}

func TestReentryIsDetected(t *testing.T) {
	ReentryCheck = func() uint64 { return 7 }
	defer func() { ReentryCheck = nil }()
	PassBegin(7)
	defer PassEnd()
	defer func() {
		if recover() == nil {
			t.Fatal("a fenced operation inside the pass was not detected")
		}
	}()
	Admit()
}

func BenchmarkPass(b *testing.B) {
	for b.Loop() {
		PassBegin(1)
		PassEnd()
	}
}
