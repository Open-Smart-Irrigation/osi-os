package httpbody

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"

	"osi-edge/internal/jsvalue"
)

func TestParseBody(t *testing.T) {
	const jsonType = "application/json"
	const formType = "application/x-www-form-urlencoded"
	utf16JSON := func(order binary.AppendByteOrder, text string) string {
		var data []byte
		for _, unit := range utf16.Encode([]rune(text)) {
			data = order.AppendUint16(data, unit)
		}
		return string(data)
	}
	deflate := compressBody(t, zlib.NewWriter, "a[]=x&a[]=y")
	gzipJSON := compressBody(t, gzip.NewWriter, `{"x":`) + compressBody(t, gzip.NewWriter, `1}`) + "\x00\x00"

	for _, tc := range []struct {
		name, mediaType, encoding, input, want string
	}{
		{name: "strict primitive", mediaType: jsonType, input: "null"},
		{name: "compressed concatenated JSON and padding", mediaType: jsonType, encoding: "GZIP", input: gzipJSON, want: `{"x":1}`},
		{name: "bad gzip checksum or trailer", mediaType: jsonType, encoding: "gzip", input: strings.TrimRight(gzipJSON, "\x00") + "x"},
		{name: "deflated form", mediaType: formType, encoding: "deflate", input: deflate, want: `{"a":["x","y"]}`},
		{name: "unsupported content coding", mediaType: jsonType, encoding: "br", input: "{}"},
		{name: "limit after inflation", mediaType: jsonType, encoding: "gzip", input: compressBody(t, gzip.NewWriter, strings.Repeat(" ", maxBody)+"{}")},
		{name: "charset named twice", mediaType: jsonType + `; charset=ascii; CHARSET="UTF-8"`, input: "\ufeff{}", want: `{}`},
		{name: "json decoded malformed bytes", mediaType: jsonType, input: "[\"\xe2\x82\xff\"]", want: `["��"]`},
		{name: "UTF16 LE with unpaired surrogate", mediaType: jsonType + "; charset=utf-16", input: utf16JSON(binary.LittleEndian, "\ufeff[\"") + "\x00\xd8" + utf16JSON(binary.LittleEndian, "\"]"), want: `["\ud800"]`},
		{name: "UTF16 BE without BOM", mediaType: jsonType + "; charset=utf-16", input: utf16JSON(binary.BigEndian, `{"name":"八"}`), want: `{"name":"八"}`},
		{name: "UTF7 JSON", mediaType: jsonType + "; charset=utf-7", input: `{"name":"+AKM-"}`, want: `{"name":"£"}`},
		{name: "unknown utf charset", mediaType: jsonType + "; charset=utf-32", input: "{}"},
		{name: "UTF8 alias rejected on form", mediaType: formType + "; charset=utf8", input: "a=1"},
		{name: "form nested arrays and duplicates", mediaType: formType, input: "a[2]=z&a%5B%5D=x&a[]=y&b[c]=1&b[c]=2&b[d][]=%&b[d][]=hi+there", want: `{"a":["x","y","z"],"b":{"c":["1","2"],"d":["%","hi there"]}}`},
		{name: "form mixed object after scalar", mediaType: formType, input: "a=x&a[b]=y", want: `{"a":["x",{"b":"y"}]}`},
		{name: "form scalar after mixed object", mediaType: formType, input: "a[b]=y&a=x", want: `{"a":{"b":"y","x":true}}`},
		{name: "form array indices and object keys", mediaType: formType, input: "a[100]=x&a[101]=y&a[01]=z", want: `{"a":{"100":"x","101":"y","01":"z"}}`},
		{name: "form prototype key", mediaType: formType, input: "a[__proto__][x]=y&a[constructor]=z", want: `{"a":{"constructor":"z"}}`},
		{name: "form parameter limit", mediaType: formType, input: strings.Repeat("a=x&", 1000)},
		{name: "form depth limit", mediaType: formType, input: "a" + strings.Repeat("[a]", 33) + "=x"},
		{name: "vendor JSON uses raw fallback", mediaType: "application/vnd.osi+json", input: "{}", want: `"{}"`},
		{name: "raw text ignores encoding and charset", mediaType: "text/plain; charset=ascii", encoding: "br", input: "\ufeffabc", want: `"abc"`},
		{name: "invalid content type", mediaType: "text/plain;", input: "abc"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(tc.input))
			r.Header.Set("Content-Type", tc.mediaType)
			r.Header.Set("Content-Encoding", tc.encoding)
			got, err := Parse(r)
			if tc.want == "" {
				if err == nil {
					t.Fatal("expected parser error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			serialized, err := jsvalue.Stringify(got.Value)
			if err != nil || string(serialized) != tc.want {
				t.Errorf("body = %s, %v, want %s", serialized, err, tc.want)
			}
		})
	}
}

func TestRawBinaryAndBodylessRoutes(t *testing.T) {
	input := []byte{0x00, 0xff, 0x01}
	req := httptest.NewRequest(http.MethodPatch, "/", bytes.NewReader(input))
	req.Header.Set("Content-Type", "application/octet-stream")
	body, err := Parse(req)
	if err != nil || !bytes.Equal(body.Buffer, input) || body.Value.Kind != jsvalue.Undefined {
		t.Fatalf("raw buffer = %+v, %v", body, err)
	}

	req = httptest.NewRequest(http.MethodGet, "/", bytes.NewReader(input))
	req.Header.Set("Content-Type", "malformed")
	body, err = Parse(req)
	if err != nil || body.Buffer != nil || body.Value.Kind != jsvalue.Undefined {
		t.Fatalf("GET body = %+v, %v", body, err)
	}
}

func compressBody[W io.WriteCloser](t *testing.T, newWriter func(io.Writer) W, text string) string {
	t.Helper()
	var data bytes.Buffer
	w := newWriter(&data)
	if _, err := io.WriteString(w, text); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return data.String()
}
