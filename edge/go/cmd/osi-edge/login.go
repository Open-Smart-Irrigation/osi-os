package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsdate"
	"osi-edge/internal/jsvalue"
)

const invalidCredentials = "Invalid username or password"

func init() {
	registerWithCatch("POST", "/auth/register", (*backend).authRoute, authCoercionCatch)
	registerWithCatch("POST", "/auth/login", (*backend).authRoute, authCoercionCatch)
}

func (b *backend) authRoute(w http.ResponseWriter, r *http.Request, _ params, body httpbody.Body) {
	b.writes.RLock()
	defer b.writes.RUnlock()
	if strings.EqualFold(strings.TrimSuffix(r.URL.Path, "/"), "/auth/register") {
		b.register(w, r, body.Value)
	} else {
		b.login(w, r, body.Value)
	}
}

func timestamp() string { return jsdate.ISOString(time.Now()) }

func (b *backend) register(w http.ResponseWriter, r *http.Request, body jsvalue.Value) {
	// auth-register-func: String(username || '').trim() runs first and can throw.
	username := body.Get("username").OrEmpty().TrimmedString().MustString()
	password := body.Get("password")
	if username == "" || !password.Truthy() {
		message(w, 400, "Username and password are required")
		return
	}
	length := password.Get("length").MustNumber()
	switch password.Kind {
	case jsvalue.String:
		length = float64(len(password.Text))
	case jsvalue.Array:
		length = float64(len(password.List))
	}
	if length < 6 {
		message(w, 400, "Password must be at least 6 characters")
		return
	}
	ctx := r.Context()
	var existing int
	err := b.db.QueryRowContext(ctx, "SELECT 1 FROM users WHERE username = ?", username).Scan(&existing)
	if err == nil {
		message(w, 400, "Username already exists")
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		databaseError(w, "Unable to query local users", err)
		return
	}

	now := timestamp()
	hash, err := auth.NewPasswordHash(password)
	if err != nil {
		log.Printf("registration password hash failed")
		message(w, 500, "Authentication request failed")
		return
	}
	scoped := scopedAccess()
	insert := "INSERT INTO users (username, password_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)"
	closed := "Registration is closed: this gateway already has an account. Sign in with an existing account."
	if scoped {
		insert = "INSERT INTO users (username, password_hash, created_at, role) SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)"
		closed = "Public registration is closed. Ask an administrator to create your account, or contact the gateway operator for account recovery."
	}
	written, err := b.db.ExecContext(ctx, insert, username, hash, now)
	if err != nil {
		databaseError(w, "Unable to create local user", err)
		return
	}
	count, err := written.RowsAffected()
	if err != nil {
		databaseError(w, "Unable to create local user", err)
		return
	}
	if count == 0 {
		message(w, 403, closed)
		return
	}
	respond(w, 201, jsvalue.Property("success", jsvalue.Bool(true)))
}

type account struct {
	id       int64
	username string
	// Credential, mode and disabled columns keep their storage class: the
	// shipped code tests typeof and truthiness on what node-sqlite3 returns.
	passwordHash, mode, disabledAt, serverPasswordHash, offlineVerifier any
	// String(v || '') and Number(v || 1) read these: a Buffer decodes as
	// UTF-8 with replacement, and a number keeps its value.
	serverUsername, syncToken, verifierVersion, installationUUID storedValue
}

// verifierVersionNumber is Number(user.server_offline_verifier_version || 1).
func (a account) verifierVersionNumber() float64 {
	if !a.verifierVersion.truthy() {
		return 1
	}
	return a.verifierVersion.number()
}

// linkedMode is flows.json auth-process-result:176,
// (user.auth_mode || 'local') === 'server': only the TEXT value 'server'.
func (a account) linkedMode() bool {
	mode, _ := storedText(a.mode)
	return mode == "server"
}

func (b *backend) login(w http.ResponseWriter, r *http.Request, body jsvalue.Value) {
	name := body.Get("username")
	password := body.Get("password")
	if !name.Truthy() || !password.Truthy() {
		message(w, 400, "Username and password are required")
		return
	}
	// auth-login-func: String(username).trim() after the presence check can throw.
	username := name.TrimmedString().MustString()
	if username == "" {
		message(w, 400, "Username is required")
		return
	}
	ctx := r.Context()
	matches, err := b.matchingAccounts(ctx, username)
	if err != nil {
		databaseError(w, "Unable to query local users", err)
		return
	}
	if len(matches) == 0 {
		message(w, 401, invalidCredentials)
		return
	}
	if len(matches) > 1 {
		message(w, 409, "Multiple accounts match this username. Please contact support.")
		return
	}

	user := matches[0]
	blocked := scopedAccess() && storedTruthy(user.disabledAt)
	var verdict loginVerdict
	if user.linkedMode() {
		verdict.valid, err = linkedPasswordMatches(user, password)
		if err != nil {
			log.Print("linked password comparison failed")
			message(w, 500, "Authentication request failed")
			return
		}
	} else {
		verdict = b.verifyLocalLogin(ctx, user, password, body.Get("newPassword"), !blocked)
	}
	if !verdict.valid {
		message(w, 401, invalidCredentials)
		return
	}
	if blocked {
		message(w, 403, "Account disabled. Contact an administrator.")
		return
	}

	secret, err := b.authSecret()
	if err != nil {
		log.Printf("authentication secret unavailable: %v", err)
		message(w, 500, "Authentication request failed")
		return
	}
	token, err := auth.Issue(secret, jsvalue.Num(float64(user.id)), jsvalue.Str(user.username), verdict.claims, time.Now().UnixMilli())
	if err != nil {
		log.Printf("issue session: %v", err)
		message(w, 500, "Authentication request failed")
		return
	}
	fields := []jsvalue.Field{jsvalue.Property("token", jsvalue.Str(token))}
	respond(w, 200, append(fields, verdict.fields...)...)
}

func (b *backend) matchingAccounts(ctx context.Context, username string) ([]account, error) {
	rows, err := b.db.QueryContext(ctx, `
		SELECT id, username, password_hash, auth_mode, disabled_at,
		       server_username, server_password_hash, server_offline_verifier, server_sync_token,
		       server_offline_verifier_version,
		       (SELECT installation_uuid FROM installation_identity WHERE singleton_id=1)
		  FROM users WHERE username = ? OR server_username = ?
		 ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC`, username, username, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var local, linked []account
	for rows.Next() {
		var row account
		err := rows.Scan(&row.id, &row.username, &row.passwordHash, &row.mode, &row.disabledAt,
			&row.serverUsername, &row.serverPasswordHash, &row.offlineVerifier, &row.syncToken,
			&row.verifierVersion, &row.installationUUID)
		if err != nil {
			return nil, err
		}
		// String(row.username || '').trim(): node-sqlite3 decodes TEXT, and
		// String(Buffer) decodes a BLOB, as UTF-8 with replacement.
		if jsvalue.Trim(jsvalue.DecodeUTF8(row.username)) == username {
			local = append(local, row)
		} else if jsvalue.Trim(row.serverUsername.orString("")) == username {
			linked = append(linked, row)
		}
	}
	if len(local) != 0 {
		return local, rows.Err()
	}
	return linked, rows.Err()
}

func linkedPasswordMatches(user account, password jsvalue.Value) (bool, error) {
	// auth-process-result:177 ignores a verifier that is not a string.
	verifier, _ := storedText(user.offlineVerifier)
	verifier = jsvalue.Trim(verifier)
	if verifier != "" {
		subject, err := auth.VerifierSubject(password, jsvalue.Num(user.verifierVersionNumber()), user.installationUUID.orString(""), linkedGateway(user))
		if err == nil {
			return auth.ComparePassword(subject, verifier), nil
		}
		log.Printf("linked verifier subject unavailable: %v", err)
	}
	// flows.json auth-process-result:181: !!user.server_password_hash &&
	// bcrypt.compareSync(password, user.server_password_hash). compareSync
	// throws unless both arguments are strings; a BLOB is a truthy Buffer.
	if !storedTruthy(user.serverPasswordHash) {
		return false, nil
	}
	hash, ok := storedText(user.serverPasswordHash)
	if !ok || password.Kind != jsvalue.String {
		return false, errors.New("linked password comparison needs two strings")
	}
	return auth.ComparePassword(password, hash), nil
}

func linkedGateway(user account) string {
	if eui := auth.GatewayEUI(os.Getenv("LINK_GATEWAY_DEVICE_EUI")); eui != "" {
		return eui
	}
	parts := strings.Split(jsvalue.Trim(user.syncToken.orString("")), ".")
	if len(parts) >= 2 && parts[1] != "" {
		payload, err := auth.DecodeTokenPart(parts[1])
		if err != nil {
			log.Print("linked gateway: invalid sync token payload")
		} else {
			value := payload.Get("gateway_device_eui")
			if !value.Truthy() {
				value = payload.Get("gatewayDeviceEui")
			}
			text, err := value.OrEmpty().CoerceString()
			if err != nil {
				log.Print("linked gateway: invalid sync token gateway identity")
			} else if eui := auth.GatewayEUI(text); eui != "" {
				return eui
			}
		}
	}
	return auth.GatewayEUI(os.Getenv("DEVICE_EUI"))
}
