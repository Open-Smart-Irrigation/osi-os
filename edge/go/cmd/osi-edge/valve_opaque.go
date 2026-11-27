package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"osi-edge/internal/jsvalue"
)

func loadValveControl(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *farmRow
}, eui string) (jsvalue.Value, error) {
	var raw sql.NullString
	err := q.QueryRowContext(ctx, "SELECT conditional_control_json FROM valve_settings WHERE device_eui=?", eui).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return jsvalue.Value{}, err
	}
	return valveStoredJSON(raw.String)
}

func writeValveControl(ctx context.Context, tx *farmTx, eui string, control jsvalue.Value) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)
		ON CONFLICT(device_eui) DO UPDATE SET conditional_control_json=excluded.conditional_control_json`, eui, valveJSON(control))
	return err
}

func (b *backend) dispatchValveOpaque(ctx context.Context, radio *valveRadio, eui, owner string, port uint32, frame []byte) (string, string, error) {
	data := jsvalue.Str(base64.StdEncoding.EncodeToString(frame))
	entry := jsvalue.Obj(
		jsvalue.Property("owner_id", jsvalue.Str(owner)),
		jsvalue.Property("queue_id", jsvalue.Nil()),
		jsvalue.Property("device_eui", jsvalue.Str(eui)),
		jsvalue.Property("original_payload", data),
		jsvalue.Property("payload", data),
		jsvalue.Property("data", data),
		jsvalue.Property("fPort", jsvalue.Num(float64(port))),
		jsvalue.Property("confirmed", jsvalue.Bool(false)),
		jsvalue.Property("encrypted", jsvalue.Bool(false)),
		jsvalue.Property("provenance", jsvalue.Obj(jsvalue.Property("source", jsvalue.Str("local_encoder")))),
		jsvalue.Property("expiresAt", jsvalue.Nil()),
	)
	valveAttemptAt(&entry, time.Now(), false)
	if err := b.storeOpaqueValveAttempt(ctx, eui, owner, entry); err != nil {
		return "write_failed", "", err
	}
	phase, queue, err := radio.enqueueValveFrame(ctx, eui, port, frame, &entry)
	return phase, queue, errors.Join(err, b.storeOpaqueValveAttempt(ctx, eui, owner, entry))
}

func (b *backend) storeOpaqueValveAttempt(ctx context.Context, eui, id string, entry jsvalue.Value) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	control, err := loadValveControl(ctx, tx, eui)
	if err != nil {
		return err
	}
	owners := control.Get("opaque").List
	index := len(owners)
	for i, owner := range owners {
		if owner.Get("owner_id").MustString() == id {
			index = i
			break
		}
	}
	if index == len(owners) {
		owners = append(owners, entry)
	} else {
		owners[index] = entry
	}
	control.Set(jsvalue.Property("opaque", jsvalue.Arr(owners...)))
	if err := writeValveControl(ctx, tx, eui, control); err != nil {
		return err
	}
	return tx.Commit()
}
