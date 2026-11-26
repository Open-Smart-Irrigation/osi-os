package cloudmqtt

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/packets"
	"github.com/eclipse/paho.golang/paho"
	"github.com/eclipse/paho.golang/paho/session/state"
	"github.com/gorilla/websocket"
)

func dial(ctx context.Context, cfg autopaho.ClientConfig, u *url.URL) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, cfg.ConnectTimeout)
	defer cancel()

	var conn net.Conn
	var err error
	switch u.Scheme {
	case "ws", "wss":
		dialer := *websocket.DefaultDialer
		dialer.TLSClientConfig = cfg.TlsCfg
		dialer.Subprotocols = []string{"mqtt"}
		ws, response, dialErr := dialer.DialContext(ctx, u.String(), nil)
		if dialErr != nil {
			if response != nil {
				response.Body.Close()
			}
			return nil, dialErr
		}
		conn = &webSocketStream{Conn: ws}
	case "mqtts":
		dialer := tls.Dialer{Config: cfg.TlsCfg}
		conn, err = dialer.DialContext(ctx, "tcp", u.Host)
	default:
		dialer := net.Dialer{}
		conn, err = dialer.DialContext(ctx, "tcp", u.Host)
	}
	if err != nil {
		return nil, err
	}
	return &connectWire{Conn: conn}, nil
}

type webSocketStream struct {
	*websocket.Conn
	frame io.Reader
}

func (c *webSocketStream) Read(p []byte) (int, error) {
	for {
		if c.frame == nil {
			_, reader, err := c.NextReader()
			if err != nil {
				return 0, err
			}
			c.frame = reader
		}
		n, err := c.frame.Read(p)
		if err != io.EOF {
			return n, err
		}
		c.frame = nil
		if n > 0 {
			return n, nil
		}
	}
}

func (c *webSocketStream) Write(p []byte) (int, error) {
	if err := c.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *webSocketStream) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

// connectWire adds the explicit Request Problem Information=true property
// emitted by mqtt.js. Paho's high-level Connect omits it at its default.
type connectWire struct {
	net.Conn
	sync.Mutex
	header []byte
	sent   bool
}

func (c *connectWire) Write(p []byte) (int, error) {
	if c.sent {
		return c.Conn.Write(p)
	}
	// Paho's CONNECT WriteTo writes one fixed header and one body buffer.
	if c.header == nil {
		c.header = bytes.Clone(p)
		return len(p), nil
	}
	packet, err := packets.ReadPacket(io.MultiReader(bytes.NewReader(c.header), bytes.NewReader(p)))
	if err != nil {
		return 0, err
	}
	request, ok := packet.Content.(*packets.Connect)
	if !ok {
		return 0, fmt.Errorf("expected MQTT CONNECT, got %d", packet.Type)
	}
	request.Properties.RequestProblemInfo = paho.Byte(1)
	var frame bytes.Buffer
	if _, err := packet.WriteTo(&frame); err != nil {
		return 0, err
	}
	if _, err := frame.WriteTo(c.Conn); err != nil {
		return 0, err
	}
	c.sent = true
	c.header = nil
	return len(p), nil
}

// mqtt.js keeps its outbound QoS 1 store across a connection loss, even
// when the broker's zero-expiry session is gone. Keep Paho's state in memory
// for the same lifetime by giving only its internal store a persistent view.
type outgoingSession struct {
	*state.State
}

func (s *outgoingSession) ConAckReceived(conn io.Writer, connect *packets.Connect, ack *packets.Connack) error {
	expiry := uint32(math.MaxUint32)
	var properties packets.Properties
	if ack.Properties != nil {
		properties = *ack.Properties
	}
	properties.SessionExpiryInterval = &expiry
	storeAck := *ack
	storeAck.Properties = &properties
	storeAck.SessionPresent = true

	locker, ok := conn.(sync.Locker)
	if !ok {
		return fmt.Errorf("MQTT connection lacks a packet write lock")
	}
	wire := &resendWriter{Writer: conn, Locker: locker, resending: true}
	err := s.State.ConAckReceived(wire, connect, &storeAck)
	wire.resending = false
	return err
}

func (s *outgoingSession) ConnectionLost(_ *packets.Disconnect) error {
	return s.State.ConnectionLost(nil)
}

// mqtt.js replays the stored PUBLISH with the original DUP flag. Paho sets
// DUP on replay, so clear it on the replayed fixed header only.
type resendWriter struct {
	io.Writer
	sync.Locker
	resending bool
	remaining uint64
}

func (w *resendWriter) Write(p []byte) (int, error) {
	if !w.resending || len(p) == 0 {
		return w.Writer.Write(p)
	}
	if w.remaining > 0 {
		if uint64(len(p)) > w.remaining {
			return 0, fmt.Errorf("invalid MQTT replay body")
		}
		w.remaining -= uint64(len(p))
		return w.Writer.Write(p)
	}
	length, n := binary.Uvarint(p[1:])
	if n == 0 || n != len(p)-1 {
		return 0, fmt.Errorf("invalid MQTT replay header")
	}
	w.remaining = length
	if p[0]>>4 == packets.PUBLISH {
		p = bytes.Clone(p)
		p[0] &^= 1 << 3
	}
	return w.Writer.Write(p)
}
