// Package cloudmqtt owns the edge's outbound cloud MQTT connection.
package cloudmqtt

import (
	"context"
	"errors"
	"log"
	"net"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
	"github.com/eclipse/paho.golang/paho/session/state"

	"osi-edge/internal/procfence"
)

const reconnectPeriod = 15 * time.Second

// Client is shared by cloud publishers. A nil client represents an unset broker.
type Client struct {
	manager   *autopaho.ConnectionManager
	imagePath func(string) string
	connected atomic.Bool
}

func Start(ctx context.Context, beforeDial func() error, broker, clientID, username, password string, imagePath func(string) string) (*Client, error) {
	if broker == "" {
		return nil, nil
	}
	u, err := brokerURL(broker)
	if err != nil {
		return nil, err
	}

	c := &Client{imagePath: imagePath}
	var attempts atomic.Uint64
	cfg := autopaho.ClientConfig{
		ServerUrls: []*url.URL{u},
		KeepAlive:  60,
		// Cloud broker TLS verification with exactly Node's bundled roots.
		TlsCfg: brokerTLS(),
		// Both the initial and subsequent CONNECT use clean start false and
		// omit the expiry property (effective expiry zero).
		ConnectTimeout: 30 * time.Second,
		ReconnectBackoff: func(_ int) time.Duration {
			if attempts.Add(1) == 1 {
				return 0
			}
			return reconnectPeriod
		},
		AttemptConnection: func(ctx context.Context, cfg autopaho.ClientConfig, u *url.URL) (net.Conn, error) {
			if err := beforeDial(); err != nil {
				return nil, err
			}
			return dial(ctx, cfg, u)
		},
		OnConnectionUp:   func(*autopaho.ConnectionManager, *paho.Connack) { c.connected.Store(true) },
		OnConnectionDown: func() bool { c.connected.Store(false); return true },
		OnConnectError:   func(error) { log.Print("cloud MQTT: connection failed") },
		ConnectPacketBuilder: func(p *paho.Connect, _ *url.URL) (*paho.Connect, error) {
			p.Properties = &paho.ConnectProperties{RequestResponseInfo: true, RequestProblemInfo: true}
			return p, nil
		},
		Errors: log.Default(),
		ClientConfig: paho.ClientConfig{
			ClientID:      clientID,
			PingHandler:   &idlePinger{},
			PacketTimeout: 30 * time.Second,
			Session:       &outgoingSession{State: state.NewInMemory()},
		},
	}
	cfg.ConnectUsername = username
	if password != "" {
		cfg.ConnectPassword = []byte(password)
	}
	c.manager, err = autopaho.NewConnection(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return c, nil
}

func brokerURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return nil, errors.New("invalid cloud MQTT broker URL")
	}
	var port string
	switch u.Scheme {
	case "mqtt", "tcp":
		port = "1883"
	case "mqtts":
		port = "8883"
	case "ws":
		port = "80"
	case "wss":
		port = "443"
	default:
		return nil, errors.New("unsupported cloud MQTT broker scheme")
	}
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), port)
	}
	return u, nil
}

func (c *Client) Close() {
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.manager.Disconnect(ctx); err != nil {
		log.Printf("cloud MQTT: disconnect: %v", err)
	}
}

// PublishAwait sends one QoS 1 message while connected and waits for its
// PUBACK or the context, so a caller can keep its messages one PUBACK apart
// as Node-RED's separate flow paths do. The account-recovery gate applies.
func (c *Client) PublishAwait(ctx context.Context, topic string, payload []byte) error {
	if c == nil {
		return nil
	}
	procfence.Admit() // no new publish after a fatal scheduler fault
	blocked, err := recoveryBlocked(c.imagePath)
	if err != nil || blocked || !c.connected.Load() {
		return err
	}
	_, err = c.manager.Publish(ctx, &paho.Publish{QoS: 1, Topic: topic, Payload: payload})
	return err
}

// Publish accepts QoS 1 messages while connected. The queue decouples callers
// from socket writes and PUBACKs, as in Node-RED's MQTT output callback.
func (c *Client) Publish(topic string, payload []byte) error {
	if c == nil {
		return nil
	}
	procfence.Admit() // no new publish after a fatal scheduler fault
	blocked, err := recoveryBlocked(c.imagePath)
	if err != nil || blocked || !c.connected.Load() {
		return err
	}
	return c.manager.PublishViaQueue(context.Background(), &autopaho.QueuePublish{
		Publish: &paho.Publish{QoS: 1, Topic: topic, Payload: payload},
	})
}
