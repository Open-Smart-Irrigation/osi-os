package main

import (
	"fmt"
	"strings"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

// Several shipped nodes embed request values in SQL text as quoted literals,
// with each quote doubled, instead of binding them. The quote doubling makes
// that safe for every character except U+0000: SQLite reads
// the statement as a C string, so the text ends inside the open literal and
// the statement fails with `unrecognized token: "'<prefix>"`. Go binds every
// value, so each route that ports such a node states which values its JS
// embeds, in statement order, and fails the way the node does.
//
// splicedLiteralError returns that SQLite error for the first value that
// holds a NUL, or nil. Only the first failing statement matters: the node
// never reaches the next one.
func splicedLiteralError(values ...string) error {
	for _, value := range values {
		if before, _, found := strings.Cut(value, "\x00"); found {
			return fmt.Errorf("SQLITE_ERROR: unrecognized token: \"'%s\"", strings.ReplaceAll(before, "'", "''"))
		}
	}
	return nil
}

// legacyUserLookupError is the statement the legacy auth nodes build after
// verifyBearer:
//
//	SELECT id FROM users WHERE id = ${auth.userId} AND username = '${escaped username}'
//
// auth.userId is a finite JS number, whose text is always valid SQL, so only
// the username can fail; legacyUserLookupID is what that text binds. Nodes with this statement: get-zones-auth,
// post-zone-auth, get-devices-auth, post-devices-auth and
// osi-daily-scheduler/schedule-save.js decodeToken (Go routes), plus
// delete-device-auth, delete-zone-auth, assign-device-auth,
// unassign-device-auth and get-actuations-auth (routes Go does not serve).
// The failure reaches device-api-catch, so callers answer with
// deviceAPISQLFailure.
func legacyUserLookupError(session auth.Session) error {
	return splicedLiteralError(session.Username.MustString())
}

// legacyUserLookupID is `${auth.userId}` in that statement: the integer or
// REAL SQLite reads from String(userId), not the double. A token id of
// 123456789012345696 spells 123456789012345700, so the lookup misses user
// 123456789012345696 and finds user 123456789012345700. The scoped routers'
// own lookups bind auth.userId and keep binding session.UserID.
func legacyUserLookupID(session auth.Session) any {
	return sqliteNumberLiteral(session.UserID)
}

// nullPayloadMessage is V8's text for `payload.userId` on a null payload.
const nullPayloadMessage = "Cannot read properties of null (reading 'userId')"

// signedNullPayload reports a validly signed token whose payload parses as
// JSON null. The verifyBearer copies in the legacy nodes read payload.userId
// outside their try, so that token throws a TypeError instead of answering
// "Invalid token". JSON.parse decides, not String.prototype.trim: a payload
// padded with NBSP or a BOM is a SyntaxError, caught as "Invalid token".
func signedNullPayload(failure *auth.AuthError) bool {
	if failure == nil || failure.SignedPayload == nil {
		return false
	}
	payload, err := jsvalue.Parse([]byte(*failure.SignedPayload))
	return err == nil && payload.Kind == jsvalue.Null
}
