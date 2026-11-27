package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"osi-edge/internal/jsvalue"
)

const sessionRefreshMarker = "/data/db/osi_session_refresh_v1"

// refreshSessionsOnce runs before HTTP can accept a token signed by the old
// key. Like osi-local-password-reset, it retries a failed check at the next boot.
func refreshSessionsOnce(parent context.Context, db *farmDB) {
	marker := imagePath(sessionRefreshMarker)
	if _, err := os.Stat(marker); err == nil {
		return
	}
	now := timestamp()
	ctx, cancel := context.WithTimeout(parent, time.Minute)
	defer cancel()
	if err := refreshSessionFiles(ctx, db, marker, now); err != nil {
		log.Printf("session refresh failed; it is tried again at the next start: %v", err)
	}
}

func refreshSessionFiles(ctx context.Context, db *farmDB, marker, now string) error {
	affected, err := sessionRefreshNeeded(ctx, db)
	if err != nil {
		return fmt.Errorf("check first-account password: %w", err)
	}

	status := "not_needed"
	if affected {
		path, _ := existingAuthSecret(authSecretPaths())
		switch {
		case configuredAuthSecret() != "":
			status = "configured_secret"
			log.Print("local sessions were not refreshed: the session secret is set in the environment")
		case path == "":
			status = "no_secret"
		default:
			if err := writePrivateFile(path, []byte(newAuthSecret()+"\n")); err != nil {
				return err
			}
			status = "rotated"
		}
	}
	record, err := jsvalue.Stringify(jsvalue.Obj(
		jsvalue.Property("version", jsvalue.Num(1)),
		jsvalue.Property("status", jsvalue.Str(status)),
		jsvalue.Property("at", jsvalue.Str(now)),
	))
	if err != nil {
		return err
	}
	if err := writePrivateFile(marker, append(record, '\n')); err != nil {
		return err
	}
	if status == "rotated" {
		log.Print("local sessions refreshed once after the sign-in update")
	}
	return nil
}

func sessionRefreshNeeded(ctx context.Context, db *farmDB) (bool, error) {
	var affected, settings bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=1
		AND COALESCE(auth_mode,'local')<>'server' AND COALESCE(substr(password_hash,1,2),'')<>'$2')`).Scan(&affected)
	if err != nil || affected {
		return affected, err
	}
	err = db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings')").Scan(&settings)
	if err != nil || !settings {
		return false, err
	}
	err = db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key=?)", changeKey(1)).Scan(&affected)
	return affected, err
}

func writePrivateFile(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, writeErr := temp.Write(data)
	closeErr := temp.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temp.Name(), path)
}
