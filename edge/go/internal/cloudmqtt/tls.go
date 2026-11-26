package cloudmqtt

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/url"

	"osi-edge/internal/jsvalue"
	"osi-edge/internal/noderoots"
)

// brokerRoots supplies the root pool for cloud broker TLS verification.
// Production uses exactly Node's bundled roots; tests replace it.
var brokerRoots = noderoots.Pool

// clientTLS is the one TLS configuration the cloud connections and
// `osi-edge tls-check` use.
func clientTLS(roots *x509.CertPool) *tls.Config {
	return &tls.Config{RootCAs: roots}
}

// brokerTLS is the configuration Start gives dial for wss and mqtts.
func brokerTLS() *tls.Config { return clientTLS(brokerRoots()) }

// Target is one TLS endpoint to verify before a backend switch.
type Target struct {
	Name    string // what it is, for the one-line result
	Address string // host:port
	Host    string // name the certificate must carry
	TLS     bool   // false: the configured URL uses no TLS
}

// BrokerTarget reads the broker URL as Start does.
func BrokerTarget(raw string) (Target, error) {
	u, err := brokerURL(raw)
	if err != nil {
		return Target{}, err
	}
	return Target{Name: "cloud broker", Address: u.Host, Host: u.Hostname(), TLS: u.Scheme == "wss" || u.Scheme == "mqtts"}, nil
}

// RESTTarget reads a cloud REST base URL (users.server_url).
func RESTTarget(raw string) (Target, error) {
	u, err := url.Parse(jsvalue.Trim(raw))
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return Target{}, errors.New("invalid cloud REST URL")
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[u.Scheme]
	}
	return Target{Name: "cloud REST", Address: net.JoinHostPort(u.Hostname(), port), Host: u.Hostname(), TLS: u.Scheme == "https"}, nil
}

// Handshake performs a TLS handshake with the target and closes it: no
// WebSocket upgrade, no MQTT CONNECT, no HTTP request. roots nil means the
// production pool.
func Handshake(ctx context.Context, target Target, roots *x509.CertPool) error {
	if roots == nil {
		roots = brokerRoots()
	}
	config := clientTLS(roots)
	config.ServerName = target.Host
	dialer := tls.Dialer{Config: config}
	conn, err := dialer.DialContext(ctx, "tcp", target.Address)
	if err != nil {
		return err
	}
	return conn.Close()
}
