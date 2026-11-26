package ingest

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"osi-edge/internal/jsvalue"
)

type msg struct{ mqtt.Message }

func (msg) Ack() {}

func (msg) Topic() string   { return "application/x/device/y/event/up" }
func (msg) Payload() []byte { return []byte("{}") }

// Uplinks keep arriving while settle waiters wake (review r1 finding 4);
// nothing may panic and every settle returns once the backlog is drained.
func TestSettleOverlapsNewUplinks(t *testing.T) {
	s := New()
	var handled sync.WaitGroup
	s.Handle("h", func(context.Context, Uplink) error { time.Sleep(time.Microsecond); handled.Done(); return nil })
	s.startDispatch(context.Background())
	t.Cleanup(s.Stop)
	var wg sync.WaitGroup
	for i := 0; i < 500; i++ {
		handled.Add(1)
		wg.Add(2)
		go func() { defer wg.Done(); s.receive(nil, msg{}) }()
		go func() { defer wg.Done(); s.Settle() }()
	}
	wg.Wait()
	handled.Wait()
	s.Settle()
	if s.pending != 0 {
		t.Fatalf("pending %d", s.pending)
	}
}

func TestHandlerPanicIsRecoveredAndLaterHandlersRun(t *testing.T) {
	s := New()
	ran := false
	s.Handle("boom", func(context.Context, Uplink) error { panic("boom") })
	s.Handle("after", func(context.Context, Uplink) error { ran = true; return nil })
	s.startDispatch(context.Background())
	t.Cleanup(s.Stop)
	s.receive(nil, msg{})
	s.Settle()
	if !ran {
		t.Fatal("handler after a panicking one did not run")
	}
}

func TestHandlerConversionIsReportedAsJSError(t *testing.T) {
	h := named{"conversion", func(context.Context, Uplink) error {
		jsvalue.Obj(jsvalue.Property("toString", jsvalue.Nil())).MustNumber()
		t.Error("uplink handler continued after conversion error")
		return nil
	}}
	var exception *jsvalue.JSError
	if err := run(t.Context(), h, Uplink{}); !errors.As(err, &exception) || exception.Name != "TypeError" {
		t.Fatalf("uplink conversion error = %v", err)
	}
}
