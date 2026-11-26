package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"osi-edge/internal/jsvalue"
)

// Extension and charset mappings from send 0.19.0's mime 1.6.0.
//
//go:embed gui_mime_types.json
var guiMIMEData []byte

var guiMIMETypes = func() map[string]string {
	var types map[string]string
	if err := json.Unmarshal(guiMIMEData, &types); err != nil {
		panic(err)
	}
	return types
}()

// serveGUI matches the Express mount against the escaped request path.
func (b *backend) serveGUI(w http.ResponseWriter, r *http.Request) bool {
	target := requestTargetPath(r)
	if len(target) < 4 || jsvalue.Lower(target[:4]) != "/gui" ||
		(len(target) > 4 && target[4] != '/') {
		return false
	}
	w.Header().Set("X-Powered-By", "Express")
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && b.guiDir != "" {
		if serveGUIFile(w, r, b.guiDir, target) {
			return true
		}
	}
	guiHTML(w, r, http.StatusNotFound, "Error", "Cannot "+r.Method+" "+target)
	return true
}

func serveGUIFile(w http.ResponseWriter, r *http.Request, dir, target string) bool {
	raw := target[4:]
	decoded, err := url.PathUnescape(raw)
	if err != nil || !utf8.ValidString(decoded) || strings.ContainsRune(decoded, 0) {
		return false
	}
	name := path.Clean("." + "/" + decoded)
	for _, segment := range strings.Split(name, "/") {
		if segment != "." && strings.HasPrefix(segment, ".") {
			return false
		}
	}

	// Resolve the deployment's active GUI root on each request. Root confines
	// subsequent filesystem operations even when entries are symlinks.
	root, err := os.OpenRoot(dir)
	if err != nil {
		return false
	}
	defer root.Close()

	if strings.HasSuffix(raw, "/") {
		name = path.Join(name, "index.html")
	}
	stat, err := root.Stat(name)
	if err != nil {
		return false
	}
	if stat.IsDir() {
		if strings.HasSuffix(raw, "/") {
			return false
		}
		location := target + "/"
		if _, query, ok := strings.Cut(r.RequestURI, "?"); ok {
			location += "?" + query
		}
		w.Header().Set("Location", location)
		guiHTML(w, r, http.StatusMovedPermanently, "Redirecting", "Redirecting to "+location)
		return true
	}
	if !stat.Mode().IsRegular() {
		return false
	}
	file, err := root.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	stat, err = file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		return false
	}
	sendGUIFile(w, r, name, file, stat)
	return true
}

func sendGUIFile(w http.ResponseWriter, r *http.Request, name string, file *os.File, stat os.FileInfo) {
	h := w.Header()
	size := stat.Size()
	modified := stat.ModTime().UTC().Truncate(time.Second)
	etag := fmt.Sprintf(`W/"%x-%x"`, size, stat.ModTime().UnixMilli())
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "public, max-age=0")
	h.Set("Last-Modified", modified.Format(http.TimeFormat))
	h.Set("ETag", etag)

	match := r.Header.Get("If-Match")
	if match != "" && !guiETagMatches(match, etag) ||
		match == "" && guiDateBefore(r.Header.Get("If-Unmodified-Since"), modified) {
		guiHTML(w, r, http.StatusPreconditionFailed, "Error", "Precondition Failed")
		return
	}
	noneMatch := r.Header.Get("If-None-Match")
	since, dateErr := http.ParseTime(r.Header.Get("If-Modified-Since"))
	freshDate := dateErr == nil && !modified.After(since)
	if !guiNoCache(r.Header.Get("Cache-Control")) &&
		(noneMatch == "" || guiETagMatches(noneMatch, etag)) &&
		(r.Header.Get("If-Modified-Since") == "" || freshDate) &&
		(noneMatch != "" || freshDate) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	status, start, length := http.StatusOK, int64(0), size
	if guiRangeFresh(r.Header.Get("If-Range"), etag, modified) {
		selected, unsatisfiable := guiRanges(r.Header.Get("Range"), size)
		if unsatisfiable {
			h.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			guiHTML(w, r, http.StatusRequestedRangeNotSatisfiable, "Error", "Range Not Satisfiable")
			return
		}
		if len(selected) == 1 {
			span := selected[0]
			status, start, length = http.StatusPartialContent, span.start, span.end-span.start+1
			h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", span.start, span.end, size))
		}
	}
	// mime 1.x looks after the last dot or path separator.
	extension := name[strings.LastIndexAny(name, "./\\")+1:]
	contentType := guiMIMETypes["."+jsvalue.Lower(extension)]
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, io.NewSectionReader(file, start, length))
	}
}

func guiDateBefore(value string, modified time.Time) bool {
	date, err := http.ParseTime(value)
	return err == nil && date.Before(modified)
}

func guiRangeFresh(value, etag string, modified time.Time) bool {
	if value == "" {
		return true
	}
	if strings.Contains(value, `"`) {
		return strings.Contains(value, etag)
	}
	date, err := http.ParseTime(value)
	return err == nil && !date.Before(modified)
}

func guiETagMatches(value, etag string) bool {
	if value == "*" {
		return true
	}
	for _, token := range strings.Split(value, ",") {
		if strings.TrimPrefix(strings.TrimSpace(token), "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

func guiNoCache(value string) bool {
	for _, directive := range strings.Split(value, ",") {
		if strings.TrimSpace(directive) == "no-cache" {
			return true
		}
	}
	return false
}

func guiHTML(w http.ResponseWriter, r *http.Request, status int, title, message string) {
	escaped := strings.ReplaceAll(html.EscapeString(message), "&#34;", "&quot;")
	body := "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>" +
		title + "</title>\n</head>\n<body>\n<pre>" + escaped + "</pre>\n</body>\n</html>\n"
	h := w.Header()
	charset := "utf-8"
	if status == http.StatusMovedPermanently {
		charset = "UTF-8"
	}
	h.Set("Content-Type", "text/html; charset="+charset)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("Content-Security-Policy", "default-src 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, body)
	}
}
