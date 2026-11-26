package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCloudConnectRetainsProvisionedValues(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OSI_EDGE_DATA_ROOT", root)
	if err := os.MkdirAll(filepath.Join(root, "data/db"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, eui, password, clientID, user, retainedPassword string
	}{
		{"fresh", "", "", "device_${DEVICE_EUI}", "", ""},
		{"linked", "first", "synthetic-first", "device_first", "first", "synthetic-first"},
		{"restarted without identity", "", "synthetic-second", "device_first", "first", "synthetic-first"},
		{"changed identity without password", "second", "", "device_second", "first", "synthetic-first"},
		{"restarted without identity or password", "", "", "device_second", "first", "synthetic-first"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveCloudConnect(tc.eui, tc.password)
			if err != nil {
				t.Fatal(err)
			}
			if got.ClientID != tc.clientID || got.User != tc.user || got.Password != tc.retainedPassword {
				t.Fatal("effective CONNECT values differ")
			}
		})
	}
	info, err := os.Stat(imagePath("/data/db/osi-edge-cloud-connect.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("CONNECT state mode is %o", info.Mode().Perm())
	}
}

func TestCloudConnectReconcilesRoundTrips(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OSI_EDGE_DATA_ROOT", root)
	write := func(path, contents string) {
		t.Helper()
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "data/db"), 0o700); err != nil {
		t.Fatal(err)
	}
	flows := "srv/node-red/flows.json"
	creds := "srv/node-red/flows_cred.json"
	write(flows, `[{"id":"ec43625ea99685a6","clientid":"device_red"}]`)
	write(creds, `{"ec43625ea99685a6":{"user":"red","password":"synthetic-red"}}`)
	check := func(eui, password, id, user, secret string) {
		t.Helper()
		got, err := resolveCloudConnect(eui, password)
		want := cloudConnect{ClientID: id, cloudCredentials: cloudCredentials{User: user, Password: secret}}
		if err != nil || got != want {
			t.Fatalf("CONNECT mismatch for expected client ID %q: %v", id, err)
		}
		t.Logf("observed client ID %q, username %q, password fixture %q", id, user, secret)
	}
	check("", "", "device_red", "red", "synthetic-red")
	check("go", "synthetic-go", "device_go", "go", "synthetic-go")
	write(creds, `{"ec43625ea99685a6":{"user":"red","password":"synthetic-red"},"other":{"user":"other"}}`)
	check("", "", "device_go", "go", "synthetic-go")
	write(flows, `[{"id":"ec43625ea99685a6","clientid":"device_new"}]`)
	check("", "", "device_new", "go", "synthetic-go")
	write(creds, `{"ec43625ea99685a6":{"user":"new","password":"synthetic-new"}}`)
	check("", "", "device_new", "new", "synthetic-new")
	check("again", "synthetic-again", "device_again", "again", "synthetic-again")
	check("", "", "device_again", "again", "synthetic-again")
}

func TestCloudConnectUpgradesLegacyStore(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OSI_EDGE_DATA_ROOT", root)
	files := []struct {
		path, contents string
		age            time.Duration
	}{
		{"/data/db/osi-edge-cloud-connect.json", `{"clientid":"device_go","user":"go","password":"synthetic-go"}`, -time.Hour},
		{"/srv/node-red/flows.json", `[{"id":"ec43625ea99685a6","clientid":"device_old"}]`, -2 * time.Hour},
		{"/srv/node-red/flows_cred.json", `{"ec43625ea99685a6":{"user":"new","password":"synthetic-new"}}`, 0},
	}
	now := time.Now()
	for _, file := range files {
		path := imagePath(file.path)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(file.contents), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := now.Add(file.age)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		got, err := resolveCloudConnect("", "")
		if err != nil || got.ClientID != "device_go" || got.User != "new" || got.Password != "synthetic-new" {
			t.Fatalf("legacy migration did not retain the Go client ID and adopt Node-RED credentials: %v", err)
		}
	}
}
