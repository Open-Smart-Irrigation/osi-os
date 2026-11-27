package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"osi-edge/internal/cloudmqtt"
	"osi-edge/internal/ingest"
	"osi-edge/internal/jsdate"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "tls-check" {
		os.Exit(runTLSCheck(os.Stdout, nil))
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if err := loadNodeRedEnvFile(imagePath("/srv/node-red/.chirpstack.env")); err != nil {
		return err
	}
	jsdate.SetProcessZone(resolveProcessZone())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runSelected(ctx, runtimeSelection())
}

func runActive(ctx context.Context, beforeDial func() error) error {
	path := os.Getenv("OSI_EDGE_DB")
	if path == "" {
		path = imagePath("/data/db/farming.db")
	}
	db, err := openDBContext(ctx, path)
	if err != nil {
		return err
	}
	defer closeOnCancellation(ctx, "SQLite", db.Close)()
	startDBWatchdog(ctx, db)
	refreshSessionsOnce(ctx, db)

	address := os.Getenv("OSI_EDGE_HTTP_ADDR")
	if address == "" {
		address = ":1880"
	}
	guiDir := os.Getenv("OSI_EDGE_GUI_DIR")
	if guiDir == "" {
		guiDir = "/usr/lib/node-red/gui"
	}
	b := &backend{guiDir: guiDir, db: db, testHooks: os.Getenv("OSI_EDGE_TEST_HOOKS") == "1", ingest: ingest.New()}
	if broker := os.Getenv("OSI_CLOUD_BROKER_URL"); broker != "" {
		var connect cloudConnect
		connect, err = resolveCloudConnect(os.Getenv("DEVICE_EUI"), os.Getenv("DEVICE_MQTT_PASSWORD"))
		if err == nil {
			b.cloud, err = cloudmqtt.Start(ctx, beforeDial, broker, connect.ClientID, connect.User, connect.Password, imagePath)
		}
	}
	if err != nil {
		log.Printf("cloud MQTT: %v", err)
	}
	defer b.cloud.Close()
	kiwi := &kiwiIngest{}
	b.ingest.Handle("kiwi", func(ctx context.Context, u ingest.Uplink) error { return kiwi.handle(b, ctx, u) })
	b.ingest.HandleOnReceipt("kiwi telemetry", b.publishKiwiTelemetry)
	for _, h := range uplinkHandlers {
		b.ingest.Handle(h.name, func(ctx context.Context, u ingest.Uplink) error { return h.fn(b, ctx, u) })
	}
	if broker := os.Getenv("OSI_EDGE_MQTT_URL"); broker != "" {
		if err := b.ingest.Start(ctx, broker, "nodered", beforeDial); err != nil {
			return fmt.Errorf("local MQTT: %w", err)
		}
		defer b.ingest.Stop()
		select {
		case <-b.ingest.Ready():
		case <-ctx.Done():
			return nil
		case <-time.After(30 * time.Second):
			return fmt.Errorf("local MQTT: no subscription after 30 s")
		}
	}
	stopTimers := b.startTimers(ctx)
	defer stopTimers()
	server := &http.Server{
		Addr:              address,
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           b,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	defer closeOnCancellation(ctx, "HTTP", server.Close)()
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		return err
	}
	return nil
}

func openDB(path string) (*farmDB, error) {
	return openDBContext(context.Background(), path)
}

func openDBContext(parent context.Context, path string) (*farmDB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	dsn := url.URL{Scheme: "file", Path: absolute}
	dsn.RawQuery = url.Values{
		"mode":    {"rw"},
		"_pragma": sharedConnectionPragmas,
	}.Encode()
	pool, err := sql.Open(nodeTextDriver, dsn.String())
	if err != nil {
		return nil, err
	}
	// osi-db-helper serves every farming.db statement of the flows, the
	// command ledger's included, on ONE shared connection through a FIFO
	// queue (ensureSharedDatabase + enqueueOperation). The backend copies
	// that topology: one connection for reads and writes, kept open.
	pool.SetMaxOpenConns(1)
	pool.SetMaxIdleConns(1)
	pool.SetConnMaxLifetime(0)
	pool.SetConnMaxIdleTime(0)

	db := &farmDB{pool: pool}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	var mode string
	err = db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode)
	if err != nil || mode != "wal" {
		db.Close()
		if err != nil {
			return nil, fmt.Errorf("enable database WAL: %w", err)
		}
		return nil, fmt.Errorf("expected database WAL mode, got %q", mode)
	}
	var version string
	if err := db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version); err == nil {
		log.Printf("SQLite version %s", version)
	} else {
		log.Printf("SQLite version query: %v", err)
	}
	return db, nil
}

// sharedConnectionPragmas are osi-db-helper's PRAGMAS, in its order, applied
// by the driver to the connection when it opens (osi-db-helper/index.js:14-20).
var sharedConnectionPragmas = []string{
	"journal_mode(WAL)",
	"synchronous(NORMAL)",
	"foreign_keys(ON)",
	"busy_timeout(5000)",
	"wal_autocheckpoint(1000)",
}

func imagePath(path string) string {
	if root := os.Getenv("OSI_EDGE_DATA_ROOT"); root != "" {
		return filepath.Join(root, path)
	}
	return path
}

// Uplink handlers register from their own files:
//
//	func init() { registerUplink("kiwi", (*backend).ingestKiwi) }
type uplinkHandler struct {
	name string
	fn   func(b *backend, ctx context.Context, u ingest.Uplink) error
}

var uplinkHandlers []uplinkHandler

func registerUplink(name string, fn func(b *backend, ctx context.Context, u ingest.Uplink) error) {
	uplinkHandlers = append(uplinkHandlers, uplinkHandler{name, fn})
}
