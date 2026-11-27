package httpbody

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osi-edge/internal/jsvalue"
)

// TestContentTypeVectors checks the parse decision, the charset and the raw
// parser's outcome against edge/vectors/content-type.vectors.json, which runs
// the type-is, content-type and media-typer modules shipped with Node-RED.
func TestContentTypeVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "vectors", "content-type.vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []struct {
			Hex     string  `json:"hex"`
			JSON    bool    `json:"json"`
			Form    bool    `json:"form"`
			Charset *string `json:"charset"`
			Raw     string  `json:"raw"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Vectors) < 1000 {
		t.Fatalf("only %d vectors", len(file.Vectors))
	}
	for _, v := range file.Vectors {
		raw, err := hex.DecodeString(v.Hex)
		if err != nil {
			t.Fatal(err)
		}
		header := jsvalue.Latin1(string(raw))
		decision := typeIs(header)
		var charset *string
		if _, value, err := contentType(header); err == nil {
			charset = &value
		}
		rawKind := "error"
		if mediaType, err := rawMediaType(header); err == nil {
			rawKind = rawClass(mediaType)
		}
		if decision == "application/json" != v.JSON || decision == "application/x-www-form-urlencoded" != v.Form ||
			(charset == nil) != (v.Charset == nil) || charset != nil && *charset != *v.Charset || rawKind != v.Raw {
			got := "<nil>"
			if charset != nil {
				got = *charset
			}
			t.Errorf("%q: got decision %q charset %s raw %s; want json=%v form=%v charset=%v raw=%s",
				header, decision, got, rawKind, v.JSON, v.Form, deref(v.Charset), v.Raw)
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// rawClass mirrors parseRaw's choice before it reads the body.
func rawClass(mediaType string) string {
	kind, subtype, _ := strings.Cut(mediaType, "/")
	suffix := ""
	if i := strings.LastIndexByte(subtype, '+'); i >= 0 {
		subtype, suffix = subtype[:i], subtype[i+1:]
	}
	switch {
	case kind == "text" || subtype == "xml" || suffix == "xml":
		return "text"
	case kind != "application", subtype == "octet-stream", subtype == "cbor", subtype == "x-protobuf":
		return "binary"
	}
	return "checkutf"
}
