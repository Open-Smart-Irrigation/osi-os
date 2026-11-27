package ingest

import (
	"container/list"
	"sync"

	"osi-edge/internal/jsvalue"
)

// Node-RED's osi-uplink-dedup-guard keeps one guard per process
// (DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS), shared by every decoder that writes
// device_data; keys are namespaced by source, so the decoders share only the
// capacity. A key stays recorded when the write after it fails.
const (
	DedupMaxEntries = 2000
	DedupTTLMillis  = 10 * 60 * 1000
)

// DedupGuard is the process-wide pre-write duplicate hint. The zero value is
// ready to use and safe for concurrent handlers.
type DedupGuard struct {
	mu    sync.Mutex
	order list.List // of dedupEntry, oldest first
	seen  map[string]*list.Element
}

type dedupEntry struct {
	key        string
	insertedAt int64
}

// IsDuplicate models isDuplicateUplink({source, event, devEui, receivedAtMs}).
// nowMs is Date.now(): wall-clock milliseconds, not a monotonic reading.
func (g *DedupGuard) IsDuplicate(source string, event jsvalue.Value, devEUI string, nowMs int64) bool {
	return g.checkAndRecord(DedupKey(source, event, devEUI), nowMs)
}

// DedupKey models buildDedupKey: the device EUI (trimmed, upper case) and the
// durable event key, or "" for an unkeyable uplink.
func DedupKey(source string, event jsvalue.Value, devEUI string) string {
	if source == "" {
		source = "uplink"
	}
	eui := jsvalue.Upper(jsvalue.Trim(devEUI))
	if eui == "" {
		id := event.Get("deduplicationId")
		if id.Kind != jsvalue.String || !id.TrimmedString().Truthy() {
			return ""
		}
	}
	key := EventKey(source, event)
	if key == "" {
		return ""
	}
	return eui + ":" + key
}

func (g *DedupGuard) checkAndRecord(key string, nowMs int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for oldest := g.order.Front(); oldest != nil; oldest = g.order.Front() {
		entry := oldest.Value.(dedupEntry)
		if nowMs-entry.insertedAt <= DedupTTLMillis {
			break
		}
		delete(g.seen, entry.key)
		g.order.Remove(oldest)
	}
	if key == "" {
		return false
	}
	if _, found := g.seen[key]; found {
		return true
	}
	if g.seen == nil {
		g.seen = make(map[string]*list.Element)
	}
	g.seen[key] = g.order.PushBack(dedupEntry{key, nowMs})
	for g.order.Len() > DedupMaxEntries {
		oldest := g.order.Front()
		delete(g.seen, oldest.Value.(dedupEntry).key)
		g.order.Remove(oldest)
	}
	return false
}

// Len reports the number of recorded keys.
func (g *DedupGuard) Len() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.order.Len()
}
