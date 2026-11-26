package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"os"

	"osi-edge/internal/jsvalue"
)

func configuredAuthSecret() string {
	configured := os.Getenv("AUTH_TOKEN_SECRET")
	if configured == "" {
		configured = os.Getenv("JWT_SECRET")
	}
	// Node decodes process.env and readFileSync(path, 'utf8') as UTF-8,
	// replacing invalid bytes with U+FFFD before trim() and the HMAC.
	return jsvalue.Trim(jsvalue.DecodeUTF8(configured))
}

func authSecretPaths() []string {
	return []string{
		imagePath("/data/db/osi_auth_token_secret"),
		imagePath("/var/lib/node-red/.node-red/osi_auth_token_secret"),
	}
}

func existingAuthSecret(paths []string) (path, secret string) {
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("read auth secret: %v", err)
		}
		if secret := jsvalue.Trim(jsvalue.DecodeUTF8(string(data))); err == nil && secret != "" {
			return path, secret
		}
	}
	return "", ""
}

func (b *backend) authSecret() (string, error) {
	if configured := configuredAuthSecret(); configured != "" {
		return configured, nil
	}
	b.secrets.Lock()
	defer b.secrets.Unlock()
	paths := authSecretPaths()
	if _, secret := existingAuthSecret(paths); secret != "" {
		return secret, nil
	}
	generated := newAuthSecret()
	for _, path := range paths {
		if err := os.WriteFile(path, []byte(generated+"\n"), 0o600); err == nil {
			return generated, nil
		} else {
			log.Printf("write auth secret: %v", err)
		}
	}
	return "", errors.New("AUTH_TOKEN_SECRET or JWT_SECRET must be configured")
}

func newAuthSecret() string {
	var random [48]byte
	rand.Read(random[:])
	return hex.EncodeToString(random[:])
}
