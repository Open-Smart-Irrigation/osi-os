package jsnum

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"testing"
)

func TestMathRoundVectors(t *testing.T) {
	data, err := os.ReadFile("../../../vectors/js-number.vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	type number struct{ N string }
	var fixture struct {
		Vectors []struct{ Input, MathRound number }
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	bits := func(v number) uint64 {
		n, err := strconv.ParseUint(v.N, 16, 64)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	for _, vector := range fixture.Vectors {
		t.Run(vector.Input.N, func(t *testing.T) {
			want := bits(vector.MathRound)
			got := math.Float64bits(Round(math.Float64frombits(bits(vector.Input))))
			if got != want && !(math.IsNaN(math.Float64frombits(got)) && math.IsNaN(math.Float64frombits(want))) {
				t.Errorf("Math.round bits: got %016x, want %016x", got, want)
			}
		})
	}
}
