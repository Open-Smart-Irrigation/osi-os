//go:build ignore

// Generates tables.bin.gz from the CLDR 45 root collation (allkeys_CLDR.txt,
// UCA 15.1) and the Unicode 15.1 character database: the data ICU 75.1, and
// so Node 20.18.3 on the gateway, collates with.
//
//	go run gen_tables.go -src DIR
//
// DIR holds the three files below, checked by SHA-256:
//
//	https://raw.githubusercontent.com/unicode-org/cldr/release-45/common/uca/allkeys_CLDR.txt
//	https://raw.githubusercontent.com/unicode-org/cldr/release-45/common/uca/FractionalUCA.txt
//	https://www.unicode.org/Public/15.1.0/ucd/UnicodeData.txt
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var sources = map[string]string{
	"allkeys_CLDR.txt":  "ded5da6a833352252a2a22ae5e8d39993a1c9ded252cf9491ca5cb3f737f8a5f",
	"UnicodeData.txt":   "2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86",
	"FractionalUCA.txt": "2e4de0ce0ba5d2ffdc128d5c5ec5387719b06a21dc672274a356617e64d027d4",
}

func read(dir, name string) []byte {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != sources[name] {
		panic(name + ": unexpected SHA-256")
	}
	return data
}

func cp(s string) uint32 {
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		panic(err)
	}
	return uint32(v)
}

// Format (little endian), gzip-compressed:
//
//	u32 mapping count; per mapping: u8 code points, u24 each, u8 CEs, (u16 primary, u16 secondary, u8 tertiary) each
//	u32 ccc range count; per range: u24 first, u24 last, u8 ccc
//	u32 decomposition count; per entry: u24 code point, u8 length, u24 each (canonical, one step)
//	u32 Han run count; per run: u24 first, u24 last, in CLDR root (radical-stroke) order
//	u32 run count; per run: u24 first, u24 last: assigned Tangut, Nushu and Khitan code points
func main() {
	src := flag.String("src", "", "directory with the source files")
	flag.Parse()
	var out bytes.Buffer
	u24 := func(v uint32) { out.Write([]byte{byte(v), byte(v >> 8), byte(v >> 16)}) }
	u32 := func(v uint32) { binary.Write(&out, binary.LittleEndian, v) }

	ceRE := regexp.MustCompile(`\[[.*]([0-9A-F]{4})\.([0-9A-F]{4})\.([0-9A-F]{4})\]`)
	var mappings [][]byte
	scanner := bufio.NewScanner(bytes.NewReader(read(*src, "allkeys_CLDR.txt")))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || line[0] == '#' || line[0] == '@' {
			continue
		}
		left, right, ok := strings.Cut(line, ";")
		if !ok {
			panic(line)
		}
		var m bytes.Buffer
		fields := strings.Fields(left)
		m.WriteByte(byte(len(fields)))
		for _, f := range fields {
			v := cp(f)
			m.Write([]byte{byte(v), byte(v >> 8), byte(v >> 16)})
		}
		ces := ceRE.FindAllStringSubmatch(strings.SplitN(right, "#", 2)[0], -1)
		if len(ces) == 0 || len(ces) > 255 {
			panic(line)
		}
		m.WriteByte(byte(len(ces)))
		for _, ce := range ces {
			p, s, t := cp(ce[1]), cp(ce[2]), cp(ce[3])
			if t > 0xff {
				panic(line)
			}
			binary.Write(&m, binary.LittleEndian, uint16(p))
			binary.Write(&m, binary.LittleEndian, uint16(s))
			m.WriteByte(byte(t))
		}
		mappings = append(mappings, m.Bytes())
	}
	u32(uint32(len(mappings)))
	for _, m := range mappings {
		out.Write(m)
	}

	// Canonical combining classes; UnicodeData lists ranges as First/Last pairs (all ccc 0).
	type span struct{ first, last, ccc uint32 }
	var cccs []span
	for _, line := range strings.Split(string(read(*src, "UnicodeData.txt")), "\n") {
		f := strings.Split(line, ";")
		if len(f) < 4 {
			continue
		}
		c, cc := cp(f[0]), uint32(0)
		v, err := strconv.Atoi(f[3])
		if err != nil {
			panic(line)
		}
		cc = uint32(v)
		if cc == 0 {
			continue
		}
		if n := len(cccs); n > 0 && cccs[n-1].last+1 == c && cccs[n-1].ccc == cc {
			cccs[n-1].last = c
		} else {
			cccs = append(cccs, span{c, c, cc})
		}
	}
	u32(uint32(len(cccs)))
	for _, s := range cccs {
		u24(s.first)
		u24(s.last)
		out.WriteByte(byte(s.ccc))
	}

	var decompositions [][]uint32
	for _, line := range strings.Split(string(read(*src, "UnicodeData.txt")), "\n") {
		f := strings.Split(line, ";")
		if len(f) < 6 || f[5] == "" || strings.HasPrefix(f[5], "<") {
			continue
		}
		entry := []uint32{cp(f[0])}
		for _, d := range strings.Fields(f[5]) {
			entry = append(entry, cp(d))
		}
		decompositions = append(decompositions, entry)
	}
	u32(uint32(len(decompositions)))
	for _, e := range decompositions {
		u24(e[0])
		out.WriteByte(byte(len(e) - 1))
		for _, c := range e[1:] {
			u24(c)
		}
	}

	// FractionalUCA's "[radical N=labels:order]" lines list every
	// Unified_Ideograph in the root collation's order; "X-Y" is a range.
	var han []span
	total := 0
	for _, line := range strings.Split(string(read(*src, "FractionalUCA.txt")), "\n") {
		if !strings.HasPrefix(line, "[radical ") || line == "[radical end]" {
			continue
		}
		_, body, ok := strings.Cut(strings.TrimSuffix(line, "]"), ":")
		if !ok {
			panic(line)
		}
		runes := []rune(body)
		for i := 0; i < len(runes); i++ {
			s := span{first: uint32(runes[i]), last: uint32(runes[i])}
			if i+2 < len(runes) && runes[i+1] == '-' {
				s.last = uint32(runes[i+2])
				i += 2
			}
			han = append(han, s)
			total += int(s.last-s.first) + 1
		}
	}
	u32(uint32(len(han)))
	for _, s := range han {
		u24(s.first)
		u24(s.last)
	}

	// ICU gives the Tangut, Nushu and Khitan implicit bases to assigned code
	// points only; unassigned ones in those blocks take the unassigned base.
	var siniform []span
	inBlock := func(c uint32) bool {
		return c >= 0x17000 && c <= 0x18AFF || c >= 0x18D00 && c <= 0x18D8F || c >= 0x1B170 && c <= 0x1B2FF || c >= 0x18B00 && c <= 0x18CFF
	}
	addAssigned := func(first, last uint32) {
		for c := first; c <= last; c++ {
			if !inBlock(c) {
				continue
			}
			if n := len(siniform); n > 0 && siniform[n-1].last+1 == c {
				siniform[n-1].last = c
			} else {
				siniform = append(siniform, span{first: c, last: c})
			}
		}
	}
	var rangeFirst uint32
	for _, line := range strings.Split(string(read(*src, "UnicodeData.txt")), "\n") {
		f := strings.Split(line, ";")
		if len(f) < 2 {
			continue
		}
		c := cp(f[0])
		switch {
		case strings.HasSuffix(f[1], ", First>"):
			rangeFirst = c
		case strings.HasSuffix(f[1], ", Last>"):
			addAssigned(rangeFirst, c)
		default:
			addAssigned(c, c)
		}
	}
	u32(uint32(len(siniform)))
	for _, s := range siniform {
		u24(s.first)
		u24(s.last)
	}

	var z bytes.Buffer
	w, _ := gzip.NewWriterLevel(&z, gzip.BestCompression)
	w.Write(out.Bytes())
	w.Close()
	if err := os.WriteFile("tables.bin.gz", z.Bytes(), 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("%d mappings, %d ccc ranges, %d decompositions, %d Han runs (%d ideographs), %d siniform runs, %d bytes\n",
		len(mappings), len(cccs), len(decompositions), len(han), total, len(siniform), z.Len())
}
