package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestProductionUsesJavaScriptConversions(t *testing.T) {
	root := filepath.Clean("../..")
	// The allowlist covers ASCII protocol tokens. Every Value conversion in
	// production uses the throwing API, so there is no dataflow inference.
	allow := map[string]struct {
		count  int
		reason string
	}{
		"internal/httpbody/body.go:contentType":     {3, "MIME media types, charset labels, and the charset parameter name are protocol tokens"},
		"internal/httpbody/body.go:readEncoded":     {1, "HTTP content-encoding is a protocol token"},
		"internal/jstimezone/timezone.go:<package>": {1, "IANA IDs in the embedded table are ASCII"},
		"internal/jstimezone/timezone.go:Canonical": {1, "IANA IDs are matched in the case-insensitive registry"},
		"cmd/osi-edge/routes.go:matches":            {1, "Equal byte lengths constrain comparisons to ASCII route literals"},
		"cmd/osi-edge/login.go:authRoute":           {1, "Only ASCII-matched router paths reach the auth dispatcher"},
	}
	used := make(map[string]int)
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		stringsName := ""
		for _, spec := range file.Imports {
			importPath, _ := strconv.Unquote(spec.Path.Value)
			if importPath == "strings" {
				stringsName = "strings"
				if spec.Name != nil {
					stringsName = spec.Name.Name
				}
			}
		}
		for _, decl := range file.Decls {
			funcName := "<package>"
			if fn, ok := decl.(*ast.FuncDecl); ok {
				funcName = fn.Name.Name
			}
			key := filepath.ToSlash(rel) + ":" + funcName
			ast.Inspect(decl, func(node ast.Node) bool {
				switch value := node.(type) {
				case *ast.SelectorExpr:
					switch value.Sel.Name {
					case "ToString", "ToNumber", "StringThrows":
						t.Errorf("%s uses %s. Use a throwing jsvalue conversion", fset.Position(value.Pos()), value.Sel.Name)
					case "ToUpper", "ToLower", "EqualFold":
						if name, ok := value.X.(*ast.Ident); ok && name.Name == stringsName {
							used[key]++
							if _, ok := allow[key]; !ok {
								t.Errorf("%s uses strings.%s. Use jsvalue.Upper or jsvalue.Lower", fset.Position(value.Pos()), value.Sel.Name)
							}
						}
					}
				case *ast.Ident:
					if stringsName == "." && (value.Name == "ToUpper" || value.Name == "ToLower" || value.Name == "EqualFold") {
						t.Errorf("%s uses a dot-imported casing method", fset.Position(value.Pos()))
					}
				}
				return true
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for key, item := range allow {
		if used[key] != item.count {
			t.Errorf("%s has %d casing exceptions, expected %d (%s)", key, used[key], item.count, item.reason)
		}
	}
}
