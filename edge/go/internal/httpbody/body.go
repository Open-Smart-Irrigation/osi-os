// Package httpbody implements the Node-RED HTTP In body parser shared by the
// edge's routes. Transport errors are returned to the route dispatcher.
package httpbody

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"osi-edge/internal/jsvalue"
)

// Body carries req.body. Raw binary payloads use Buffer; all other payloads
// (including text and the absent body on GET and HEAD) use Value.
type Body struct {
	Value  jsvalue.Value
	Buffer []byte
}

const maxBody = 5 * 1024 * 1024

var (
	// content-type 1.0.5 (body-parser's charset and the http-in raw parser).
	tokenTypePattern = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	parameterPattern = regexp.MustCompile("; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *(\"(?:[\\x0b\\x20\\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\x0b\\x20-\\xff])*\"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) *")
	// media-typer 1.1.0 (the http-in raw parser, after content-type).
	mediaTypePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$`)
	// media-typer 0.3.0 (type-is 1.6.18, which decides whether body-parser
	// parses JSON or a form): spaces only around the type, quoted-pair
	// \x20-\x7e, no \x0b in quoted text.
	typerTypePattern    = regexp.MustCompile(`^ *([a-z0-9][a-z0-9!#$&^_-]{0,126})/([a-z0-9][a-z0-9!#$&^_.+-]{0,126}) *$`)
	typerParamPattern   = regexp.MustCompile("; *([!#$%&'*+\\-.0-9A-Z^_`a-z|~]+) *= *(\"(?:[ !\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\x20-\\x7e])*\"|[!#$%&'*+\\-.0-9A-Z^_`a-z|~]+) *")
	typerSubtypePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.-]{0,126}$`)
	typerNamePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_-]{0,126}$`)
)

func Parse(r *http.Request) (Body, error) {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return Body{}, nil
	}
	// Node decodes header bytes as latin1 code units.
	header := jsvalue.Latin1(r.Header.Get("Content-Type"))
	stream := r.Body
	if stream == nil {
		stream = http.NoBody
	}
	hasBody := len(r.TransferEncoding) != 0 || r.ContentLength != 0 || r.Header.Get("Content-Length") != ""
	decision := ""
	if hasBody {
		decision = typeIs(header)
	}
	isForm := decision == "application/x-www-form-urlencoded"
	if !isForm && decision != "application/json" {
		mediaType, err := rawMediaType(header)
		if err != nil {
			return Body{}, err
		}
		return parseRaw(stream, mediaType)
	}
	charset := bodyCharset(header)
	if isForm && charset != "utf-8" {
		return Body{}, errors.New("unsupported form charset")
	}
	data, err := readEncoded(stream, strings.Join(r.Header.Values("Content-Encoding"), ", "))
	if err != nil {
		return Body{}, err
	}
	if isForm {
		value, err := parseForm(string(decodeUTF8(data)))
		return Body{Value: value}, err
	}
	data, err = decodeJSONCharset(data, charset)
	if err != nil {
		return Body{}, err
	}
	if len(data) == 0 {
		return Body{Value: jsvalue.Obj()}, nil
	}
	value, err := jsvalue.Parse(data)
	if err == nil && value.Kind != jsvalue.Object && value.Kind != jsvalue.Array {
		err = errors.New("expected JSON object or array")
	}
	return Body{Value: value}, err
}

// typeIs ports type-is 1.6.18 tryNormalizeType over media-typer 0.3.0
// parse and format: the normalized type/subtype[+suffix], or "" where type-is
// answers false and body-parser leaves the body to the raw parser.
func typeIs(header string) string {
	if header == "" {
		return ""
	}
	index := strings.IndexByte(header, ';')
	typePart := header
	if index >= 0 {
		typePart = header[:index]
	}
	match := typerTypePattern.FindStringSubmatch(asciiLower(typePart))
	if match == nil || !parametersMatch(typerParamPattern, header, index, nil) {
		return ""
	}
	subtype, suffix := match[2], ""
	if i := strings.LastIndexByte(subtype, '+'); i >= 0 {
		subtype, suffix = subtype[:i], subtype[i+1:]
	}
	if !typerSubtypePattern.MatchString(subtype) || suffix != "" && !typerNamePattern.MatchString(suffix) {
		return ""
	}
	if suffix != "" {
		subtype += "+" + suffix
	}
	return match[1] + "/" + subtype
}

// bodyCharset is body-parser's getCharset: content-type 1.0.5 inside
// try/catch, so a header that content-type rejects reads as utf-8.
func bodyCharset(header string) string {
	_, charset, err := contentType(header)
	if err != nil || charset == "" {
		return "utf-8"
	}
	return charset
}

// rawMediaType is the http-in raw parser: content-type 1.0.5 parse, then
// media-typer 1.1.0 parse of the type; either one throwing is an error.
func rawMediaType(header string) (string, error) {
	if header == "" {
		return "", nil
	}
	mediaType, _, err := contentType(header)
	if err == nil && !mediaTypePattern.MatchString(mediaType) {
		err = errors.New("invalid Content-Type")
	}
	return mediaType, err
}

// contentType ports content-type 1.0.5 parse over a latin1-decoded header.
// The charset is the last charset parameter, lower-cased, "" when absent.
func contentType(header string) (string, string, error) {
	index := strings.IndexByte(header, ';')
	mediaType := header
	if index >= 0 {
		mediaType = header[:index]
	}
	mediaType = strings.ToLower(jsvalue.Trim(mediaType))
	if !tokenTypePattern.MatchString(mediaType) {
		return "", "", errors.New("invalid media type")
	}
	charset := ""
	ok := parametersMatch(parameterPattern, header, index, func(key, value string) {
		if strings.EqualFold(key, "charset") {
			charset = strings.ToLower(unquoteParameter(value))
		}
	})
	if !ok {
		return "", "", errors.New("invalid parameter format")
	}
	return mediaType, charset, nil
}

// parametersMatch runs a global parameter pattern from the first ";" the way
// both modules do: every match must start where the previous one ended, and
// the matches must reach the end of the header.
func parametersMatch(pattern *regexp.Regexp, header string, index int, visit func(key, value string)) bool {
	if index < 0 {
		return true
	}
	parameters := header[index:]
	end := 0
	for _, match := range pattern.FindAllStringSubmatchIndex(parameters, -1) {
		if match[0] != end {
			return false
		}
		end = match[1]
		if visit != nil {
			visit(parameters[match[2]:match[3]], parameters[match[4]:match[5]])
		}
	}
	return end == len(parameters)
}

func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, s)
}

func unquoteParameter(value string) string {
	if value[0] != '"' {
		return value
	}
	value = value[1 : len(value)-1]
	var result strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' {
			i++
		}
		result.WriteByte(value[i])
	}
	return result.String()
}

func readEncoded(stream io.Reader, encoding string) ([]byte, error) {
	var inflated io.ReadCloser
	var err error
	switch strings.ToLower(encoding) {
	case "", "identity":
	case "gzip":
		return readGzip(stream)
	case "deflate":
		inflated, err = zlib.NewReader(stream)
	default:
		return nil, errors.New("unsupported Content-Encoding")
	}
	if err != nil {
		return nil, err
	}
	if inflated != nil {
		defer inflated.Close()
		stream = inflated
	}
	return readLimited(stream)
}

func readLimited(stream io.Reader) ([]byte, error) {
	var data bytes.Buffer
	if err := copyLimited(&data, stream); err != nil {
		return nil, err
	}
	return data.Bytes(), nil
}

func copyLimited(data *bytes.Buffer, stream io.Reader) error {
	_, err := data.ReadFrom(io.LimitReader(stream, int64(maxBody+1-data.Len())))
	if data.Len() > maxBody {
		return errors.New("request body exceeds Node-RED API limit")
	}
	return err
}

// Node zlib reads concatenated gzip members and stops at the first padding
// NUL after a completed member.
func readGzip(stream io.Reader) ([]byte, error) {
	compressed := bufio.NewReader(stream)
	member, err := gzip.NewReader(compressed)
	if err != nil {
		return nil, err
	}
	defer member.Close()
	var data bytes.Buffer
	for {
		member.Multistream(false)
		if err := copyLimited(&data, member); err != nil {
			return nil, err
		}
		next, err := compressed.Peek(1)
		if errors.Is(err, io.EOF) || (err == nil && next[0] == 0) {
			return data.Bytes(), nil
		}
		if err != nil {
			return nil, err
		}
		if err := member.Reset(compressed); err != nil {
			return nil, err
		}
	}
}

func parseRaw(stream io.Reader, mediaType string) (Body, error) {
	data, err := io.ReadAll(stream)
	if err != nil {
		return Body{}, err
	}
	kind, subtype, _ := strings.Cut(mediaType, "/")
	suffix := ""
	if i := strings.LastIndexByte(subtype, '+'); i >= 0 {
		subtype, suffix = subtype[:i], subtype[i+1:]
	}
	if kind == "" || kind == "text" || subtype == "xml" || suffix == "xml" {
		return Body{Value: jsvalue.Str(string(decodeUTF8(data)))}, nil
	}
	if kind == "application" && subtype != "octet-stream" && subtype != "cbor" &&
		subtype != "x-protobuf" && isNodeREDText(data) {
		return Body{Value: jsvalue.Str(string(data))}, nil
	}
	return Body{Buffer: data}, nil
}

// The http-in raw parser's is-utf8 check also excludes ASCII control bytes
// other than tab, LF and CR when deciding whether to keep a Buffer.
func isNodeREDText(data []byte) bool {
	for _, c := range data {
		if c < 0x20 && c != '\t' && c != '\n' && c != '\r' || c == 0x7f {
			return false
		}
	}
	return utf8.Valid(data)
}

func decodeUTF8(data []byte) []byte {
	return jsvalue.DecodeUTF8(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")))
}
