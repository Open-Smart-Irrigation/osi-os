package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

// Node reads the secret with readFileSync(path, 'utf8') or process.env, so
// invalid bytes become U+FFFD before trim() and the HMAC. Expected value from
// Node 22: crypto.createHmac('sha256', String(fs.readFileSync(f, 'utf8')).trim())
// .update('eyJ1c2VySWQiOjF9').digest('base64url'); String(process.env.AUTH_TOKEN_SECRET)
// .trim() with the same bytes in the environment gives the same value.
func TestAuthSecretDecodedAsUTF8(t *testing.T) {
	const raw = " s\xffe\xe2\x82cr\xedt\xc2\xa0\n"
	const want = "-dehABlUnJ96u1Tc1FkakAfuO_Kr6_Sk-KJPiPjBa1c"
	mac := func(secret string) string {
		h := hmac.New(sha256.New, []byte(secret))
		h.Write([]byte("eyJ1c2VySWQiOjF9"))
		return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
	}
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, secret := existingAuthSecret([]string{path}); mac(secret) != want {
		t.Errorf("file secret %q signs %s, want %s", secret, mac(secret), want)
	}
	t.Setenv("AUTH_TOKEN_SECRET", raw)
	if secret := configuredAuthSecret(); mac(secret) != want {
		t.Errorf("environment secret %q signs %s, want %s", secret, mac(secret), want)
	}
}
