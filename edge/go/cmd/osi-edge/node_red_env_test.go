package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The same file through settings.js's loadChirpstackEnvFile on Node 20.18.3
// gives the values asserted here.
func TestLoadNodeRedEnvFileMatchesSettings(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".chirpstack.env")
	content := "# CHIRPSTACK_PROFILE_LORAIN=commented\r\n" +
		"  CHIRPSTACK_PROFILE_STREGA_GEN2 = \"gen2-id\"  \r\n" +
		"CHIRPSTACK_PROFILE_UC512='uc512-id\n" +
		"CHIRPSTACK_API_URL=http://127.0.0.1:8080=x\n" +
		"CHIRPSTACK_PROFILE_LSN50=file-lsn50\n" +
		"CHIRPSTACK_PROFILE_SDI12=file-sdi12\n" +
		"DEVICE_EUI=FFFFFFFFFFFFFFFF\n" +
		"=no-key\n" +
		"no-equals\n" +
		"CHIRPSTACK_API_KEY=\"\n" +
		"\xef\xbb\xbfOSI_TEST_BOM=bom\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHIRPSTACK_PROFILE_STREGA_GEN2", "")
	t.Setenv("CHIRPSTACK_PROFILE_UC512", "")
	t.Setenv("CHIRPSTACK_API_URL", "")
	t.Setenv("CHIRPSTACK_PROFILE_LSN50", "from-init")
	t.Setenv("CHIRPSTACK_PROFILE_SDI12", "")
	t.Setenv("DEVICE_EUI", "")
	t.Setenv("CHIRPSTACK_API_KEY", "")
	t.Setenv("OSI_TEST_BOM", "")
	t.Setenv("CHIRPSTACK_PROFILE_LORAIN", "")
	if err := loadNodeRedEnvFile(path); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"CHIRPSTACK_PROFILE_STREGA_GEN2": "gen2-id",
		"CHIRPSTACK_PROFILE_UC512":       "uc512-id",
		"CHIRPSTACK_API_URL":             "http://127.0.0.1:8080=x",
		"CHIRPSTACK_PROFILE_LSN50":       "from-init",  // a set value wins
		"CHIRPSTACK_PROFILE_SDI12":       "file-sdi12", // an empty value is filled
		"DEVICE_EUI":                     "",           // identity is protected
		"CHIRPSTACK_API_KEY":             "",           // one quote is stripped
		"OSI_TEST_BOM":                   "bom",        // trim() removes U+FEFF
		"CHIRPSTACK_PROFILE_LORAIN":      "",
	} {
		if got := os.Getenv(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if err := loadNodeRedEnvFile(filepath.Join(dir, "absent")); err != nil {
		t.Errorf("a missing file is skipped, got %v", err)
	}
	if err := loadNodeRedEnvFile(dir); err == nil {
		t.Error("an unreadable file stops the start, as settings.js throws")
	}
}
