package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"strings"
	"time"

	"google.golang.org/grpc/status"

	"osi-edge/internal/jsvalue"
)

// The cloud broker messages of a manual STREGA command (flows.json
// "Build STREGA downlink + emit log ctx", "Build Status + ACK", "Queue REST
// Command ACK"). Each ACK goes through osi-command-ledger queueCommandAck,
// whose return value is what the broker receives; the status message is
// built after the actuator_log write. Both leave through the account-recovery
// gate, which cloudmqtt.Client.Publish applies.

const valveBusyMessage = "valve has an active or unresolved command"

// valveGatewayTopicEUI is the flows' String(env.get('DEVICE_EUI') ||
// 'UNKNOWN').trim().toUpperCase(): only an empty value falls back, and a
// whitespace-only one trims to "" (topic devices//...).
func valveGatewayTopicEUI() string {
	raw := os.Getenv("DEVICE_EUI")
	if raw == "" {
		return "UNKNOWN"
	}
	return jsvalue.Upper(jsvalue.Trim(raw))
}

// publishManualValveOutcome publishes what Node-RED publishes once the
// encoder has run executeValveAttempt for a manual command. For an accepted,
// non-replayed frame: the ledger ACK (encoder output 3), then the status and
// the ledger ACK again ("Build Status + ACK"), which the flows reach only
// after the actuator_log insert succeeded (audited). For any other phase one
// FAILED ACK whose detail is the encoder's transportResult.error.message.
// Refusals before the encoder (missing actuators app, scope, the calibration
// read) publish nothing and never reach here.
func (b *backend) publishManualValveOutcome(ctx context.Context, valve valveDevice, commandID, action, phase, failureDetail string, audited bool) {
	gateway := valveGatewayTopicEUI()
	ackTopic := "devices/" + gateway + "/command_ack"
	type message struct {
		topic   string
		payload []byte
	}
	var sequence []message
	publish := func(topic string, payload jsvalue.Value) {
		sequence = append(sequence, message{topic, []byte(valveJSON(payload))})
	}
	// Node-RED emits each message from its own flow path after a database
	// step, so each reaches the broker after the previous PUBACK and after the
	// HTTP answer. The sequence runs in the background, one PUBACK apart.
	defer func() {
		if len(sequence) == 0 || b.cloud == nil {
			return
		}
		b.cloudSequences.Add(1)
		go func() {
			defer b.cloudSequences.Done()
			for _, m := range sequence {
				sendCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := b.cloud.PublishAwait(sendCtx, m.topic, m.payload)
				cancel()
				if err != nil {
					log.Printf("STREGA command %s cloud publish %s: %v", commandID, m.topic, err)
				}
			}
		}()
	}()
	if phase != "ACCEPTED" {
		ack, err := b.queueManualValveFailure(ctx, valve, commandID, failureDetail)
		if err != nil {
			log.Printf("STREGA command %s failure ACK: %v", commandID, err)
			return
		}
		publish(ackTopic, ack)
		return
	}
	ack, found, err := b.replayValveLedgerAck(ctx, commandID)
	if err != nil || !found {
		log.Printf("STREGA command %s ledger ACK unavailable: found=%v err=%v", commandID, found, err)
	}
	if found {
		publish(ackTopic, ack)
	}
	if !audited {
		return
	}
	state := "CLOSED"
	if action == valveOpen {
		state = "OPEN"
	}
	p := jsvalue.Property
	statusMessage := jsvalue.Obj(p("deviceEui", jsvalue.Str(valve.eui)), p("gatewayDeviceEui", jsvalue.Str(gateway)),
		p("state", jsvalue.Str(state)), p("timestamp", jsvalue.Str(valveISO(time.Now()))))
	publish("devices/"+gateway+"/status", statusMessage)
	if found {
		publish(ackTopic, ack)
	}
}

// replayValveLedgerAck is osi-command-ledger replayAck(row, commandId, true)
// for the command's applied_commands row: the stored result_detail as it is
// when it is a complete terminal ACK, else the facts with the replay fields.
func (b *backend) replayValveLedgerAck(ctx context.Context, commandID string) (jsvalue.Value, bool, error) {
	var detail, commandType, effectKey, appliedAt, result sql.NullString
	err := b.db.QueryRowContext(ctx, `SELECT result_detail,command_type,effect_key,applied_at,result
		FROM applied_commands WHERE command_id=? LIMIT 1`, commandID).Scan(&detail, &commandType, &effectKey, &appliedAt, &result)
	if errors.Is(err, sql.ErrNoRows) {
		return jsvalue.Value{}, false, nil
	}
	if err != nil {
		return jsvalue.Value{}, false, err
	}
	p := jsvalue.Property
	facts := jsvalue.Obj()
	if detail.Valid && detail.String != "" {
		parsed, parseErr := jsvalue.Parse([]byte(detail.String))
		switch {
		case parseErr != nil:
			facts = jsvalue.Obj(p("storedResultDetail", jsvalue.Str(detail.String)))
		case parsed.Kind == jsvalue.Object:
			facts = parsed
		default:
			facts = jsvalue.Obj(p("storedResultDetail", parsed))
		}
	}
	has := func(key string) bool { return facts.Get(key).Kind != jsvalue.Undefined }
	if has("commandId") && has("status") && has("result") && has("duplicate") {
		return facts, true, nil
	}
	text := func(v sql.NullString) jsvalue.Value {
		if !v.Valid {
			return jsvalue.Nil()
		}
		return jsvalue.Str(v.String)
	}
	ack := facts
	ack.Set(p("commandId", jsvalue.Str(commandID)))
	if !facts.Get("commandType").Truthy() {
		ack.Set(p("commandType", text(commandType)))
	}
	if k := facts.Get("effectKey"); k.Kind == jsvalue.Undefined || k.Kind == jsvalue.Null {
		ack.Set(p("effectKey", text(effectKey)))
	}
	if !facts.Get("appliedAt").Truthy() {
		ack.Set(p("appliedAt", text(appliedAt)))
	}
	ack.Set(p("status", jsvalue.Str(ledgerReplayStatus(result.String))))
	ack.Set(p("result", text(result)))
	ack.Set(p("duplicate", jsvalue.Bool(true)))
	return ack, true, nil
}

func ledgerReplayStatus(result string) string {
	switch result {
	case "APPLIED":
		return "ACKED"
	case "CONFLICT", "FAILED_RETRYABLE", "UNKNOWN":
		return result
	}
	return "NACKED"
}

// queueManualValveFailure is queueCommandAck for the encoder's
// ack('FAILED', detail): classifyAckResult turns it into REJECTED_PERMANENT
// when the detail names an invalid, unsupported or missing device, which is
// terminal and lands in the ledger (or replays the row already there);
// otherwise FAILED_RETRYABLE, which a local command id never stores.
func (b *backend) queueManualValveFailure(ctx context.Context, valve valveDevice, commandID, detail string) (jsvalue.Value, error) {
	lower := jsvalue.Lower(detail)
	result := "FAILED_RETRYABLE"
	if strings.Contains(lower, "invalid") || strings.Contains(lower, "unsupported") ||
		strings.Contains(lower, "missing valve deveui") || strings.Contains(lower, "missing sensor deveui") {
		result = "REJECTED_PERMANENT"
	}
	const commandType = "SET_STREGA_INTERVAL"
	at := valveISO(time.Now())
	p := jsvalue.Property
	initial := jsvalue.Obj(
		p("commandId", jsvalue.Str(commandID)),
		p("eventUuid", jsvalue.Nil()),
		p("aggregateType", jsvalue.Nil()),
		p("aggregateKey", jsvalue.Nil()),
		p("commandType", jsvalue.Str(commandType)),
		p("status", jsvalue.Str(ledgerReplayStatus(result))),
		p("result", jsvalue.Str(result)),
		p("appliedAt", jsvalue.Str(at)),
		p("requestedSyncVersion", jsvalue.Nil()),
		p("appliedSyncVersion", jsvalue.Nil()),
		p("duplicate", jsvalue.Bool(false)),
		p("reason", jsvalue.Str(detail)),
		p("detail", jsvalue.Str(detail)),
	)
	if result != "REJECTED_PERMANENT" {
		return initial, nil
	}
	if existing, found, err := b.replayValveLedgerAck(ctx, commandID); err != nil || found {
		return existing, err
	}
	device := jsvalue.Upper(jsvalue.Trim(valve.eui))
	if device == "" {
		device = "UNKNOWN"
	}
	_, err := b.db.ExecContext(ctx, `INSERT INTO applied_commands
		(command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator)
		VALUES (?,NULL,?,?,?,?,?,'edge') ON CONFLICT(command_id) DO NOTHING`,
		commandID, device, commandType, result, at, valveJSON(initial))
	return initial, err
}

// manualValveFailureDetail is the live-transport encoder's detail:
// transportResult.error.message, else the generic sentence.
func manualValveFailureDetail(phase string, err error) string {
	switch phase {
	case "invalid_device_eui":
		return invalidValveEUIMessage
	case "valve_busy":
		return valveBusyMessage
	}
	if err != nil {
		return valveRPCMessage(err)
	}
	return "STREGA transport did not accept the command"
}

// valveEncoderFault is the encoder's outcome for a local write failure inside
// executeValveAttempt or enqueueValveCommand. Its catch sets phase
// error.code || 'UNKNOWN', a node-sqlite3 code for a database error, and the
// FAILED command_ack carries error.message, node-sqlite3's "SQLITE_CODE: text".
func valveEncoderFault(err error) (phase, detail string) {
	var coded valveCodedError
	if errors.As(err, &coded) {
		return coded.code, coded.message
	}
	detail = zoneDBMessage(err)
	if phase = jsErrorCode(detail); phase == "write_failed" {
		phase = "UNKNOWN"
	}
	return phase, detail
}

// valveRPCMessage is what osi-chirpstack-helper toGrpcError keeps of a gRPC
// failure, error.details: the status message without grpc-go's prefix.
func valveRPCMessage(err error) string {
	var rpc interface{ GRPCStatus() *status.Status }
	if errors.As(err, &rpc) {
		return rpc.GRPCStatus().Message()
	}
	return err.Error()
}
