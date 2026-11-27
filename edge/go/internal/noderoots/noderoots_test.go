package noderoots

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The embedded roots are exactly Node's bundled roots: the committed
// fingerprint list and, live, the oracle Node's tls.rootCertificates.
func TestRootsMatchNode(t *testing.T) {
	got := Fingerprints()
	slices.Sort(got)
	if len(got) != 152 {
		t.Fatalf("%d roots, want 152", len(got))
	}
	var vectors struct {
		Node   string
		Count  int
		SHA256 []string
	}
	data, err := os.ReadFile("../../../vectors/node-roots.vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Node != NodeVersion || vectors.Count != len(got) || !slices.Equal(vectors.SHA256, got) {
		t.Fatalf("embedded roots differ from edge/vectors/node-roots.vectors.json (Node %s, %d roots)", vectors.Node, vectors.Count)
	}

	node := os.Getenv("OSI_ORACLE_NODE")
	if node == "" {
		node = filepath.Join(os.Getenv("HOME"), ".local/node-v"+NodeVersion+"-linux-x64/bin/node")
	}
	if _, err := os.Stat(node); err != nil {
		t.Skipf("oracle Node %s not installed at %s (set OSI_ORACLE_NODE); compared with the committed list only", NodeVersion, node)
	}
	out, err := exec.Command(node, "-e", `
const tls = require('tls'), crypto = require('crypto');
if (process.versions.node !== process.argv[1]) throw new Error('Node ' + process.versions.node);
console.log(tls.rootCertificates.map((p) => new crypto.X509Certificate(p).fingerprint256.replace(/:/g, '').toLowerCase()).sort().join('\n'));
`, NodeVersion).CombinedOutput()
	if err != nil {
		t.Fatalf("oracle Node: %v: %s", err, out)
	}
	live := strings.Fields(string(out))
	if !slices.Equal(live, got) {
		t.Fatalf("embedded roots differ from Node %s's tls.rootCertificates (%d live)", NodeVersion, len(live))
	}
}

func TestPoolIsFreshAndComplete(t *testing.T) {
	a, b := Pool(), Pool()
	if a == b || !a.Equal(b) {
		t.Fatal("Pool must return equal, distinct pools")
	}
}
