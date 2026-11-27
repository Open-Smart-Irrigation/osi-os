package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"math"
	"strings"

	"osi-edge/internal/jsvalue"
)

const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000

func Issue(secret string, userID, username, claims jsvalue.Value, nowMs int64) (string, error) {
	payload := jsvalue.Obj(
		jsvalue.Property("userId", jsvalue.Num(userID.MustNumber())),
		jsvalue.Property("username", username.OrEmpty().TrimmedString()),
		jsvalue.Property("iat", jsvalue.Num(float64(nowMs))),
		jsvalue.Property("exp", jsvalue.Num(float64(nowMs+sessionLifetimeMs))),
	)
	for _, claim := range claims.Fields {
		payload.Set(claim)
	}
	body, err := jsvalue.Stringify(payload)
	if err != nil {
		return "", err
	}
	part := base64.RawURLEncoding.EncodeToString(body)
	return part + "." + sign(secret, part), nil
}

func sign(secret, part string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(part))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

type Session struct {
	UserID     float64
	Username   jsvalue.Value
	Expiration float64
}

type AuthError struct {
	Status  int
	Message string
	// SignedPayload is set for malformed JSON or null after checking the
	// signature. Legacy routes differ in how they report this failure.
	SignedPayload *string
	// Coercion distinguishes an exception in a validly signed payload from
	// an ordinary invalid-token response.
	Coercion bool
}

func VerifyBearer(header string, nowMs int64, resolveSecret func() (string, error)) (Session, *AuthError) {
	payload, failure := VerifyBearerPayload(header, resolveSecret)
	if failure != nil {
		return Session{}, failure
	}
	userID, err := payload.Get("userId").CoerceNumber()
	if err != nil {
		return Session{}, coercionAuthError(err)
	}
	username, err := payload.Get("username").OrEmpty().CoerceTrimmedString()
	if err != nil {
		return Session{}, coercionAuthError(err)
	}
	exp, err := payload.Get("exp").CoerceNumber()
	if err != nil {
		return Session{}, coercionAuthError(err)
	}
	if math.IsNaN(userID) || math.IsInf(userID, 0) || !username.Truthy() {
		return Session{}, &AuthError{Status: 401, Message: "Invalid token"}
	}
	if exp != 0 && float64(nowMs) > exp {
		return Session{}, &AuthError{Status: 401, Message: "Token expired"}
	}
	return Session{UserID: userID, Username: username, Expiration: exp}, nil
}

func coercionAuthError(err error) *AuthError {
	return &AuthError{Status: 500, Message: err.Error(), Coercion: true}
}

// VerifyBearerPayload verifies the signature and decodes the signed JSON.
// Routes with their own claim rules validate the returned payload themselves.
func VerifyBearerPayload(header string, resolveSecret func() (string, error)) (jsvalue.Value, *AuthError) {
	// Node reads the header as latin1, so String.prototype.trim removes a
	// 0xA0 byte, and the HMAC input is the UTF-8 encoding of that string.
	header = jsvalue.Latin1(header)
	if !strings.HasPrefix(header, "Bearer ") {
		return jsvalue.Value{}, &AuthError{Status: 401, Message: "Unauthorized"}
	}
	parts := strings.Split(jsvalue.Trim(header[7:]), ".")
	invalid := &AuthError{Status: 401, Message: "Invalid token"}
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return jsvalue.Value{}, invalid
	}
	secret, err := resolveSecret()
	if err != nil {
		return jsvalue.Value{}, &AuthError{Status: 500, Message: err.Error()}
	}
	if !hmac.Equal([]byte(parts[1]), []byte(sign(secret, parts[0]))) {
		return jsvalue.Value{}, invalid
	}
	data, err := decodeTokenPart(parts[0])
	if err != nil {
		return jsvalue.Value{}, invalid
	}
	payload, err := jsvalue.Parse(data)
	if err != nil || payload.Kind == jsvalue.Null {
		text := string(data)
		invalid.SignedPayload = &text
		return jsvalue.Value{}, invalid
	}
	return payload, nil
}

func DecodeTokenPart(part string) (jsvalue.Value, error) {
	body, err := decodeTokenPart(part)
	if err != nil {
		return jsvalue.Value{}, err
	}
	return jsvalue.Parse(body)
}

func decodeTokenPart(part string) ([]byte, error) {
	// Node accepts both base64 alphabets and ignores foreign characters.
	part, _, _ = strings.Cut(part, "=")
	part = strings.Map(func(r rune) rune {
		switch {
		case r == '+':
			return '-'
		case r == '/':
			return '_'
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return -1
		}
	}, part)
	if len(part)%4 == 1 {
		part = part[:len(part)-1]
	}
	return base64.RawURLEncoding.DecodeString(part)
}
