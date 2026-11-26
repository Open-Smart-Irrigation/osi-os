package cloudmqtt

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"

	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"github.com/eclipse/paho.golang/autopaho"
	"github.com/gorilla/websocket"
	"math/big"
	"net"
	"testing"
	"time"
)

// testCA is one certificate with its key, from a self-generated test PKI.
type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

var serial int64

func issue(t *testing.T, name string, key *ecdsa.PrivateKey, parent *testCA, isCA bool) *testCA {
	t.Helper()
	if key == nil {
		var err error
		if key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
			t.Fatal(err)
		}
	}
	serial++
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(serial),
		Subject:               pkix.Name{CommonName: name, Organization: []string{"OSI test PKI"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		BasicConstraintsValid: true,
		IsCA:                  isCA,
	}
	if isCA {
		template.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	} else {
		template.KeyUsage = x509.KeyUsageDigitalSignature
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		template.DNSNames = []string{"broker.test"}
	}
	signer, signerKey := template, key
	if parent != nil {
		signer, signerKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert, key}
}

// serve answers TLS handshakes with the given chain until the test ends.
func serve(t *testing.T, chain ...*testCA) Target {
	t.Helper()
	certificate := tls.Certificate{PrivateKey: chain[0].key, Leaf: chain[0].cert}
	for _, c := range chain {
		certificate.Certificate = append(certificate.Certificate, c.cert.Raw)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{certificate}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				conn.(*tls.Conn).Handshake()
			}()
		}
	}()
	return Target{Name: "test", Address: listener.Addr().String(), Host: "broker.test", TLS: true}
}

func handshake(t *testing.T, target Target, roots *x509.CertPool) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return Handshake(ctx, target, roots)
}

func wantUnknownAuthority(t *testing.T, err error) {
	t.Helper()
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("got %v, want x509.UnknownAuthorityError", err)
	}
}

func TestBrokerSelfSignedCertificateRefused(t *testing.T) {
	leaf := issue(t, "broker.test", nil, nil, false)
	target := serve(t, leaf)
	// The production pool (Node's roots) and a test pool without the leaf.
	wantUnknownAuthority(t, handshake(t, target, nil))
	wantUnknownAuthority(t, handshake(t, target, x509.NewCertPool()))
}

func TestBrokerCertificateFromTestRootAccepted(t *testing.T) {
	root := issue(t, "OSI Test Root", nil, nil, true)
	target := serve(t, issue(t, "broker.test", nil, root, false))
	pool := x509.NewCertPool()
	pool.AddCert(root.cert)
	if err := handshake(t, target, pool); err != nil {
		t.Fatalf("handshake with the test root in the pool: %v", err)
	}
	wantUnknownAuthority(t, handshake(t, target, nil))
}

// The test cloud's shape: leaf <- intermediate <- root that the pool lacks,
// with that root cross-signed by a root the pool holds. Verification needs
// the server to send the cross-signed certificate.
func TestBrokerChainNeedsCrossSignedRoot(t *testing.T) {
	poolRoot := issue(t, "OSI Test Pool Root", nil, nil, true)
	newRoot := issue(t, "OSI Test New Root", nil, nil, true)
	crossSigned := issue(t, "OSI Test New Root", newRoot.key, poolRoot, true)
	intermediate := issue(t, "OSI Test Intermediate", nil, newRoot, true)
	leaf := issue(t, "broker.test", nil, intermediate, false)
	pool := x509.NewCertPool()
	pool.AddCert(poolRoot.cert)

	if err := handshake(t, serve(t, leaf, intermediate, crossSigned), pool); err != nil {
		t.Fatalf("chain with the cross-signed root: %v", err)
	}
	wantUnknownAuthority(t, handshake(t, serve(t, leaf, intermediate), pool))
}

func TestTargets(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		rest bool
		want Target
	}{
		{"wss://cloud.example.test/mqtt", false, Target{"cloud broker", "cloud.example.test:443", "cloud.example.test", true}},
		{"mqtts://cloud.example.test", false, Target{"cloud broker", "cloud.example.test:8883", "cloud.example.test", true}},
		{"ws://cloud.example.test:8080/mqtt", false, Target{"cloud broker", "cloud.example.test:8080", "cloud.example.test", false}},
		{" https://cloud.example.test/ ", true, Target{"cloud REST", "cloud.example.test:443", "cloud.example.test", true}},
		{"http://[::1]:8080", true, Target{"cloud REST", "[::1]:8080", "::1", false}},
	} {
		parse := BrokerTarget
		if tc.rest {
			parse = RESTTarget
		}
		got, err := parse(tc.raw)
		if err != nil || got != tc.want {
			t.Errorf("%q: %+v, %v; want %+v", tc.raw, got, err, tc.want)
		}
	}
	if _, err := RESTTarget("ftp://cloud.example.test"); err == nil {
		t.Error("ftp accepted")
	}
}

// A broker that fails verification behaves as an unreachable one: no
// connection, and Publish drops the message without queueing it.
func TestBrokerFailingVerificationDropsLikeUnreachable(t *testing.T) {
	target := serve(t, issue(t, "broker.test", nil, nil, false))
	_, port, _ := net.SplitHostPort(target.Address)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	root := t.TempDir()
	c, err := Start(ctx, func() error { return nil }, "mqtts://127.0.0.1:"+port, "device_0016C001F1000001", "0016C001F1000001", "synthetic", func(p string) string { return root + p })
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	time.Sleep(300 * time.Millisecond)
	if c.connected.Load() {
		t.Fatal("connected to a broker that failed verification")
	}
	// Publish returns before PublishViaQueue while disconnected.
	if err := c.Publish("devices/0016C001F1000001/telemetry", []byte("{}")); err != nil {
		t.Fatalf("Publish = %v, want the unreachable-broker drop (nil)", err)
	}
}

// The service path: Start's TLS configuration through dial() over wss, the
// production scheme. Accepted only when the pool holds the broker's root.
func TestBrokerWebSocketDialUsesPinnedRoots(t *testing.T) {
	root := issue(t, "OSI Test Root", nil, nil, true)
	leaf := issue(t, "broker.test", nil, root, false)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{Subprotocols: []string{"mqtt"}}
		if conn, err := upgrader.Upgrade(w, r, nil); err == nil {
			conn.Close()
		}
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leaf.cert.Raw, root.cert.Raw}, PrivateKey: leaf.key}}}
	server.StartTLS()
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	u, _ := url.Parse("wss://broker.test:" + port + "/mqtt")
	// Dial the test server by address; the certificate must name broker.test.
	dialWith := func() error {
		cfg := autopaho.ClientConfig{ConnectTimeout: 5 * time.Second, TlsCfg: brokerTLS()}
		local := *u
		local.Host = "127.0.0.1:" + port
		cfg.TlsCfg.ServerName = "broker.test"
		conn, err := dial(context.Background(), cfg, &local)
		if err == nil {
			conn.Close()
		}
		return err
	}
	wantUnknownAuthority(t, dialWith())

	previous := brokerRoots
	t.Cleanup(func() { brokerRoots = previous })
	brokerRoots = func() *x509.CertPool {
		pool := x509.NewCertPool()
		pool.AddCert(root.cert)
		return pool
	}
	if err := dialWith(); err != nil {
		t.Fatalf("wss dial with the test root: %v", err)
	}
}
