package jsvalue

import "testing"

// String.prototype.trim strips ECMAScript WhiteSpace and LineTerminator:
// these 25 code points and no other (checked against Node 22 over the BMP in
// confirm-B2's trim sweep). U+0085 and U+180E stay; strings.TrimSpace strips
// U+0085 and keeps U+FEFF, which is why the effect paths use Trim.
func TestTrimMatchesStringPrototypeTrim(t *testing.T) {
	js := map[rune]bool{}
	for _, r := range []rune{0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
		0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff} {
		js[r] = true
	}
	for r := rune(0); r <= 0xffff; r++ {
		if r >= 0xd800 && r <= 0xdfff {
			continue
		}
		s := string(r) + "x" + string(r)
		trimmed := Trim(s) == "x"
		if trimmed != js[r] {
			t.Errorf("U+%04X: Trim strips it = %v, String.prototype.trim strips it = %v", r, trimmed, js[r])
		}
	}
}
