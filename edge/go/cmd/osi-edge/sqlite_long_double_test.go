package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The x86 oracle and the aarch64 gateway store different doubles for some
// decimal literals (measured: 18 of 100,000). Both precisions must reproduce
// their engine, and the build's own precision must follow its GOARCH.
func TestSQLite344RealMatchesBothEngines(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../vectors/atof-arch.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []struct{ Decimal, X86, Arm64 string }
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	differ := 0
	for _, v := range doc.Vectors {
		if v.X86 != v.Arm64 {
			differ++
		}
		for _, c := range []struct {
			prec uint
			want string
		}{{64, v.X86}, {113, v.Arm64}} {
			if got := fmt.Sprintf("%016x", math.Float64bits(sqlite344RealPrec(v.Decimal, c.prec))); got != c.want {
				t.Errorf("%s at %d bits = %s, want %s", v.Decimal, c.prec, got, c.want)
			}
		}
	}
	if differ != 18 {
		t.Errorf("vector file has %d architecture differences, want 18", differ)
	}
	want := uint(64)
	if runtime.GOARCH == "arm64" {
		want = 113
	}
	if sqliteLongDoubleBits != want {
		t.Errorf("sqliteLongDoubleBits = %d on %s", sqliteLongDoubleBits, runtime.GOARCH)
	}
}
