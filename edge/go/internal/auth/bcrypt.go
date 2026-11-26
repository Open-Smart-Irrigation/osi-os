package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/blowfish"

	"osi-edge/internal/jsvalue"
)

const PasswordCost = 10
const MaxPasswordBytes = 72

var bcryptBase64 = base64.NewEncoding("./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789").WithPadding(base64.NoPadding)

func NewPasswordHash(password jsvalue.Value) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return HashPassword(password, fmt.Sprintf("$2b$%02d$%s", PasswordCost, bcryptBase64.EncodeToString(salt)))
}

// HashPassword uses bcryptjs's revision and byte semantics with x/crypto's
// Blowfish key schedule. A fixed salt is also needed to reproduce oracle vectors.
func HashPassword(password jsvalue.Value, salt string) (string, error) {
	if password.Kind != jsvalue.String {
		return "", errors.New("Invalid string / salt: Not a string")
	}
	parts := strings.SplitN(salt, "$", 4)
	if len(parts) != 4 || parts[0] != "" {
		return "", errors.New("invalid bcrypt salt")
	}
	revision := parts[1]
	switch revision {
	case "2", "2a", "2b", "2y":
	default:
		return "", errors.New("invalid bcrypt revision")
	}
	cost, err := strconv.Atoi(parts[2])
	if err != nil || len(parts[2]) != 2 || cost < 4 || cost > 31 {
		return "", errors.New("invalid bcrypt cost")
	}
	if len(parts[3]) < 22 {
		return "", errors.New("invalid bcrypt salt length")
	}
	saltBytes, err := bcryptBase64.DecodeString(parts[3][:22])
	if err != nil {
		return "", err
	}
	key := password.UTF8(true)
	if revision != "2" || len(key) == 0 {
		key = append(key, 0)
	}
	key = key[:min(len(key), MaxPasswordBytes)]
	cipher, err := blowfish.NewSaltedCipher(key, saltBytes)
	if err != nil {
		return "", err
	}
	for range uint64(1) << cost {
		blowfish.ExpandKey(key, cipher)
		blowfish.ExpandKey(saltBytes, cipher)
	}
	hash := []byte("OrpheanBeholderScryDoubt")
	for block := 0; block < len(hash); block += blowfish.BlockSize {
		for range 64 {
			cipher.Encrypt(hash[block:], hash[block:])
		}
	}
	return fmt.Sprintf("$%s$%02d$%s%s", revision, cost, bcryptBase64.EncodeToString(saltBytes), bcryptBase64.EncodeToString(hash[:23])), nil
}

func ComparePassword(password jsvalue.Value, expected string) bool {
	if len(expected) != 60 {
		return false
	}
	actual, err := HashPassword(password, expected)
	return err == nil && subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}
