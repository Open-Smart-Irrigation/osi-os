package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsvalue"
)

func TestRouteMatchesBeforeItDecodesParameters(t *testing.T) {
	cases := []struct {
		path      string
		param     string
		wantMatch bool
		wantBad   bool
	}{
		{"/api/irrigation-zones/%2531/name", "%31", true, false},
		{"/api/irrigation-zones/%31/name", "1", true, false},
		{"/api/irrigation-zones/1%2F2/name", "1/2", true, false},
		{"/api/irrigation-zones/1+2/name", "1+2", true, false},
		{"/api/irrigation-zones/%25ZZ/name", "%ZZ", true, false},
		{"/api/irrigation-zones/%ZZ/name", "", false, true},
		{"/api/irrigation-zones/%ED%A0%80/name", "", false, true},
		{"/api/irrigation-zones/%ZZ/unknown", "", false, false},
		{"/api/%69rrigation-zones/1/name", "", false, false},
		{"/api/irrigation-zoneſ/1/name", "", false, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPut, "/", nil)
		r.RequestURI = c.path + "?q=a"
		rt, args, _, malformed := lookup(r.Method, requestTargetPath(r))
		if (rt != nil) != c.wantMatch || (malformed != "") != c.wantBad || args["id"] != c.param {
			t.Errorf("%s: match=%t params=%v malformed=%q", c.path, rt != nil, args, malformed)
		}
	}
}

func TestHTTPConversionCatchPreservesEarlierWrite(t *testing.T) {
	db, err := openDB(copySeed(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	const path = "/__test/conversion-catch"
	initialRoutes := routes
	t.Cleanup(func() { routes = initialRoutes })
	register(http.MethodPost, path, func(b *backend, w http.ResponseWriter, r *http.Request, _ params, _ httpbody.Body) {
		if _, err := b.db.ExecContext(r.Context(), "CREATE TABLE before_conversion (id INTEGER)"); err != nil {
			t.Fatal(err)
		}
		jsvalue.Obj(jsvalue.Property("toString", jsvalue.Nil())).MustNumber()
		t.Error("handler continued after conversion error")
	})

	w := httptest.NewRecorder()
	b := &backend{db: db}
	b.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, nil))
	if w.Code != 500 || w.Body.String() != `{"error":"device-api failed","message":"TypeError: Cannot convert object to primitive value"}` {
		t.Errorf("response = %d %s", w.Code, w.Body.String())
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='before_conversion'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("write preceding throw: count=%d, err=%v", count, err)
	}
}
