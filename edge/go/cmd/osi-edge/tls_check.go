package main

import (
	"context"
	"crypto/x509"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"osi-edge/internal/cloudmqtt"
	"osi-edge/internal/jsvalue"
)

const tlsCheckTimeout = 15 * time.Second

// tls-check is the switch precondition for `osi-backend use edge`: a real
// TLS handshake, with the service's verifier, to the configured cloud broker
// and to the cloud REST host. It changes nothing.
func runTLSCheck(out io.Writer, roots *x509.CertPool) int {
	if err := loadNodeRedEnvFile(imagePath("/srv/node-red/.chirpstack.env")); err != nil {
		fmt.Fprintf(out, "osi-edge tls-check: %v\n", err)
		return 1
	}
	targets, err := tlsCheckTargets()
	if err != nil {
		fmt.Fprintf(out, "osi-edge tls-check: %v\n", err)
		return 1
	}
	status := 0
	for _, target := range targets {
		if !target.TLS {
			fmt.Fprintf(out, "osi-edge tls-check: %s %s uses no TLS; nothing to verify\n", target.Name, target.Address)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), tlsCheckTimeout)
		err := cloudmqtt.Handshake(ctx, target, roots)
		cancel()
		if err != nil {
			fmt.Fprintf(out, "osi-edge tls-check: %s %s failed: %s\n", target.Name, target.Address, tlsFailure(err))
			status = 1
			continue
		}
		fmt.Fprintf(out, "osi-edge tls-check: %s %s verified\n", target.Name, target.Address)
	}
	return status
}

func tlsFailure(err error) string {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	switch {
	case errors.As(err, &unknown):
		return "certificate not signed by a trusted root"
	case errors.As(err, &hostname):
		return "certificate does not match the host name"
	case errors.As(err, &invalid):
		return "certificate invalid (" + invalid.Error() + ")"
	case errors.Is(err, context.DeadlineExceeded):
		return "no TLS handshake within " + tlsCheckTimeout.String()
	}
	return "unreachable or refused (" + err.Error() + ")"
}

// tlsCheckTargets uses the service's sources: OSI_CLOUD_BROKER_URL from the
// init, and the cloud REST URL the sync flows use (users.server_url).
func tlsCheckTargets() ([]cloudmqtt.Target, error) {
	var targets []cloudmqtt.Target
	if broker := os.Getenv("OSI_CLOUD_BROKER_URL"); broker != "" {
		target, err := cloudmqtt.BrokerTarget(broker)
		if err != nil {
			return nil, fmt.Errorf("cloud broker URL: %w", err)
		}
		targets = append(targets, target)
	}
	server, err := cloudServerURL()
	if err != nil {
		return nil, fmt.Errorf("read the cloud link: %w", err)
	}
	if server != "" {
		target, err := cloudmqtt.RESTTarget(server)
		if err != nil {
			return nil, fmt.Errorf("cloud REST URL: %w", err)
		}
		targets = append(targets, target)
	}
	return targets, nil
}

// cloudServerURL reads the link the sync flows use (getCloudSyncTarget),
// read-only: Node-RED owns the database while the check runs.
func cloudServerURL() (string, error) {
	path := os.Getenv("OSI_EDGE_DB")
	if path == "" {
		path = imagePath("/data/db/farming.db")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(absolute); err != nil {
		return "", err
	}
	dsn := url.URL{Scheme: "file", Path: absolute, RawQuery: url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(5000)"}}.Encode()}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return "", err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var server sql.NullString
	err = db.QueryRowContext(ctx, "SELECT server_url FROM users WHERE server_url IS NOT NULL AND server_url <> '' ORDER BY server_linked_at DESC, id DESC LIMIT 1").Scan(&server)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	// normalizeCloudServerUrl: String(value).trim().replace(/\/$/, '')
	return strings.TrimSuffix(jsvalue.Trim(server.String), "/"), nil
}
