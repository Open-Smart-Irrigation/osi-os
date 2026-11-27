package jsvalue

import "testing"

func TestStringThrowsMatchesJavaScript(t *testing.T) {
	cases := map[string]bool{
		`{"toString":"x"}`:             true,  // own non-callable toString
		`{"valueOf":"x"}`:              false, // String() uses Object.prototype.toString
		`["a",{"toString":1}]`:         true,  // Array.prototype.join converts each element
		`["a","b"]`:                    false,
		`{"a":{"toString":1}}`:         false, // nested members are not converted
		`"plain"`:                      false,
		`{"toString":"x","valueOf":1}`: true,
	}
	for src, want := range cases {
		v, err := Parse([]byte(src))
		if err != nil {
			t.Fatal(err)
		}
		if got := v.StringThrows(); got != want {
			t.Errorf("%s: StringThrows=%v, want %v", src, got, want)
		}
	}
}
