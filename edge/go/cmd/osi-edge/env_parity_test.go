package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The variables the Go code reads, against what the osi-edge init exports,
// what node-red.init exports and what settings.js loads from .chirpstack.env.
// A variable Node-RED gets from its init that the edge init does not export
// is the review r2 blocker class (ID-only uplinks misrouted).
func TestEnvParityWithNodeRed(t *testing.T) {
	reads := goEnvReads(t, "../../cmd/osi-edge", "../../internal")
	nodeRedInit := readRepoFile(t, "../../../../feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init")
	edgeInitPath := "../../../package/files/etc/init.d/osi-edge"
	if override := os.Getenv("OSI_EDGE_PARITY_INIT"); override != "" {
		edgeInitPath = override // proves the test against an older init
	}
	edgeInit := readRepoFile(t, edgeInitPath)
	nodeRed, edge := procdEnvNames(t, nodeRedInit), procdEnvNames(t, edgeInit)

	settings := readRepoFile(t, "../../../../feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js")
	protected := jsSetLiteral(t, settings, "protectedKeys")
	for key := range protected {
		if !nodeRedEnvProtected[key] {
			t.Errorf("settings.js protects %s; loadNodeRedEnvFile does not", key)
		}
	}
	for key := range nodeRedEnvProtected {
		if !protected[key] {
			t.Errorf("loadNodeRedEnvFile protects %s; settings.js does not", key)
		}
	}
	bootstrap := readRepoFile(t, "../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js")
	envFile := jsObjectKeys(t, bootstrap, "const envVars = {")

	edgeOwn := map[string]bool{"OSI_EDGE_DB": true, "OSI_EDGE_HTTP_ADDR": true, "OSI_EDGE_MQTT_URL": true}
	unsetOnDevice := map[string]string{
		"OSI_EDGE_GUI_DIR":                "optional static root override; the device uses /usr/lib/node-red/gui by default",
		"OSI_EDGE_TEST_HOOKS":             "T1 harness seam",
		"OSI_EDGE_TEST_NONCE":             "T1 harness seam",
		"OSI_EDGE_DB_WATCHDOG":            "deadlock detector for replays; off on a device",
		"OSI_EDGE_PROC_ROOT":              "test seam for the backend selection",
		"OSI_EDGE_DATA_ROOT":              "test seam for device paths",
		"GATEWAY_DEVICE_EUI":              "a Node-RED fallback name; neither init sets it",
		"AUTH_TOKEN_SECRET":               "neither init sets it; both use the secret file",
		"JWT_SECRET":                      "neither init sets it; both use the secret file",
		"OSI_CHIRPSTACK_GRPC_DEADLINE_MS": "osi-chirpstack-helper tunable; neither init sets it",
		"TZ":                              "neither init sets it; the zone comes from /etc/TZ",
	}

	var gaps, extras, sourceless []string
	for name := range reads {
		switch {
		case nodeRed[name]:
			if !edge[name] {
				gaps = append(gaps, name)
			}
		case edgeOwn[name]:
			if !edge[name] {
				gaps = append(gaps, name)
			}
		case envFile[name] && !protected[name]:
			// Delivered by loadNodeRedEnvFile, as settings.js delivers it.
		case unsetOnDevice[name] != "":
			if edge[name] || nodeRed[name] {
				t.Errorf("%s is allowlisted as unset on a device, but an init exports it", name)
			}
		default:
			sourceless = append(sourceless, name)
		}
	}
	for name := range edge {
		if !nodeRed[name] && !edgeOwn[name] {
			extras = append(extras, name)
		}
	}
	slices.Sort(gaps)
	slices.Sort(extras)
	slices.Sort(sourceless)
	if len(gaps) > 0 {
		t.Errorf("node-red.init exports these variables the Go code reads; the osi-edge init does not: %s", strings.Join(gaps, ", "))
	}
	if len(extras) > 0 {
		t.Errorf("the osi-edge init exports variables node-red.init does not: %s", strings.Join(extras, ", "))
	}
	if len(sourceless) > 0 {
		t.Errorf("the Go code reads variables with no source on a device: %s", strings.Join(sourceless, ", "))
	}

	// Shared ChirpStack ids come from the same UCI key and env-file key.
	nodeRedSources, edgeSources := chirpstackSources(nodeRedInit), chirpstackSources(edgeInit)
	for name, source := range nodeRedSources {
		if reads[name] && edge[name] && edgeSources[name] != source {
			t.Errorf("%s: node-red.init resolves %q, osi-edge init %q", name, source, edgeSources[name])
		}
	}
	for _, required := range []string{"CHIRPSTACK_PROFILE_LSN50", "CHIRPSTACK_PROFILE_SDI12", "CHIRPSTACK_PROFILE_STREGA", "CHIRPSTACK_PROFILE_STREGA_GEN2", "CHIRPSTACK_API_URL"} {
		if !reads[required] {
			t.Errorf("the scan did not find %s; the scanner lost a read path", required)
		}
	}
}

func readRepoFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

var procdEnvLine = regexp.MustCompile(`^\s*([A-Z][A-Z0-9_]*)=`)

// procdEnvNames lists the NAME=value items of the `procd_set_param env \`
// continuation block.
func procdEnvNames(t *testing.T, script string) map[string]bool {
	t.Helper()
	names := map[string]bool{}
	lines := strings.Split(script, "\n")
	for i, line := range lines {
		if strings.TrimSpace(line) != `procd_set_param env \` {
			continue
		}
		for _, item := range lines[i+1:] {
			m := procdEnvLine.FindStringSubmatch(item)
			if m == nil {
				t.Fatalf("unexpected line in procd env block: %q", item)
			}
			names[m[1]] = true
			if !strings.HasSuffix(strings.TrimSpace(item), `\`) {
				break
			}
		}
	}
	if len(names) == 0 {
		t.Fatal("no procd env block found")
	}
	return names
}

var resolveLine = regexp.MustCompile(`resolve_chirpstack_value (osi-server\.cloud\.[a-z0-9_]+) ([A-Z][A-Z0-9_]*)\)`)

func chirpstackSources(script string) map[string]string {
	sources := map[string]string{}
	for _, m := range resolveLine.FindAllStringSubmatch(script, -1) {
		sources[m[2]] = m[1]
	}
	return sources
}

var jsKey = regexp.MustCompile(`^\s*'?([A-Z][A-Z0-9_]*)'?\s*[:,]`)

func jsSetLiteral(t *testing.T, source, name string) map[string]bool {
	t.Helper()
	start := strings.Index(source, name+" = new Set([")
	if start < 0 {
		t.Fatalf("%s not found", name)
	}
	body := source[start:]
	body = body[strings.Index(body, "[")+1 : strings.Index(body, "])")]
	keys := map[string]bool{}
	for _, part := range strings.Split(body, ",") {
		if key := strings.Trim(strings.TrimSpace(part), `'"`); key != "" {
			keys[key] = true
		}
	}
	return keys
}

func jsObjectKeys(t *testing.T, source, opener string) map[string]bool {
	t.Helper()
	start := strings.Index(source, opener)
	if start < 0 {
		t.Fatalf("%q not found", opener)
	}
	body := source[start+len(opener):]
	body = body[:strings.Index(body, "};")]
	keys := map[string]bool{}
	for _, line := range strings.Split(body, "\n") {
		if m := jsKey.FindStringSubmatch(line); m != nil {
			keys[m[1]] = true
		}
	}
	if len(keys) == 0 {
		t.Fatalf("no keys after %q", opener)
	}
	return keys
}

// goEnvReads finds every variable name the non-test Go code passes to
// os.Getenv or os.LookupEnv: literal arguments, string literals assigned to
// a local key variable, and literal arguments at the call sites of helpers
// that pass a parameter through. Anything else fails the test.
func goEnvReads(t *testing.T, roots ...string) map[string]bool {
	t.Helper()
	type passThrough struct {
		param    int
		variadic bool
	}
	var files []*ast.File
	fset := token.NewFileSet()
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			file, err := parser.ParseFile(fset, path, nil, 0)
			if err == nil {
				files = append(files, file)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	reads := map[string]bool{}
	helpers := map[string]passThrough{} // function name -> parameter passed on
	literal := func(expr ast.Expr) (string, bool) {
		lit, ok := expr.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return "", false
		}
		value, err := strconv.Unquote(lit.Value)
		return value, err == nil
	}
	for _, file := range files {
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Name.Name == "loadNodeRedEnvFile" {
				// The settings.js port copies arbitrary file keys.
				continue
			}
			params := map[*ast.Object]passThrough{}
			index := 0
			for _, field := range fn.Type.Params.List {
				_, variadic := field.Type.(*ast.Ellipsis)
				for _, name := range field.Names {
					params[name.Obj] = passThrough{index, variadic}
					index++
				}
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) == 0 {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != "os" || (sel.Sel.Name != "Getenv" && sel.Sel.Name != "LookupEnv") {
					return true
				}
				if name, ok := literal(call.Args[0]); ok {
					reads[name] = true
					return true
				}
				ident, ok := call.Args[0].(*ast.Ident)
				if !ok || ident.Obj == nil {
					t.Errorf("%s: unresolved os.%s argument", fset.Position(call.Pos()), sel.Sel.Name)
					return true
				}
				if p, ok := params[ident.Obj]; ok {
					helpers[fn.Name.Name] = p
					return true
				}
				// for _, key := range param
				if assign, ok := ident.Obj.Decl.(*ast.AssignStmt); ok && len(assign.Rhs) == 1 {
					if unary, ok := assign.Rhs[0].(*ast.UnaryExpr); ok && unary.Op == token.RANGE {
						if src, ok := unary.X.(*ast.Ident); ok && src.Obj != nil {
							if p, ok := params[src.Obj]; ok {
								helpers[fn.Name.Name] = p
								return true
							}
						}
					}
				}
				// var key string; key = "..." in a switch
				found := false
				ast.Inspect(fn.Body, func(m ast.Node) bool {
					assign, ok := m.(*ast.AssignStmt)
					if !ok {
						return true
					}
					for i, lhs := range assign.Lhs {
						if id, ok := lhs.(*ast.Ident); ok && id.Obj == ident.Obj && i < len(assign.Rhs) {
							if name, ok := literal(assign.Rhs[i]); ok {
								reads[name] = true
								found = true
							} else {
								t.Errorf("%s: %s is assigned a non-literal", fset.Position(assign.Pos()), id.Name)
							}
						}
					}
					return true
				})
				if !found {
					t.Errorf("%s: unresolved os.%s(%s)", fset.Position(call.Pos()), sel.Sel.Name, ident.Name)
				}
				return true
			})
		}
	}
	// Call sites of the pass-through helpers.
	for _, file := range files {
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			ident, ok := call.Fun.(*ast.Ident)
			if !ok {
				return true
			}
			helper, ok := helpers[ident.Name]
			if !ok {
				return true
			}
			args := call.Args[min(helper.param, len(call.Args)):]
			if !helper.variadic && len(args) > 0 {
				args = args[:1]
			}
			for _, arg := range args {
				if name, ok := literal(arg); ok {
					reads[name] = true
				} else {
					t.Errorf("%s: %s gets a non-literal variable name", fset.Position(arg.Pos()), ident.Name)
				}
			}
			return true
		})
	}
	return reads
}
