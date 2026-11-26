package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/chirpstack/chirpstack/api/go/v4/api"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func TestValveAttemptIsDurableBeforeEnqueue(t *testing.T) {
	const (
		eui       = "A840410000000001"
		commandID = "1350927b-03d4-4bb5-8e22-87ad588bc711"
		queueID   = "d4e9ac79-94b1-4971-9495-96cf10c34122"
		token     = "synthetic-valve-test"
	)
	for _, test := range []struct {
		name, phase, returnedID string
	}{
		{name: "accepted", phase: "ACCEPTED", returnedID: queueID},
		{name: "lost-reply", phase: "UNKNOWN"},
		{name: "malformed-queue-id", phase: "UNKNOWN", returnedID: "bogus"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			db, err := openTestFarmDB("sqlite", filepath.Join(t.TempDir(), "valves.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			_, err = db.ExecContext(ctx, `
				CREATE TABLE devices(deveui TEXT PRIMARY KEY, target_state TEXT);
				INSERT INTO devices(deveui) VALUES ('A840410000000001');
				CREATE TABLE irrigation_occurrences(device_eui TEXT, command_id TEXT, state TEXT,
					expires_at TEXT, reservation_end_at TEXT, decision_evidence_json TEXT);
				CREATE TABLE valve_actuation_expectations(expectation_id TEXT PRIMARY KEY, device_eui TEXT,
					zone_id INTEGER, command_id TEXT, commanded_at TEXT, commanded_duration_seconds INTEGER,
					expected_close_at TEXT, flow_rate_lpm REAL, flow_rate_source TEXT, estimated_gross_liters REAL,
					volume_source TEXT, created_at TEXT, transport_json TEXT, observed_open_at TEXT, observed_close_at TEXT,
					trigger TEXT);
				CREATE TABLE applied_commands(command_id TEXT PRIMARY KEY, device_eui TEXT, command_type TEXT,
					applied_at TEXT, result TEXT, result_detail TEXT, originator TEXT);
				CREATE TABLE actuator_log(deveui TEXT, action TEXT, duration_minutes INTEGER, reason TEXT,
					created_at TEXT, irrigation_zone_id INTEGER);
			`)
			if err != nil {
				t.Fatal(err)
			}
			readTransport := func(ctx context.Context) (string, error) {
				var transport string
				err := db.QueryRowContext(ctx, "SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?", commandID).Scan(&transport)
				return transport, err
			}
			var calls atomic.Int32
			radio := &testValveRadio{enqueue: func(ctx context.Context, request *api.EnqueueDeviceQueueItemRequest) (*api.EnqueueDeviceQueueItemResponse, error) {
				calls.Add(1)
				if header := metadata.ValueFromIncomingContext(ctx, "authorization"); len(header) != 1 || header[0] != "Bearer "+token {
					t.Error("enqueue did not carry the expected bearer metadata")
				}
				item := request.GetQueueItem()
				if item.GetDevEui() != eui || item.GetFPort() != 2 || item.GetExpiresAt() != nil ||
					request.GetFlushQueue() || !bytes.Equal(item.GetData(), []byte{0x41, 2}) {
					t.Errorf("unexpected ordinary enqueue item: %v", item)
				}
				raw, err := readTransport(ctx)
				if err != nil {
					t.Errorf("durable expectation at enqueue: %v", err)
					return nil, status.Error(codes.Internal, "could not read expectation")
				}
				record, err := valveStoredJSON(raw)
				if err != nil || record.Get("phase").ToString() != "ATTEMPTED" ||
					!record.Get("intent_at").Truthy() || !record.Get("attempted_at").Truthy() ||
					record.Get("effect_snapshot").Get("bytes_hex").ToString() != "4102" || record.Get("queue_id").Truthy() {
					t.Errorf("expected a committed attempt before enqueue, got %s (%v)", raw, err)
				}
				if test.returnedID == "" {
					return nil, status.Error(codes.DeadlineExceeded, "test response lost")
				}
				return &api.EnqueueDeviceQueueItemResponse{Id: test.returnedID}, nil
			}}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			server := grpc.NewServer()
			api.RegisterDeviceServiceServer(server, radio)
			done := make(chan error, 1)
			go func() {
				defer func() {
					if failure := recover(); failure != nil {
						done <- fmt.Errorf("test radio panic: %v", failure)
					}
				}()
				done <- server.Serve(listener)
			}()
			defer func() {
				server.Stop()
				if err := <-done; err != nil {
					t.Errorf("test radio: %v", err)
				}
			}()
			t.Setenv("CHIRPSTACK_API_URL", "http://"+listener.Addr().String())
			t.Setenv("CHIRPSTACK_API_KEY", token)
			t.Setenv("OSI_CHIRPSTACK_GRPC_DEADLINE_MS", "")

			b := &backend{db: db}
			got, id, err := b.dispatchValve(ctx, valveDevice{eui: eui}, commandID, valveOpen, 2, valveDispatchOptions{})
			if got != test.phase || (test.phase == "ACCEPTED" && (err != nil || id != queueID)) ||
				(test.phase == "UNKNOWN" && (err == nil || id != "")) || calls.Load() != 1 {
				t.Fatalf("enqueue outcome %q, id %q, err %v, calls %d", got, id, err, calls.Load())
			}
			raw, err := readTransport(ctx)
			if err != nil {
				t.Fatal(err)
			}
			record, err := valveStoredJSON(raw)
			if err != nil || record.Get("phase").ToString() != test.phase {
				t.Fatalf("durable outcome %s (%v)", raw, err)
			}
			if test.name == "malformed-queue-id" &&
				(record.Get("queue_id").Truthy() || record.Get("error").ToString() != "enqueue returned an invalid queue id") {
				t.Fatalf("malformed queue ID was treated as a receipt: %s", raw)
			}
			var logged int
			err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM actuator_log").Scan(&logged)
			if err != nil || (logged == 1) != (test.phase == "ACCEPTED") {
				t.Fatalf("actuator log count %d (%v)", logged, err)
			}
		})
	}
}

type testValveRadio struct {
	api.UnimplementedDeviceServiceServer
	enqueue func(context.Context, *api.EnqueueDeviceQueueItemRequest) (*api.EnqueueDeviceQueueItemResponse, error)
}

func (r *testValveRadio) Enqueue(ctx context.Context, request *api.EnqueueDeviceQueueItemRequest) (*api.EnqueueDeviceQueueItemResponse, error) {
	return r.enqueue(ctx, request)
}

// dispatch.js normalizeDevice: String(value).trim().toUpperCase() must match
// /^[0-9A-F]{16}$/; JavaScript trim also strips U+00A0 and U+FEFF.
func TestNormalizeValveDispatchEUI(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		valid    bool
	}{
		{"A840410000000001", "A840410000000001", true},
		{" a840410000000001\t", "A840410000000001", true},
		{"\u00a0a840410000000001\ufeff", "A840410000000001", true},
		{"NOTAHEXEUI000001", "NOTAHEXEUI000001", false},
		{"A84041000000000", "A84041000000000", false},
		{"A8404100000000011", "A8404100000000011", false},
		{"0840410000000G02", "0840410000000G02", false},
		{"", "", false},
	} {
		got, valid := normalizeValveDispatchEUI(tc.in)
		if got != tc.want || valid != tc.valid {
			t.Errorf("normalizeValveDispatchEUI(%q) = %q, %v; want %q, %v", tc.in, got, valid, tc.want, tc.valid)
		}
	}
}
