package ingest

import (
	"fmt"
	"testing"

	"osi-edge/internal/jsvalue"
)

// Expected keys from buildDedupKey (osi-uplink-dedup-guard) on Node 20.18.3.
func TestDedupKeyMatchesNodeRed(t *testing.T) {
	for _, tc := range []struct{ source, eui, event, want string }{
		{"kiwi", " a840410000000001 ", `{"deduplicationId":" abc "}`, "A840410000000001:b94d95fa6b1bb40ad28f9a517b64f99d65dd5e470ce15582b68352b3dd90c1e6"},
		{"strega", "A840410000000001", `{"deduplicationId":"abc"}`, "A840410000000001:b24ade704a69e2e95a66d55f00bce1c41b6d44cccd1913a155f65c347d6d0fa9"},
		{"kiwi", "", `{"deduplicationId":"abc"}`, ":b94d95fa6b1bb40ad28f9a517b64f99d65dd5e470ce15582b68352b3dd90c1e6"},
		{"kiwi", "", `{"fCnt":3,"time":"2026-11-20T00:00:00Z"}`, ""},
		{"", "X", `{"fCnt":3,"time":"2026-11-20T00:00:00Z","devAddr":"01","fPort":2}`, "X:050ecc1807f6b7f34fe91ba06dc767559fd0feaa5d7a266c4ef0fa28899b94ec"},
		{"kiwi", "X", `{"fCnt":3.5,"time":"2026-11-20T00:00:00Z"}`, ""},
	} {
		event, err := jsvalue.Parse([]byte(tc.event))
		if err != nil {
			t.Fatal(err)
		}
		if got := DedupKey(tc.source, event, tc.eui); got != tc.want {
			t.Errorf("DedupKey(%q, %s, %q) = %q, want %q", tc.source, tc.event, tc.eui, got, tc.want)
		}
	}
}

// One capacity for every source, the TTL boundary of checkAndRecord, and an
// unkeyable uplink that is never recorded.
func TestDedupGuardSharedCapacityAndTTL(t *testing.T) {
	var g DedupGuard
	kiwi, _ := jsvalue.Parse([]byte(`{"deduplicationId":"aborted"}`))
	if g.IsDuplicate("kiwi", kiwi, "A1", 1000) {
		t.Fatal("first delivery reported as duplicate")
	}
	if !g.IsDuplicate("kiwi", kiwi, "A1", 1000+DedupTTLMillis) {
		t.Fatal("a repeat exactly at the TTL is still a duplicate")
	}
	if g.IsDuplicate("strega", kiwi, "A1", 1000) {
		t.Fatal("sources are namespaced")
	}
	for i := range DedupMaxEntries - 2 { // plus the kiwi and strega keys above
		event, _ := jsvalue.Parse(fmt.Appendf(nil, `{"deduplicationId":"fill-%d"}`, i))
		g.IsDuplicate("strega", event, "A1", 1000)
	}
	if g.Len() != DedupMaxEntries {
		t.Fatalf("Len = %d", g.Len())
	}
	if g.IsDuplicate("kiwi", kiwi, "A1", 1000) == false {
		t.Fatal("still within capacity")
	}
	last, _ := jsvalue.Parse([]byte(`{"deduplicationId":"fill-last"}`))
	g.IsDuplicate("strega", last, "A1", 1000)
	if g.IsDuplicate("kiwi", kiwi, "A1", 1000) {
		t.Fatal("STREGA keys must evict the oldest KIWI key from the shared capacity")
	}
	unkeyed, _ := jsvalue.Parse([]byte(`{"fCnt":1}`))
	before := g.Len()
	if g.IsDuplicate("kiwi", unkeyed, "A1", 1000) || g.IsDuplicate("kiwi", unkeyed, "A1", 1000) || g.Len() != before {
		t.Fatal("an unkeyable uplink is never a duplicate and never recorded")
	}
	if g.IsDuplicate("kiwi", last, "A1", 1001+DedupTTLMillis); g.Len() != 1 {
		t.Fatalf("expired keys are pruned on the next call: Len = %d", g.Len())
	}
}
