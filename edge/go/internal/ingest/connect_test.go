package ingest

import (
	"bufio"
	"context"
	"io"
	"net"
	"testing"
	"time"
)

// Node-RED's local broker node sends CONNECT with protocol level 4, clean
// session off and keepalive 0 (review r2 raw-paired.log, client "nodered").
func TestLocalConnectMatchesNodeRed(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	got := make(chan []byte, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		header, _ := reader.ReadByte()
		length, multiplier := 0, 1
		for {
			b, err := reader.ReadByte()
			if err != nil {
				return
			}
			length += int(b&0x7f) * multiplier
			multiplier *= 128
			if b&0x80 == 0 {
				break
			}
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(reader, body); err != nil {
			return
		}
		got <- append([]byte{header}, body...)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := New()
	if err := s.Start(ctx, "tcp://"+listener.Addr().String(), "nodered", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	select {
	case packet := <-got:
		// 0x10, "\x00\x04MQTT", level, flags, keepalive (2 bytes), client id.
		if packet[0] != 0x10 || string(packet[1:7]) != "\x00\x04MQTT" {
			t.Fatalf("not a CONNECT: % x", packet)
		}
		level, flags, keepalive := packet[7], packet[8], int(packet[9])<<8|int(packet[10])
		if level != 4 || flags&0x02 != 0 || keepalive != 0 {
			t.Errorf("CONNECT level %d, clean %t, keepalive %d; want 4, false, 0", level, flags&0x02 != 0, keepalive)
		}
		if id := string(packet[13:]); id != "nodered" {
			t.Errorf("client id %q", id)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no CONNECT")
	}
	cancel()
	s.Stop()
}
