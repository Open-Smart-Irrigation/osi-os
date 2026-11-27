package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chirpstack/chirpstack/api/go/v4/api"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"osi-edge/internal/jsvalue"
	"osi-edge/internal/procfence"
)

// radioFence admits every ChirpStack call through the process fence: after
// a fatal scheduler fault no new radio call starts (procfence). A call
// already sent completes.
func radioFence(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	procfence.Admit()
	return invoker(ctx, method, req, reply, cc, opts...)
}

type valveRadio struct {
	api.DeviceServiceClient
	conn *grpc.ClientConn
	key  string
}

// chirpstackClientConfig runs the checks of the osi-chirpstack-helper
// ChirpStackClient constructor (index.js:283-286), in its order, and returns
// the error it throws: normalizeApiUrl (an empty trimmed URL, then a URL
// new URL() refuses) and createMetadata (an empty trimmed key, then a key
// grpc-js refuses as a metadata value: anything outside printable ASCII).
// Node-RED callers that build the client eagerly (cancel-ingress, the
// encoder) fail with this message before their first write.
func chirpstackClientConfig() (*url.URL, string, error) {
	raw := jsvalue.Trim(os.Getenv("CHIRPSTACK_API_URL"))
	if raw == "" {
		return nil, "", errors.New("CHIRPSTACK_API_URL is required")
	}
	address := raw
	if !strings.Contains(address, "://") {
		address = "http://" + address
	}
	endpoint, err := url.Parse(address)
	if err != nil {
		return nil, "", errors.New("Invalid URL")
	}
	// new URL() also refuses a special scheme without a host. Go's
	// url.Parse is the approximation; hostile URL shapes are not probed.
	switch endpoint.Scheme { // url.Parse lower-cases the scheme
	case "http", "https", "ws", "wss", "ftp":
		if endpoint.Hostname() == "" {
			return nil, "", errors.New("Invalid URL")
		}
	}
	key := jsvalue.Trim(os.Getenv("CHIRPSTACK_API_KEY"))
	if key == "" {
		return nil, "", errors.New("CHIRPSTACK_API_KEY is required")
	}
	if strings.ContainsFunc(key, func(r rune) bool { return r < 0x20 || r > 0x7e }) {
		return nil, "", errors.New("CHIRPSTACK_API_KEY contains characters not allowed in gRPC metadata")
	}
	return endpoint, key, nil
}

func chirpstackClientConfigError() error {
	_, _, err := chirpstackClientConfig()
	return err
}

// errValveTransportUnavailable is push.js lazyTransport's rejection when its
// factory cannot build the ChirpStack client: Error(
// 'chirpstack_transport_unavailable') with code 'transport_unavailable'.
var errValveTransportUnavailable = errors.New("chirpstack_transport_unavailable")

var lazyRadioWarned sync.Once

// openValveRadioLazy is the radio of a Node-RED path that builds its client
// through push.js lazyTransport (the valve API, the one-time and clock
// ticks, the decommission sweep): a client that cannot be built does not
// throw; every call rejects with errValveTransportUnavailable, so the writes
// before the first call still happen. Warned once per process, as
// lazyTransport warns once per runtime.
func openValveRadioLazy() (*valveRadio, error) {
	err := chirpstackClientConfigError()
	if err == nil {
		return openValveRadio()
	}
	lazyRadioWarned.Do(func() {
		log.Printf("[valve-control] ChirpStack client unavailable; STREGA writes fail closed and plan snapshots stay pending: %v", err)
	})
	refuse := func(context.Context, string, any, any, *grpc.ClientConn, grpc.UnaryInvoker, ...grpc.CallOption) error {
		return errValveTransportUnavailable
	}
	conn, err := grpc.NewClient("passthrough:///chirpstack-unavailable",
		grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithChainUnaryInterceptor(radioFence, refuse))
	if err != nil {
		return nil, err
	}
	return &valveRadio{DeviceServiceClient: api.NewDeviceServiceClient(conn), conn: conn}, nil
}

func openValveRadio() (*valveRadio, error) {
	endpoint, key, err := chirpstackClientConfig()
	if err != nil {
		return nil, err
	}
	if endpoint.Hostname() == "" {
		// A non-special scheme with no host: the JS constructor accepts it
		// and the first call fails; Go refuses it here.
		return nil, errors.New("invalid CHIRPSTACK_API_URL")
	}
	port := endpoint.Port()
	creds := insecure.NewCredentials()
	if endpoint.Scheme == "https" {
		creds = credentials.NewTLS(&tls.Config{})
		if port == "" {
			port = "443"
		}
	} else if port == "" {
		port = "80"
	}
	conn, err := grpc.NewClient(net.JoinHostPort(endpoint.Hostname(), port), grpc.WithTransportCredentials(creds), grpc.WithDisableRetry(),
		grpc.WithUnaryInterceptor(radioFence))
	if err != nil {
		return nil, err
	}
	return &valveRadio{DeviceServiceClient: api.NewDeviceServiceClient(conn), conn: conn, key: key}, nil
}

func (radio *valveRadio) request(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+radio.key),
		time.Duration(valveRPCDeadlineMS()*float64(time.Millisecond)))
}

func valveRPCDeadlineMS() float64 {
	ms := jsvalue.Str(os.Getenv("OSI_CHIRPSTACK_GRPC_DEADLINE_MS")).MustNumber()
	if math.IsNaN(ms) || math.IsInf(ms, 0) || ms <= 0 {
		return 20000
	}
	return math.Min(ms, 120000)
}

type valveClockReceipt struct {
	bootID   string
	uptimeMS int64
}

func readValveReceipt() valveClockReceipt {
	boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
	uptime, uptimeErr := os.ReadFile("/proc/uptime")
	fields := strings.Fields(string(uptime))
	bootID := jsvalue.Trim(string(boot))
	if bootErr != nil || uptimeErr != nil || bootID == "" || len(fields) == 0 {
		return valveClockReceipt{}
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || seconds < 0 {
		return valveClockReceipt{}
	}
	return valveClockReceipt{bootID: bootID, uptimeMS: int64(seconds*1000 + 0.5)}
}

func (r valveClockReceipt) fields() []jsvalue.Field {
	if r.bootID == "" {
		return []jsvalue.Field{
			jsvalue.Property("boot_id", jsvalue.Nil()),
			jsvalue.Property("uptime_ms", jsvalue.Nil()),
		}
	}
	return []jsvalue.Field{
		jsvalue.Property("boot_id", jsvalue.Str(r.bootID)),
		jsvalue.Property("uptime_ms", jsvalue.Num(float64(r.uptimeMS))),
	}
}

type valveDispatchOptions struct {
	actor           string
	schedulerReason string
	scheduleID      string
	scheduleArg     any // the stored schedule_uuid the intent claim binds (a BLOB stays a BLOB)
	existingID      string
	fireAt          time.Time
	fireAtText      string
	// flow carries a calibration read the caller already made (the manual
	// route reads it before the encoder's checks, as write-strega-expectation).
	flow *valveFlow
}

// scheduleBind is the stored schedule_uuid the one-time intent claim binds
// (a BLOB stays a BLOB), or scheduleID when the caller has no stored value.
func (o valveDispatchOptions) scheduleBind() any {
	if o.scheduleArg != nil {
		return o.scheduleArg
	}
	return o.scheduleID
}

// valveFlow is the zone calibration write-strega-expectation reads for a
// timed open before the encoder runs.
type valveFlow struct {
	rate   sql.NullFloat64
	source sql.NullString
}

var valveQueueID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var valveDispatchEUI = regexp.MustCompile(`^[0-9A-F]{16}$`)
var errInvalidValveEUI = errors.New("invalid_device_eui")

// invalidValveEUIMessage is dispatch.js normalizeDevice's error message.
const invalidValveEUIMessage = "device_eui must be a 16-character hexadecimal EUI"

// normalizeValveDispatchEUI is osi-valve-control dispatch.js normalizeDevice:
// String(value).trim().toUpperCase() must be 16 hex digits. Every JS radio
// writer (executeValveAttempt, enqueueValveCommandWithRetry, withValveWriter,
// flushValveQueue) runs it before its first write.
func normalizeValveDispatchEUI(eui string) (string, bool) {
	eui = jsvalue.Upper(jsvalue.Trim(eui))
	return eui, valveDispatchEUI.MatchString(eui)
}

// refuseMissingActuators is the live-transport encoder's first check: with
// CHIRPSTACK_APP_ACTUATORS empty it answers 503 transport_unavailable before
// any dispatch write or radio call. It reports whether it answered.
func refuseMissingActuators(w http.ResponseWriter) bool {
	if jsvalue.Trim(os.Getenv("CHIRPSTACK_APP_ACTUATORS")) != "" {
		return false
	}
	respond(w, 503, jsvalue.Property("error", jsvalue.Str("transport_unavailable")),
		jsvalue.Property("message", jsvalue.Str("Missing CHIRPSTACK_APP_ACTUATORS; refusing STREGA downlink")))
	return true
}

// Dispatch owns the journal before sending and keeps the acceptance decision
// even when writing the radio receipt fails. The caller holds valveWriter.
func (b *backend) dispatchValve(ctx context.Context, valve valveDevice, commandID, action string, minutes int, options valveDispatchOptions) (phase, queueID string, err error) {
	var flowRate sql.NullFloat64
	var flowSource sql.NullString
	if action == valveOpen && options.scheduleID == "" {
		// write-strega-expectation reads the calibration before the encoder
		// checks the key and the conditional hold.
		flow := options.flow
		if flow == nil {
			if flow, err = b.valveFlowRate(ctx, valve); err != nil {
				return "write_failed", "", err
			}
		}
		flowRate, flowSource = flow.rate, flow.source
	}
	if options.scheduleID == "" {
		// The encoder (live-transport.js) builds the ChirpStack client
		// before executeValveAttempt, so a constructor throw comes before
		// normalizeDevice's hex check and the conditional hold, with phase
		// 'UNKNOWN' (the error has no code). A one-time open builds it
		// lazily at its first transport call instead.
		if err := chirpstackClientConfigError(); err != nil {
			return "UNKNOWN", "", err
		}
	}
	eui, valid := normalizeValveDispatchEUI(valve.eui)
	if !valid {
		return "invalid_device_eui", "", errInvalidValveEUI
	}
	valve.eui = eui
	expectationID := commandID
	port, frame := uint32(2), []byte{0x41, byte(minutes)}
	switch action {
	case valveClose:
		expectationID = uuid.NewString()
		port, frame = 1, []byte{0x30}
	case valveTimedClose:
		frame[0] = 0x40
	case valveOpen:
		busy, err := b.conditionalValveHold(ctx, valve, commandID, time.Now())
		if err != nil {
			return "write_failed", "", err
		}
		if busy {
			return "valve_busy", "", nil
		}
	default:
		return "unsupported_command", "", nil
	}
	// The encoder's client was validated above; a one-time open uses
	// runOnceTickLazy's lazy client, whose failure surfaces at the enqueue.
	radio, err := openValveRadioLazy()
	if err != nil {
		return "UNKNOWN", "", err
	}
	defer radio.conn.Close()

	if action == valveTimedClose {
		phase, queueID, err = b.dispatchValveOpaque(ctx, radio, valve.eui, commandID, port, frame)
		if phase == "ACCEPTED" {
			err = errors.Join(err, b.recordValveAcceptance(ctx, valve, commandID, action, minutes, ""))
		}
		return phase, queueID, err
	}

	now := time.Now()
	anchor := now
	commandedAt := valveISO(now)
	var trigger any
	if options.scheduleID != "" {
		// The expectation preserves a restored schedule's wire spelling.
		// Effect and duration arithmetic use its parsed instant.
		anchor, commandedAt, trigger = options.fireAt, options.fireAtText, "one_time"
		expectationID = uuid.NewString()
	}
	duration := time.Duration(minutes) * time.Minute
	var volume any
	volumeSource := "unknown"
	if flowRate.Valid {
		volume = flowRate.Float64 * float64(minutes)
		volumeSource = "estimated_duration_flow_rate"
	}
	transport := jsvalue.Obj(jsvalue.Property("effect_snapshot", valveEffectSnapshot(valve.eui, port, frame, anchor, duration)))
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return "write_failed", "", err
	}
	defer tx.Rollback()
	if options.scheduleID != "" {
		result, err := tx.ExecContext(ctx, `UPDATE valve_once_dispatch_intents SET state='ATTEMPTED',
			attempted_at=COALESCE(attempted_at, ?), updated_at=datetime('now') WHERE schedule_uuid=? AND state IN ('PENDING','UNKNOWN')`,
			valveISO(now), options.scheduleBind())
		if err != nil {
			return "write_failed", "", err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return "write_failed", "", errors.Join(err, errors.New("one-time intent was not claimed"))
		}
	}
	if options.existingID != "" {
		expectationID = options.existingID
		var raw sql.NullString
		err = tx.QueryRowContext(ctx, "SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=? AND command_id=? AND device_eui=?",
			expectationID, commandID, valve.eui).Scan(&raw)
		if err != nil {
			return "write_failed", "", err
		}
		transport, err = valveStoredJSON(raw.String)
		if err != nil || transport.Get("phase").Truthy() || transport.Get("attempted_at").Truthy() ||
			transport.Get("attempt_receipt").Truthy() || !valveOnceSnapshotMatches(transport, valve.eui, minutes) {
			return "write_failed", "", errors.Join(err, errors.New("one-time reservation no longer matches the frame"))
		}
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO valve_actuation_expectations(
		expectation_id, device_eui, zone_id, command_id, commanded_at,
		commanded_duration_seconds, expected_close_at, flow_rate_lpm, flow_rate_source,
		estimated_gross_liters, volume_source, created_at, transport_json, trigger)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			expectationID, valve.eui, zoneDouble(valve.zone), commandID, commandedAt,
			minutes*60, valveISO(anchor.Add(duration)), flowRate, flowSource,
			volume, volumeSource, valveISO(now), valveJSON(transport), trigger)
		if err != nil {
			return "write_failed", "", err
		}
	}
	if options.actor != "" && action == valveOpen {
		err = recordScopedValveIntent(ctx, tx, valve.eui, commandID, options.actor, now)
		if err != nil {
			return "write_failed", "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return "write_failed", "", err
	}

	if err := b.claimValveAttempt(ctx, expectationID, &transport); err != nil {
		return "write_failed", "", err
	}
	attemptedAt := transport.Get("attempted_at").MustString()
	phase, queueID, enqueueErr := radio.enqueueValveFrame(ctx, valve.eui, port, frame, &transport)
	_, err = b.db.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
		valveJSON(transport), expectationID)
	if phase == "ACCEPTED" && err != nil {
		b.retryValveAcceptance(ctx, valve.eui, expectationID, commandID, attemptedAt, queueID, transport.Get("accepted_at"))
	}
	if options.actor != "" && action == valveOpen {
		err = errors.Join(err, b.settleScopedValveIntent(ctx, commandID, phase, enqueueErr))
	}
	if phase == "ACCEPTED" && options.scheduleID == "" {
		if options.schedulerReason != "" {
			err = errors.Join(err, b.recordDailyValveAcceptance(ctx, valve, minutes, options.schedulerReason))
		} else {
			err = errors.Join(err, b.recordValveAcceptance(ctx, valve, commandID, action, minutes, options.actor))
		}
	}
	return phase, queueID, errors.Join(err, enqueueErr)
}

// Ordinary commands deliberately omit ExpiresAt. The stored effect cutoff is
// observation evidence and never a gateway-imposed radio queue expiry.
func (radio *valveRadio) enqueueValveFrame(ctx context.Context, eui string, port uint32, frame []byte, transport *jsvalue.Value) (phase, queueID string, err error) {
	callCtx, stop := radio.request(ctx)
	defer stop()
	reply, err := radio.Enqueue(callCtx, &api.EnqueueDeviceQueueItemRequest{
		QueueItem: &api.DeviceQueueItem{DevEui: eui, FPort: port, Data: frame},
	})
	at := jsvalue.Str(valveISO(time.Now()))
	queueID = reply.GetId()
	switch {
	case err == nil && valveQueueID.MatchString(jsvalue.Trim(queueID)):
		phase = "ACCEPTED"
		transport.Set(jsvalue.Property("queue_id", jsvalue.Str(queueID)))
		transport.Set(jsvalue.Property("accepted_at", at))
	case status.Code(err) == codes.InvalidArgument || status.Code(err) == codes.Unauthenticated:
		phase, queueID = "enqueue_rejected", ""
		transport.Set(jsvalue.Property("failure_code", jsvalue.Str(phase)))
		transport.Set(jsvalue.Property("failed_at", at))
	default:
		phase, queueID = "UNKNOWN", ""
		if err == nil {
			err = errors.New("enqueue returned an invalid queue id")
		}
		// osi-chirpstack-helper keeps error.details of a gRPC failure.
		err = valveRPCError{message: valveRPCMessage(err), cause: err}
		transport.Set(jsvalue.Property("error", jsvalue.Str(err.Error())))
		transport.Set(jsvalue.Property("unknown_at", at))
	}
	transport.Set(jsvalue.Property("phase", jsvalue.Str(phase)))
	return phase, queueID, err
}

// valveRPCError carries the gRPC details text as its message and keeps the
// status error reachable for status.Code.
type valveRPCError struct {
	message string
	cause   error
}

func (e valveRPCError) Error() string { return e.message }
func (e valveRPCError) Unwrap() error { return e.cause }

func valveAttemptAt(transport *jsvalue.Value, at time.Time, withReceipt bool) {
	stamp := jsvalue.Str(valveISO(at))
	transport.Set(jsvalue.Property("phase", jsvalue.Str("ATTEMPTED")))
	transport.Set(jsvalue.Property("intent_at", stamp))
	transport.Set(jsvalue.Property("attempted_at", stamp))
	transport.Set(jsvalue.Property("enqueue_timeout_ms", jsvalue.Num(valveRPCDeadlineMS())))
	if withReceipt {
		receipt := readValveReceipt()
		if receipt.bootID != "" {
			transport.Set(jsvalue.Property("attempt_receipt", jsvalue.Obj(receipt.fields()...)))
			transport.Set(jsvalue.Property("attempt_trusted_at", stamp))
		}
	}
}

func (b *backend) claimValveAttempt(ctx context.Context, id string, transport *jsvalue.Value) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now()
	transport.Set(jsvalue.Property("phase", jsvalue.Str("INTENT")))
	transport.Set(jsvalue.Property("intent_at", jsvalue.Str(valveISO(now))))
	_, err = tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
		valveJSON(*transport), id)
	if err != nil {
		return err
	}
	valveAttemptAt(transport, now, true)
	_, err = tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
		valveJSON(*transport), id)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (b *backend) retryValveAcceptance(ctx context.Context, eui, id, commandID, attemptedAt, queueID string, at jsvalue.Value) {
	ctx = context.WithoutCancel(ctx)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				log.Printf("valve acceptance recovery %s panic: %v\n%s", id, p, debug.Stack())
			}
		}()
		delay, permanentFailures := time.Second, 0
		for attempt := 0; attempt < 150; attempt++ {
			time.Sleep(delay)
			err := b.recoverValveAcceptance(ctx, eui, id, commandID, attemptedAt, queueID, at)
			if err == nil || errors.Is(err, sql.ErrConnDone) {
				return
			}
			if sqliteErr, ok := err.(interface{ Code() int }); !ok || sqliteErr.Code()&0xff != 5 {
				permanentFailures++
				log.Printf("valve acceptance recovery %s: %v", id, err)
				if permanentFailures == 5 {
					break
				}
			}
			delay = min(delay*2, 30*time.Second)
		}
		log.Printf("valve acceptance recovery required for %s queue %s", id, queueID)
	}()
}

func (b *backend) recoverValveAcceptance(ctx context.Context, eui, id, commandID, attemptedAt, queueID string, at jsvalue.Value) error {
	b.writes.RLock()
	defer b.writes.RUnlock()
	valveWriter.Lock()
	defer valveWriter.Unlock()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var raw sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT transport_json FROM valve_actuation_expectations
		WHERE expectation_id=? AND UPPER(device_eui)=? AND command_id=? AND reconciliation_state<>'CANCELLED'
		AND observed_open_at IS NULL AND observed_close_at IS NULL`, id, eui, commandID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	transport, err := valveStoredJSON(raw.String)
	if err != nil {
		return err
	}
	storedID := transport.Get("queue_id").OrEmpty().MustString()
	if transport.Get("attempted_at").MustString() != attemptedAt || transport.Get("invalidated_by_flush").Truthy() ||
		storedID != "" && storedID != queueID {
		return nil
	}
	if transport.Get("phase").MustString() == "ATTEMPTED" {
		transport.Set(jsvalue.Property("phase", jsvalue.Str("ACCEPTED")))
		transport.Set(jsvalue.Property("queue_id", jsvalue.Str(queueID)))
		transport.Set(jsvalue.Property("accepted_at", at))
		_, err = tx.ExecContext(ctx, "UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?",
			valveJSON(transport), id)
		if err != nil {
			return err
		}
	} else if transport.Get("phase").MustString() != "ACCEPTED" || storedID != queueID {
		return nil
	}
	_, err = tx.ExecContext(ctx, `UPDATE irrigation_occurrences SET state='SENT', queue_id=?, sent_at=?, updated_at=?
		WHERE command_id=? AND device_eui=? AND state='ATTEMPTED'`, queueID, at.MustString(), at.MustString(), commandID, eui)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// live-authorize loadZoneIrrigationCalibration treats only this message as
// "no calibration"; every other read error is rethrown.
var missingCalibrationTable = regexp.MustCompile(`(?i)no such table:\s*zone_irrigation_calibration\b`)

// valveFlowRate is write-strega-expectation's calibration read. A read error
// other than the missing table is a valvePreEncoderError.
func (b *backend) valveFlowRate(ctx context.Context, valve valveDevice) (*valveFlow, error) {
	var rate sql.NullFloat64
	var source sql.NullString
	if valve.zone.Valid {
		err := b.db.QueryRowContext(ctx, `SELECT measured_flow_rate_lpm, measurement_method
			FROM zone_irrigation_calibration WHERE zone_id=?`, zoneDouble(valve.zone)).Scan(&rate, &source)
		if err != nil && !errors.Is(err, sql.ErrNoRows) && !missingCalibrationTable.MatchString(zoneDBMessage(err)) {
			return nil, valvePreEncoderError{err}
		}
		if rate.Valid && rate.Float64 > 0 {
			if source.String == "" {
				source = sql.NullString{String: "calibrated", Valid: true}
			}
			return &valveFlow{rate, source}, nil
		}
	}
	return &valveFlow{source: sql.NullString{String: "none", Valid: true}}, nil
}

func valveEffectSnapshot(eui string, port uint32, frame []byte, anchor time.Time, duration time.Duration) jsvalue.Value {
	cutoff := jsvalue.Str(valveISO(anchor.Add(31 * time.Minute)))
	end := jsvalue.Str(valveISO(anchor.Add(31*time.Minute + duration)))
	provenance := jsvalue.Obj(jsvalue.Property("source", jsvalue.Str("local_encoder")))
	class, seconds := "CLOSE_ONLY", jsvalue.Nil()
	if duration > 0 {
		provenance.Set(jsvalue.Property("encoder", jsvalue.Str("strega-v1")))
		class, seconds = "SELF_CLOSING_OPEN", jsvalue.Num(duration.Seconds())
	}
	return jsvalue.Obj(
		jsvalue.Property("version", jsvalue.Num(1)),
		jsvalue.Property("fPort", jsvalue.Num(float64(port))),
		jsvalue.Property("data", jsvalue.Str(base64.StdEncoding.EncodeToString(frame))),
		jsvalue.Property("bytes_hex", jsvalue.Str(jsvalue.Upper(hex.EncodeToString(frame)))),
		jsvalue.Property("confirmed", jsvalue.Bool(false)),
		jsvalue.Property("encrypted", jsvalue.Bool(false)),
		jsvalue.Property("provenance", provenance),
		jsvalue.Property("encoded_duration_seconds", seconds),
		jsvalue.Property("effect_class", jsvalue.Str(class)),
		jsvalue.Property("snapshot_version", jsvalue.Num(1)),
		jsvalue.Property("anchor_at", jsvalue.Str(valveISO(anchor))),
		jsvalue.Property("device_eui", jsvalue.Str(eui)),
		jsvalue.Property("interval_minutes", jsvalue.Num(10)),
		jsvalue.Property("interval_source", jsvalue.Str("documented_default")),
		jsvalue.Property("allowance_minutes", jsvalue.Num(31)),
		jsvalue.Property("latest_physical_start_at", cutoff),
		jsvalue.Property("calculated_queue_expires_at", cutoff),
		jsvalue.Property("explicit_expiry_at", jsvalue.Nil()),
		jsvalue.Property("queue_expires_at", cutoff),
		jsvalue.Property("future_effect_end", end),
		jsvalue.Property("exclusion_end_at", end),
		jsvalue.Property("minimum_gap_minutes", jsvalue.Num(0)),
		jsvalue.Property("qualification", jsvalue.Obj(
			jsvalue.Property("qualified", jsvalue.Bool(false)),
			jsvalue.Property("identity", jsvalue.Nil()),
			jsvalue.Property("margin_seconds", jsvalue.Nil()),
			jsvalue.Property("reason", jsvalue.Str("qualification_unavailable")),
		)),
		jsvalue.Property("qualification_context", jsvalue.Obj(
			jsvalue.Property("device_eui", jsvalue.Str(eui)),
			jsvalue.Property("identity", jsvalue.Nil()),
		)),
		jsvalue.Property("reservation_end_at", end),
		jsvalue.Property("expires_at", cutoff),
	)
}

func (b *backend) recordValveAcceptance(ctx context.Context, valve valveDevice, commandID, action string, minutes int, actor string) error {
	target := "OPEN"
	var loggedMinutes any = minutes
	if action == valveClose {
		target, loggedMinutes = "CLOSED", nil
	}
	if action == valveTimedClose {
		target = "CLOSED"
	}
	_, targetErr := b.db.ExecContext(ctx, "UPDATE devices SET target_state=? WHERE UPPER(deveui)=?", target, valve.eui)

	// The live encoder labels manual opens and closes as interval ACKs.
	const commandType = "SET_STREGA_INTERVAL"
	at := valveISO(time.Now())
	detail := jsvalue.Obj(
		jsvalue.Property("commandId", jsvalue.Str(commandID)),
		jsvalue.Property("eventUuid", jsvalue.Nil()),
		jsvalue.Property("aggregateType", jsvalue.Nil()),
		jsvalue.Property("aggregateKey", jsvalue.Nil()),
		jsvalue.Property("commandType", jsvalue.Str(commandType)),
		jsvalue.Property("status", jsvalue.Str("ACKED")),
		jsvalue.Property("result", jsvalue.Str("APPLIED")),
		jsvalue.Property("appliedAt", jsvalue.Str(at)),
		jsvalue.Property("requestedSyncVersion", jsvalue.Nil()),
		jsvalue.Property("appliedSyncVersion", jsvalue.Nil()),
		jsvalue.Property("duplicate", jsvalue.Bool(false)),
		jsvalue.Property("reason", jsvalue.Nil()),
		jsvalue.Property("detail", jsvalue.Nil()),
	)
	_, auditErr := b.db.ExecContext(ctx, `INSERT INTO actuator_log(deveui, action, duration_minutes, reason, created_at, irrigation_zone_id)
		VALUES (?, ?, ?, 'manual_gui', ?, ?)`, valve.eui, action, loggedMinutes, at, actuatorLogZone(valve.zone))
	var ledgerErr error
	if actor == "" || action != valveOpen {
		_, ledgerErr = b.db.ExecContext(ctx, `INSERT INTO applied_commands
			(command_id, device_eui, command_type, applied_at, result, result_detail, originator)
			VALUES (?, ?, ?, ?, 'APPLIED', ?, 'edge') ON CONFLICT(command_id) DO NOTHING`,
			commandID, valve.eui, commandType, at, valveJSON(detail))
	}
	if auditErr != nil {
		auditErr = valveAuditError{auditErr}
	}
	return errors.Join(targetErr, auditErr, ledgerErr)
}

// valveAuditError marks a failed actuator_log insert. In the flows the status
// message and the second command_ack ("Build Status + ACK") run only after the
// sqlite node "DB: insert actuator_log" succeeded, so the caller publishes
// them only without this error.
type valveAuditError struct{ err error }

func (e valveAuditError) Error() string { return e.err.Error() }
func (e valveAuditError) Unwrap() error { return e.err }

// valvePreEncoderError marks a failure the flows raise in
// write-strega-expectation, before the encoder runs executeValveAttempt (the
// calibration read). Its catch answers HTTP 503 with error.code and the
// message, and an HTTP request gets no command_ack.
type valvePreEncoderError struct{ err error }

func (e valvePreEncoderError) Error() string { return e.err.Error() }
func (e valvePreEncoderError) Unwrap() error { return e.err }

func recordScopedValveIntent(ctx context.Context, tx *farmTx, eui, id, actor string, now time.Time) error {
	detail := jsvalue.Obj(
		jsvalue.Property("commandId", jsvalue.Str(id)),
		jsvalue.Property("commandType", jsvalue.Str(valveOpen)),
		jsvalue.Property("status", jsvalue.Str("PENDING")),
		jsvalue.Property("result", jsvalue.Str("IN_PROGRESS")),
		jsvalue.Property("duplicate", jsvalue.Bool(false)),
		jsvalue.Property("reason", jsvalue.Str("transport_pending")),
	)
	_, err := tx.ExecContext(ctx, `INSERT INTO applied_commands(command_id,device_eui,command_type,applied_at,result,result_detail,originator)
		VALUES (?,?,?,?,'IN_PROGRESS',?,?) ON CONFLICT(command_id) DO UPDATE SET originator=excluded.originator`,
		id, eui, valveOpen, valveISO(now), valveJSON(detail), actor)
	return err
}

// settleScopedValveFault is the encoder's ledger update for a scoped open
// whose local write failed inside the encoder after the reservation committed
// the IN_PROGRESS row: result UNKNOWN, transportPhase the error code and error
// its message. Without a row (the reservation rolled back) nothing changes.
func (b *backend) settleScopedValveFault(ctx context.Context, id, phase, message string) {
	err := b.settleScopedValveIntent(ctx, id, phase, errors.New(message))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		log.Printf("STREGA command %s scoped ledger settle: %v", id, err)
	}
}

func (b *backend) settleScopedValveIntent(ctx context.Context, id, phase string, problem error) error {
	var encoded sql.NullString
	err := b.db.QueryRowContext(ctx, "SELECT result_detail FROM applied_commands WHERE command_id=?", id).Scan(&encoded)
	if err != nil {
		return err
	}
	detail, err := valveStoredJSON(encoded.String)
	if err != nil {
		return err
	}
	result, state := "UNKNOWN", "UNKNOWN"
	switch phase {
	case "ACCEPTED":
		result, state = "APPLIED", "ACKED"
	case "enqueue_rejected", "enqueue_failed_before_acceptance":
		result, state = "REJECTED_PERMANENT", "NACKED"
	}
	problemValue := jsvalue.Nil()
	var lastError any
	if problem != nil {
		problemValue, lastError = jsvalue.Str(problem.Error()), problem.Error()
	}
	detail.Set(jsvalue.Property("result", jsvalue.Str(result)))
	detail.Set(jsvalue.Property("status", jsvalue.Str(state)))
	detail.Set(jsvalue.Property("transportPhase", jsvalue.Str(phase)))
	detail.Set(jsvalue.Property("error", problemValue))
	_, err = b.db.ExecContext(ctx, "UPDATE applied_commands SET result=?, result_detail=?, last_error=? WHERE command_id=?",
		result, valveJSON(detail), lastError, id)
	return err
}
