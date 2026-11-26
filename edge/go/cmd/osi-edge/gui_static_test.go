package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestGUIRejectsSymlinkOutsideRoot(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "gui")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(parent, "outside.html")
	if err := os.WriteFile(outside, []byte("outside"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape.html")); err != nil {
		t.Fatal(err)
	}
	b := &backend{guiDir: dir}
	res := httptest.NewRecorder()
	b.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/gui/escape.html", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("symlink escape returned %d: %s", res.Code, res.Body.String())
	}
}
