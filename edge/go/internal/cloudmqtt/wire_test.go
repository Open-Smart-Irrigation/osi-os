package cloudmqtt

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/packets"
	"github.com/eclipse/paho.golang/paho"
	"github.com/eclipse/paho.golang/paho/session/state"
	"github.com/gorilla/websocket"
)

func TestWSSConnectProperties(t *testing.T) {
	received := make(chan *packets.Connect, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mqtt" {
			http.NotFound(w, r)
			return
		}
		upgrader := websocket.Upgrader{Subprotocols: []string{"mqtt"}}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.Close()
		if ws.Subprotocol() != "mqtt" {
			t.Errorf("subprotocol = %q", ws.Subprotocol())
		}
		stream := &webSocketStream{Conn: ws}
		packet, err := packets.ReadPacket(stream)
		if err != nil {
			t.Error(err)
			return
		}
		connect, ok := packet.Content.(*packets.Connect)
		if !ok {
			t.Errorf("expected CONNECT, got packet type %d", packet.Type)
			return
		}
		received <- connect
	}))
	defer server.Close()

	u, err := brokerURL("wss" + strings.TrimPrefix(server.URL, "https") + "/mqtt")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cfg := autopaho.ClientConfig{
		ConnectTimeout: time.Second,
		TlsCfg:         server.Client().Transport.(*http.Transport).TLSClientConfig,
	}
	conn, err := dial(ctx, cfg, u)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	connect := (&paho.Connect{
		Properties: &paho.ConnectProperties{RequestResponseInfo: true, RequestProblemInfo: true},
	}).Packet()
	connect.ProtocolName = "MQTT"
	connect.ProtocolVersion = 5
	if _, err := connect.WriteTo(conn); err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-received:
		if c.ProtocolVersion != 5 || c.CleanStart || c.Properties.SessionExpiryInterval != nil ||
			c.Properties.RequestProblemInfo == nil || *c.Properties.RequestProblemInfo != 1 ||
			c.Properties.RequestResponseInfo == nil || *c.Properties.RequestResponseInfo != 1 {
			t.Fatalf("unexpected CONNECT: %+v %+v", c, c.Properties)
		}
	case <-ctx.Done():
		t.Fatal("server did not receive MQTT CONNECT over WSS")
	}
}

type testWire struct {
	bytes.Buffer
	sync.Mutex
}

func TestRetryWithNoBrokerSession(t *testing.T) {
	store := &outgoingSession{State: state.NewInMemory()}
	var original, reconnected testWire
	connect := &packets.Connect{}
	ack := &packets.Connack{}
	if err := store.ConAckReceived(&original, connect, ack); err != nil {
		t.Fatal(err)
	}
	msg := &packets.Publish{QoS: 1, Topic: "test/telemetry", Payload: bytes.Repeat([]byte("x"), 140)}
	response := make(chan packets.ControlPacket, 1)
	if err := store.AddToSession(context.Background(), msg, response); err != nil {
		t.Fatal(err)
	}
	if err := store.ConnectionLost(nil); err != nil {
		t.Fatal(err)
	}
	if err := store.ConAckReceived(&reconnected, connect, ack); err != nil {
		t.Fatal(err)
	}
	packet, err := packets.ReadPacket(&reconnected)
	if err != nil {
		t.Fatal(err)
	}
	retry := packet.Content.(*packets.Publish)
	if retry.PacketID != msg.PacketID || retry.Duplicate || retry.QoS != 1 ||
		retry.Topic != msg.Topic || !bytes.Equal(retry.Payload, msg.Payload) || reconnected.Len() != 0 {
		t.Fatalf("unexpected retry: %+v", retry)
	}
	if ack.SessionPresent || ack.Properties != nil {
		t.Fatal("broker CONNACK was modified")
	}
}
