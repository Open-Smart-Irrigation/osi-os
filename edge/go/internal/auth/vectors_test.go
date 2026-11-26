package auth_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"osi-edge/internal/auth"
	"osi-edge/internal/jsvalue"
)

func loadVectors[T any](t *testing.T, name string) T {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", name+".vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors T
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func parsed(t *testing.T, raw json.RawMessage) jsvalue.Value {
	t.Helper()
	value, err := jsvalue.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func untag(t *testing.T, tagged jsvalue.Value) jsvalue.Value {
	t.Helper()
	switch tagged.Kind {
	case jsvalue.Array:
		for i, v := range tagged.List {
			tagged.List[i] = untag(t, v)
		}
	case jsvalue.Object:
		if bits := tagged.Get("n"); bits.Kind != jsvalue.Undefined {
			n, err := strconv.ParseUint(bits.ToString(), 16, 64)
			if err != nil {
				t.Fatal(err)
			}
			return jsvalue.Num(math.Float64frombits(n))
		}
		if text := tagged.Get("u16"); text.Kind != jsvalue.Undefined {
			units := make([]uint16, len(text.List))
			for i, unit := range text.List {
				units[i] = uint16(unit.Num)
			}
			return jsvalue.Value{Kind: jsvalue.String, Text: units}
		}
		if obj := tagged.Get("o"); obj.Kind != jsvalue.Undefined {
			fields := make([]jsvalue.Field, len(obj.List))
			for i, entry := range obj.List {
				fields[i] = jsvalue.Field{Key: untag(t, entry.List[0]).Text, Value: untag(t, entry.List[1])}
			}
			return jsvalue.Obj(fields...)
		}
		if undef := tagged.Get("undef"); undef.Bool {
			return jsvalue.Value{}
		}
		t.Fatal("unrecognized tagged object")
	}
	return tagged
}

func equal[T any](t *testing.T, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

type renderResult struct {
	OK      bool
	Text    *string
	UTF8Hex string
	SHA256  string
	Error   string
}

func TestJSONVectors(t *testing.T) {
	for _, tc := range []struct {
		file   string
		encode func(jsvalue.Value) ([]byte, error)
	}{
		{"json-wire", jsvalue.Stringify},
		{"canonical-v2", jsvalue.Canonical},
	} {
		t.Run(tc.file, func(t *testing.T) {
			fixture := loadVectors[struct {
				Vectors []struct {
					Input  json.RawMessage
					Expect renderResult
				}
			}](t, tc.file)
			for i, vector := range fixture.Vectors {
				t.Run(strconv.Itoa(i), func(t *testing.T) {
					bytes, err := tc.encode(untag(t, parsed(t, vector.Input)))
					if err != nil {
						equal(t, renderResult{Error: err.Error()}, vector.Expect)
						return
					}
					s := string(bytes)
					hash := sha256.Sum256(bytes)
					equal(t, renderResult{true, &s, hex.EncodeToString(bytes), hex.EncodeToString(hash[:]), ""}, vector.Expect)
				})
			}
		})
	}
}

func TestTokenVectors(t *testing.T) {
	type verifyResult struct {
		OK       bool
		UserID   *float64
		Username string
		Status   int
		Message  string
	}
	fixture := loadVectors[struct {
		Issue []struct {
			Secret       string
			NowMs        int64
			User, Claims json.RawMessage
			Expect       string
		}
		Verify []struct {
			ID, Secret, Authorization string
			NowMs                     int64
			Expect                    verifyResult
		}
	}](t, "token")
	for i, vector := range fixture.Issue {
		t.Run(fmt.Sprintf("issue/%d", i), func(t *testing.T) {
			user := parsed(t, vector.User)
			token, err := auth.Issue(vector.Secret, user.Get("id"), user.Get("username"), parsed(t, vector.Claims), vector.NowMs)
			if err != nil {
				t.Fatal(err)
			}
			equal(t, token, vector.Expect)
		})
	}
	for _, vector := range fixture.Verify {
		t.Run("verify/"+vector.ID, func(t *testing.T) {
			session, failure := auth.VerifyBearer(vector.Authorization, vector.NowMs, func() (string, error) {
				return vector.Secret, nil
			})
			if failure != nil {
				equal(t, verifyResult{Status: failure.Status, Message: failure.Message}, vector.Expect)
				return
			}
			equal(t, verifyResult{OK: true, UserID: &session.UserID, Username: session.Username.ToString()}, vector.Expect)
		})
	}
}

func TestBcryptVectors(t *testing.T) {
	type hashResult struct {
		OK          bool
		Hash, Error string
	}
	type subjectResult struct {
		OK             bool
		Subject, Error string
	}
	fixture := loadVectors[struct {
		DefaultSaltPrefix string
		Hash              []struct {
			Password json.RawMessage
			Salt     string
			Expect   hashResult
		}
		Compare []struct {
			Password json.RawMessage
			Hash     string
			Expect   bool
		}
		VerifierSubject []struct {
			Password, Version                  json.RawMessage
			InstallationUUID, GatewayDeviceEUI *string
			Expect                             subjectResult
		}
	}](t, "bcrypt")
	t.Run("default-salt", func(t *testing.T) {
		hash, err := auth.NewPasswordHash(jsvalue.Str("synthetic"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(hash, fixture.DefaultSaltPrefix) {
			t.Fatalf("hash %q lacks prefix %q", hash, fixture.DefaultSaltPrefix)
		}
	})
	for i, vector := range fixture.Hash {
		t.Run(fmt.Sprintf("hash/%d", i), func(t *testing.T) {
			hash, err := auth.HashPassword(untag(t, parsed(t, vector.Password)), vector.Salt)
			if err != nil {
				equal(t, hashResult{Error: err.Error()}, vector.Expect)
				return
			}
			equal(t, hashResult{OK: true, Hash: hash}, vector.Expect)
		})
	}
	for i, vector := range fixture.Compare {
		t.Run(fmt.Sprintf("compare/%d", i), func(t *testing.T) {
			equal(t, auth.ComparePassword(untag(t, parsed(t, vector.Password)), vector.Hash), vector.Expect)
		})
	}
	for i, vector := range fixture.VerifierSubject {
		t.Run(fmt.Sprintf("subject/%d", i), func(t *testing.T) {
			subject, err := auth.VerifierSubject(parsed(t, vector.Password), parsed(t, vector.Version),
				orEmpty(vector.InstallationUUID), orEmpty(vector.GatewayDeviceEUI))
			if err != nil {
				equal(t, subjectResult{Error: err.Error()}, vector.Expect)
				return
			}
			equal(t, subjectResult{OK: true, Subject: subject.ToString()}, vector.Expect)
		})
	}
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
