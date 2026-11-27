package main

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/cloudmqtt"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/ingest"
	"osi-edge/internal/jsvalue"
)

type backend struct {
	guiDir    string
	db        *farmDB
	testHooks bool
	ingest    *ingest.Service
	cloud     *cloudmqtt.Client
	writes    sync.RWMutex
	// cloudSequences tracks background cloud publish sequences, so the
	// test settle hook can attribute them to the step that started them.
	cloudSequences     sync.WaitGroup
	secrets            sync.Mutex
	scopes             sync.Map
	valveClockLastTick time.Time
	// One duplicate-uplink guard for every decoder, as Node-RED's
	// osi-uplink-dedup-guard singleton.
	dedup ingest.DedupGuard
}

func (b *backend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var matched *route
	defer func() {
		if problem := recover(); problem != nil {
			if exception, ok := problem.(*jsvalue.JSError); ok && matched != nil {
				log.Printf("HTTP %s conversion: %s", r.Method, exception.Name)
				matched.catch(w, exception)
				return
			}
			log.Printf("HTTP handler panic (%T)", problem)
			sendText(w, 500, "text/plain", "Internal Server Error")
		}
	}()
	if b.testHooks {
		if r.Method == "GET" && r.URL.Path == "/__test/ready" {
			sendJSON(w, 200, jsvalue.Obj(jsvalue.Property("ok", jsvalue.Bool(true)),
				jsvalue.Property("nonce", jsvalue.Str(os.Getenv("OSI_EDGE_TEST_NONCE")))))
			return
		}
		if r.Method == "POST" && r.URL.Path == "/__test/settle" {
			if b.ingest != nil {
				b.ingest.Settle()
			}
			b.cloudSequences.Wait()
			b.writes.Lock()
			b.writes.Unlock()
			sendJSON(w, 200, jsvalue.Obj(jsvalue.Property("ok", jsvalue.Bool(true))))
			return
		}
		if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/__test/timer/") {
			name, _ := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/__test/timer/"))
			if err := b.tick(r.Context(), name); err != nil {
				sendJSON(w, 500, jsvalue.Obj(jsvalue.Property("error", jsvalue.Str(err.Error()))))
				return
			}
			sendJSON(w, 200, jsvalue.Obj(jsvalue.Property("ok", jsvalue.Bool(true))))
			return
		}
	}

	if b.serveGUI(w, r) {
		return
	}

	rt, p, allow, malformed := lookup(r.Method, requestTargetPath(r))
	if malformed != "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	matched = rt
	if allow != "" && r.Method == "OPTIONS" && rt == nil {
		w.Header().Set("Allow", allow)
		sendText(w, 200, "text/html", allow)
		return
	}
	if rt == nil {
		http.NotFound(w, r)
		return
	}
	// settings.js httpNodeMiddleware: a must-change-password token reaches only
	// GET /api/me and POST /auth/login.
	header := r.Header.Get("Authorization")
	stepRoute := r.Method + " " + strings.TrimRight(r.URL.Path, "/")
	if stepRoute != "GET /api/me" && stepRoute != "POST /auth/login" && mustChangePassword(header) {
		sendJSON(w, 403, jsvalue.Obj(
			jsvalue.Property("code", jsvalue.Str("password_change_required")),
			jsvalue.Property("message", jsvalue.Str("Set a new password to continue.")),
		))
		return
	}
	body, err := httpbody.Parse(r)
	if err != nil {
		log.Print("request body rejected")
		sendText(w, 500, "text/plain", "Internal Server Error")
		return
	}
	rt.handler(b, w, r, p, body)
}

func mustChangePassword(header string) bool {
	header = jsvalue.Latin1(header)
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	part, _, _ := strings.Cut(jsvalue.Trim(header[7:]), ".")
	payload, err := auth.DecodeTokenPart(part)
	return err == nil && payload.Get("mustChangePassword").Bool
}

func scopedAccess() bool { return os.Getenv("OSI_SCOPED_ACCESS") == "1" }

func sendText(w http.ResponseWriter, status int, mediaType, text string) {
	w.Header().Set("Content-Type", mediaType+"; charset=utf-8")
	w.WriteHeader(status)
	io.WriteString(w, text)
}

func sendJSON(w http.ResponseWriter, status int, value jsvalue.Value) {
	body, err := jsvalue.Stringify(value)
	if err != nil {
		panic(err)
	}
	sendText(w, status, "application/json", string(body))
}

func respond(w http.ResponseWriter, status int, fields ...jsvalue.Field) {
	headers := w.Header()
	headers.Set("Access-Control-Allow-Origin", "*")
	headers.Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
	sendJSON(w, status, jsvalue.Obj(fields...))
}

func message(w http.ResponseWriter, status int, text string) {
	respond(w, status, jsvalue.Property("message", jsvalue.Str(text)))
}

func databaseError(w http.ResponseWriter, text string, err error) {
	respond(w, 500,
		jsvalue.Property("message", jsvalue.Str(text)),
		jsvalue.Property("detail", jsvalue.Str(err.Error())),
	)
}

// Responses from the flow catch nodes and the route-local promise catches.
func deviceCoercionCatch(w http.ResponseWriter, err *jsvalue.JSError) {
	respond(w, 500, jsvalue.Property("error", jsvalue.Str("device-api failed")),
		jsvalue.Property("message", jsvalue.Str(err.Name+": "+err.Message)))
}

func authCoercionCatch(w http.ResponseWriter, _ *jsvalue.JSError) {
	message(w, 500, "Authentication request failed")
}

func settingsCoercionCatch(w http.ResponseWriter, err *jsvalue.JSError) {
	problem := settingsError{status: 500, message: err.Message}
	settingsRespond(w, problem.status, problem.fields()...)
}

func configCoercionCatch(w http.ResponseWriter, err *jsvalue.JSError) {
	configResponseError(w, 500, err.Message, true)
}

func valveAPICoercionCatch(w http.ResponseWriter, err *jsvalue.JSError) {
	replyScheduleError(w, err)
}

func cancelCoercionCatch(w http.ResponseWriter, err *jsvalue.JSError) {
	sendJSON(w, 500, jsvalue.Obj(jsvalue.Property("message", jsvalue.Str(err.Message))))
}
