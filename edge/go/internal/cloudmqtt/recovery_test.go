package cloudmqtt

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryBlocked(t *testing.T) {
	cases := []struct {
		name, path, contents string
		blocked              bool
	}{
		{name: "ordinary publication"},
		{name: "journal", path: "/data/db/osi-account-link-config.json", contents: "{}", blocked: true},
		{name: "link", path: "/var/run/osi-node-red-restart-requests/account_link-a.json", blocked: true},
		{name: "unlink", path: "/var/run/osi-node-red-restart-requests/account_unlink-a.json", blocked: true},
		{name: "identity only", path: "/var/run/osi-identity-restart.json", contents: "{}", blocked: true},
		{name: "unreadable identity", path: "/var/run/osi-identity-restart.json", contents: "{", blocked: true},
		{name: "unrelated request", path: "/var/run/osi-node-red-restart-requests/other-a.json"},
		{name: "empty request ID", path: "/var/run/osi-node-red-restart-requests/account_link-.json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			imagePath := func(path string) string { return filepath.Join(root, path) }
			if tc.path != "" {
				path := imagePath(tc.path)
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(tc.contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if got, err := recoveryBlocked(imagePath); got != tc.blocked || err != nil {
				t.Fatalf("recovery blocked = %t, error = %v, want %t", got, err, tc.blocked)
			}
		})
	}
}
