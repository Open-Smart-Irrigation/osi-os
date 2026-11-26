package main

import (
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsvalue"
)

// Route table. Each area registers its routes from its own file in an init
// function, so parallel ports do not edit a shared switch:
//
//	func init() { register("GET", "/api/devices/:deveui", (*backend).getDevice) }
//
// Matching follows Express as Node-RED configures it: case-insensitive, an
// optional trailing slash, and ":name" segments that match one non-empty
// path segment, URL-decoded.
type params map[string]string

type handlerFunc func(b *backend, w http.ResponseWriter, r *http.Request, p params, body httpbody.Body)

type conversionCatch func(http.ResponseWriter, *jsvalue.JSError)

type route struct {
	method   string
	segments []string
	handler  handlerFunc
	catch    conversionCatch
}

var routes []route

func register(method, pattern string, handler handlerFunc) {
	registerWithCatch(method, pattern, handler, deviceCoercionCatch)
}

func registerWithCatch(method, pattern string, handler handlerFunc, catch conversionCatch) {
	routes = append(routes, route{method: method, segments: split(pattern), handler: handler, catch: catch})
}

// Express matches the original path component, including its escape spelling.
func requestTargetPath(r *http.Request) string {
	if strings.HasPrefix(r.RequestURI, "/") {
		path, _, _ := strings.Cut(r.RequestURI, "?")
		return path
	}
	return r.URL.EscapedPath()
}

func split(path string) []string {
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(strings.TrimPrefix(path, "/"), "/")
}

// matches compares the escaped segments before decoding any captures, as
// path-to-regexp does. An invalid capture on a different path is irrelevant.
func (rt route) matches(segments []string) bool {
	if len(segments) != len(rt.segments) {
		return false
	}
	for i, want := range rt.segments {
		got := segments[i]
		if strings.HasPrefix(want, ":") {
			if got == "" {
				return false
			}
			continue
		}
		// All route literals are ASCII. Reject non-ASCII simple case folds.
		if len(want) != len(got) || !strings.EqualFold(want, got) {
			return false
		}
	}
	return true
}

func (rt route) params(segments []string) (params, string, bool) {
	var p params
	for i, want := range rt.segments {
		if !strings.HasPrefix(want, ":") {
			continue
		}
		got := segments[i]
		value, err := url.PathUnescape(got)
		if err != nil || !utf8.ValidString(value) {
			return nil, got, false
		}
		if p == nil {
			p = params{}
		}
		p[want[1:]] = value
	}
	return p, "", true
}

// lookup matches an escaped path and returns any malformed parameter that
// Express would encounter while walking its matching layers.
func lookup(method, path string) (*route, params, string, string) {
	segments := split(path)
	var allow []string
	seen := map[string]bool{}
	for i := range routes {
		rt := &routes[i]
		if !rt.matches(segments) {
			continue
		}
		p, malformed, valid := rt.params(segments)
		if !valid {
			return nil, nil, "", malformed
		}
		if rt.method == method || (method == "HEAD" && rt.method == "GET") {
			return rt, p, "", ""
		}
		if !seen[rt.method] {
			seen[rt.method] = true
			allow = append(allow, rt.method)
			if rt.method == "GET" && !seen["HEAD"] {
				seen["HEAD"] = true
				allow = append(allow, "HEAD")
			}
		}
	}
	return nil, nil, strings.Join(allow, ","), ""
}
