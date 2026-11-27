package jstimezone

import (
	"encoding/json"
	"os"
	"testing"
)

// zones_iana.vectors.json was generated on the x86 oracle (Node 20.18.3, full
// ICU 75.1, tzdata 2024b). The gateway guest re-resolves every name of that
// corpus with its own small ICU and lists what differs.
func TestZoneCorpusMatchesGateway(t *testing.T) {
	path := os.Getenv("OSI_INTL_VECTORS")
	if path == "" {
		path = "../../../vectors/intl-gateway.vectors.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Sections struct {
			Facts struct {
				Versions map[string]string `json:"versions"`
			} `json:"facts"`
			ZoneNames struct {
				Count       int               `json:"count"`
				Differences []json.RawMessage `json:"differences"`
				Source      map[string]string `json:"corpus_source"`
				Error       string            `json:"error"`
			} `json:"zone_names"`
		} `json:"sections"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	z := v.Sections.ZoneNames
	if z.Error != "" || z.Count == 0 {
		t.Fatalf("no zone-name vectors: %s", z.Error)
	}
	var corpus struct {
		Source map[string]string `json:"source"`
		Cases  [][3]*string      `json:"cases"`
	}
	if err := json.Unmarshal(nodeTimezoneVectors, &corpus); err != nil {
		t.Fatal(err)
	}
	if z.Count != len(corpus.Cases) {
		t.Errorf("gateway checked %d names, the embedded corpus has %d", z.Count, len(corpus.Cases))
	}
	for _, d := range z.Differences {
		t.Errorf("gateway resolves differently: %s", d)
	}
	if tz := v.Sections.Facts.Versions["tz"]; tz != corpus.Source["tz"] {
		t.Errorf("gateway tzdata %s, embedded zones %s", tz, corpus.Source["tz"])
	}
}
