package procfence

import "testing"

// BenchmarkAdmitOpen measures Admit on an open fence outside a pass. It must
// run in a process where no test closed the fence: go test -run '^$' -bench.
func BenchmarkAdmitOpen(b *testing.B) {
	if Closed() {
		b.Skip("fence closed by an earlier test in this process")
	}
	for b.Loop() {
		Admit()
	}
}
