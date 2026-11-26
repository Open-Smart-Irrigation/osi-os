package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

var errStaleCredential = errors.New("stored password changed")

type loginVerdict struct {
	valid  bool
	claims jsvalue.Value
	fields []jsvalue.Field
}

// isBcrypt is osi-local-password-reset isBcryptValue: a string only, so a
// BLOB or number never takes the bcrypt path.
func isBcrypt(stored any) bool {
	text, ok := storedText(stored)
	return ok && strings.HasPrefix(text, "$2")
}

// localPasswordMatches is verifyLocalLogin's comparison: bcrypt for a bcrypt
// string, storedValueMatches (typeof stored === 'string') otherwise.
func localPasswordMatches(stored any, password jsvalue.Value) bool {
	text, ok := storedText(stored)
	if !ok || password.Kind != jsvalue.String {
		return false
	}
	if isBcrypt(stored) {
		return auth.ComparePassword(password, text)
	}
	expected := sha256.Sum256([]byte(text))
	actual := sha256.Sum256(password.UTF8(false))
	return subtle.ConstantTimeCompare(expected[:], actual[:]) == 1 && string(password.UTF8(true)) == text
}

func changeKey(id int64) string { return "local_password_change_required:" + strconv.FormatInt(id, 10) }

func (b *backend) verifyLocalLogin(ctx context.Context, user account, password, newPassword jsvalue.Value, canSignIn bool) loginVerdict {
	if !localPasswordMatches(user.passwordHash, password) {
		return loginVerdict{}
	}
	result := loginVerdict{valid: true}
	if !canSignIn {
		return result
	}
	bcryptStored, firstAccount := isBcrypt(user.passwordHash), user.id == 1
	if bcryptStored && !firstAccount {
		return result
	}

	required, known := firstAccount, firstAccount
	if bcryptStored {
		// osi-local-password-reset/index.js:256 and :288 also verify a
		// credential snapshot and read the change marker separately.
		var pending int
		err := b.db.QueryRowContext(ctx, "SELECT 1 FROM app_settings WHERE key=? LIMIT 1", changeKey(user.id)).Scan(&pending)
		switch {
		case err == nil:
			required, known = true, true
		case errors.Is(err, sql.ErrNoRows):
			required, known = false, false
		default:
			log.Printf("local sign-in: pending password change unavailable: %v", err)
			required, known = true, false
		}
	}
	now := timestamp()
	if required && newPassword.Kind != jsvalue.Undefined && newPassword.Kind != jsvalue.Null &&
		(newPassword.Kind != jsvalue.String || len(newPassword.Text) != 0) {
		code, text := newPasswordProblem(newPassword, password, user.passwordHash)
		if code != "" {
			result.fields = append(result.fields,
				jsvalue.Property("passwordChange", jsvalue.Str("rejected")),
				jsvalue.Property("passwordChangeError", jsvalue.Str(code)),
				jsvalue.Property("passwordChangeMessage", jsvalue.Str(text)),
			)
		} else {
			err := b.writePassword(ctx, user, newPassword, now, true, false)
			switch {
			case err == nil:
				result.fields = append(result.fields, jsvalue.Property("passwordChange", jsvalue.Str("changed")))
				return result
			case errors.Is(err, errStaleCredential):
				return loginVerdict{}
			default:
				log.Printf("local sign-in: new password write failed for user %d: %v", user.id, err)
				result.fields = append(result.fields, jsvalue.Property("passwordChange", jsvalue.Str("failed")))
			}
		}
	}
	if !bcryptStored {
		if len(password.UTF8(false)) > auth.MaxPasswordBytes {
			log.Printf("local sign-in: rehash skipped for user %d because password exceeds %d bytes", user.id, auth.MaxPasswordBytes)
		} else if err := b.writePassword(ctx, user, password, now, false, firstAccount); err != nil {
			if errors.Is(err, errStaleCredential) {
				if !b.currentPasswordMatches(ctx, user.id, password) {
					return loginVerdict{}
				}
			} else {
				log.Printf("local sign-in: rehash failed for user %d: %v", user.id, err)
			}
		}
	}
	if required {
		result.fields = append(result.fields, jsvalue.Property("passwordChangeRequired", jsvalue.Bool(true)))
	}
	if known {
		result.claims = jsvalue.Obj(jsvalue.Property("mustChangePassword", jsvalue.Bool(true)))
	}
	return result
}

func newPasswordProblem(candidate, password jsvalue.Value, stored any) (string, string) {
	if candidate.Kind != jsvalue.String || len(candidate.Text) < 6 {
		return "password_too_short", "Password must be at least 6 characters"
	}
	if len(candidate.UTF8(false)) > auth.MaxPasswordBytes {
		return "password_too_long", "Password must be at most 72 bytes"
	}
	if string(candidate.UTF8(true)) == string(password.UTF8(true)) ||
		isBcrypt(stored) && auth.ComparePassword(candidate, stored.(string)) {
		return "password_unchanged", "Choose a password that differs from the current one"
	}
	return "", ""
}

func (b *backend) currentPasswordMatches(ctx context.Context, id int64, password jsvalue.Value) bool {
	var stored, mode any
	err := b.db.QueryRowContext(ctx, "SELECT password_hash, auth_mode FROM users WHERE id=? LIMIT 1", id).Scan(&stored, &mode)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		log.Printf("local sign-in: account re-read failed for user %d: %v", id, err)
		return true
	}
	// currentValueAccepts: row.auth_mode === 'server' refuses.
	linked, _ := storedText(mode)
	return linked != "server" && localPasswordMatches(stored, password)
}

func (b *backend) writePassword(ctx context.Context, user account, password jsvalue.Value, now string, changed, markChange bool) error {
	hash, err := auth.NewPasswordHash(password)
	if err != nil {
		return err
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	query := "UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND auth_mode<>'server' AND password_hash=?"
	if changed {
		query = "UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE id=? AND auth_mode<>'server' AND password_hash=?"
	}
	write, err := tx.ExecContext(ctx, query, hash, now, user.id, user.passwordHash)
	if err != nil {
		return err
	}
	n, err := write.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errStaleCredential
	}
	if n != 1 {
		return fmt.Errorf("password update matched %d rows", n)
	}

	switch {
	case changed:
		_, err = tx.ExecContext(ctx, "DELETE FROM app_settings WHERE key=?", changeKey(user.id))
	case markChange:
		value, encodeErr := jsvalue.Stringify(jsvalue.Obj(jsvalue.Property("since", jsvalue.Str(now))))
		if encodeErr != nil {
			return encodeErr
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
			ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			changeKey(user.id), string(value), now)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
