package jsvalue

import (
	"bytes"
	"fmt"
	"testing"
)

func TestParseDuplicateKeysRetainFirstPosition(t *testing.T) {
	input := []byte(`{"a":1,"\ud800":2,"b":3,"c":4,"d":5,"e":6,"f":7,"g":8,"\ud801":9,"h":10,"i":0,"j":0,"\u0061":11,"\ud800":12,"𐀀":13,"\ud800\udc00":14,"nested":{"a":1,"a":2}}`)
	want := `{"a":11,"\ud800":12,"b":3,"c":4,"d":5,"e":6,"f":7,"g":8,"\ud801":9,"h":10,"i":0,"j":0,"𐀀":14,"nested":{"a":2}}`
	value, err := Parse(input)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Stringify(value)
	if err != nil || string(got) != want {
		t.Fatalf("Stringify = %s, %v; want %s", got, err, want)
	}
}

func BenchmarkParseObject(b *testing.B) {
	for _, size := range []int{10, 100, 1000, 10000} {
		var input bytes.Buffer
		input.WriteByte('{')
		for i := range size {
			if i != 0 {
				input.WriteByte(',')
			}
			fmt.Fprintf(&input, `"field%d":%d`, i, i)
		}
		input.WriteByte('}')
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(input.Len()))
			for b.Loop() {
				if _, err := Parse(input.Bytes()); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/float64(size), "ns/field")
		})
	}
}
