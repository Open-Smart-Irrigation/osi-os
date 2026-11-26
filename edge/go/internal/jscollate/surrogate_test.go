package jscollate

import "testing"

// A JS string can hold a lone surrogate; jsvalue writes it as three bytes
// (WTF-8). Node 20.18.3 (ICU 75.1, the gateway's ICU) collates it as its own
// code point with an unassigned code point's implicit weight. Signs from
// [a, b].map(...) a.localeCompare(b) on the x86 oracle; review probe F2.
func TestCompareLoneSurrogateBytes(t *testing.T) {
	const (
		d800 = "\xed\xa0\x80"
		d801 = "\xed\xa0\x81"
		dc00 = "\xed\xb0\x80"
		dfff = "\xed\xbf\xbf"
	)
	for _, tc := range []struct {
		a, b string
		want int
	}{
		{d800, "�", -1},
		{d801, d800, 1},
		{dc00, d801, 1},
		{dfff, dc00, 1},
		{d800, "͸", 1},
		{d800, "퟼", 1},
		{d800, "", -1},
		{d800, "﷐", -1},
		{d800, "\U00010000", 1},
		{d800, "一", 1},
		{d800, "a", 1},
		{d800, "", 1},
		{"x" + d800, "x�", -1},
		{d800 + d800, d800, 1},
		{dc00 + d800, d800, 1},
	} {
		if got := Compare(tc.a, tc.b); got != tc.want {
			t.Errorf("Compare(%x, %x) = %d, Node %d", tc.a, tc.b, got, tc.want)
		}
	}
}
