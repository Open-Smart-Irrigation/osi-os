package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// Review confirm-A N1: routes.js authorizeAfterWriters repeats
// assertFreshRole, canMutate and assertFreshZoneAccess inside the lifecycle
// writer in scoped mode. A role, account or grant change that lands after
// dailyScheduleScope must refuse the write; the harness cannot interleave a
// request between the two checks, so this calls the writer-side check on the
// state such a change leaves.
func TestAuthorizeLegacyScheduleWriteRechecksScope(t *testing.T) {
	ctx := context.Background()
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`
		INSERT INTO users(id,username,password_hash,created_at,user_uuid,role) VALUES
			(1,'farmer','x','2026-11-23T06:00:00.000Z','aaaaaaaa-0000-4000-8000-000000000001','admin'),
			(2,'other','x','2026-11-23T06:00:00.000Z','aaaaaaaa-0000-4000-8000-000000000002','admin');
		INSERT INTO irrigation_zones(id,name,user_id,zone_uuid) VALUES
			(1,'Owned',1,'bbbbbbbb-0000-4000-8000-000000000001'),
			(2,'Foreign',2,'bbbbbbbb-0000-4000-8000-000000000002');`)
	if err != nil {
		t.Fatal(err)
	}
	check := func(zone float64, scoped bool) error {
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		return authorizeLegacyScheduleWrite(ctx, conn, 1, " farmer ", zone, scoped)
	}
	refusal := func(err error) string {
		var r *scheduleError
		if !errors.As(err, &r) {
			return fmt.Sprintf("not a refusal: %v", err)
		}
		return fmt.Sprintf("%s %s %d", r.code, r.message, r.status)
	}
	if err := check(1, true); err != nil {
		t.Fatalf("owned zone, admin: %v", err)
	}
	if got, want := refusal(check(2, true)), "lifecycle_error zone not found 404"; got != want {
		t.Errorf("foreign zone, scoped: got %q, want %q", got, want)
	}
	exec := func(statement string) {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at,updated_at)
		VALUES ('cccccccc-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000002','2026-11-23T06:00:00.000Z','2026-11-23T06:00:00.000Z')`)
	if err := check(2, true); err != nil {
		t.Fatalf("granted zone: %v", err)
	}
	exec(`UPDATE user_zone_assignments SET deleted_at='2026-11-23T07:00:00.000Z'`)
	if got, want := refusal(check(2, true)), "lifecycle_error zone not found 404"; got != want {
		t.Errorf("grant revoked: got %q, want %q", got, want)
	}
	exec(`UPDATE users SET role='viewer' WHERE id=1`)
	if got, want := refusal(check(1, true)), "lifecycle_error insufficient role 403"; got != want {
		t.Errorf("role lowered: got %q, want %q", got, want)
	}
	if err := check(1, false); err != nil {
		t.Errorf("role lowered, legacy mode checks ownership only: %v", err)
	}
	exec(`UPDATE users SET role='admin', disabled_at='2026-11-23T07:00:00.000Z' WHERE id=1`)
	if got, want := refusal(check(1, true)), "lifecycle_error account disabled 403"; got != want {
		t.Errorf("account disabled: got %q, want %q", got, want)
	}
}
