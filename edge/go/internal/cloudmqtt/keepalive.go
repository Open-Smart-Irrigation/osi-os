package cloudmqtt

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/packets"
	paholog "github.com/eclipse/paho.golang/paho/log"
)

// mqtt.js starts the timer on CONNACK and postpones the next ping when
// it sends a control packet. Paho's default pinger sends one at startup.
type idlePinger struct {
	mu       sync.Mutex
	lastSent time.Time
	awaiting bool
}

func (p *idlePinger) Run(ctx context.Context, conn net.Conn, keepalive uint16) error {
	if keepalive == 0 {
		return nil
	}
	p.mu.Lock()
	p.lastSent = time.Now()
	p.awaiting = false
	p.mu.Unlock()

	period := time.Duration(keepalive) * time.Second
	timer := time.NewTimer(period)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			p.mu.Lock()
			wait := time.Until(p.lastSent.Add(period))
			if wait > 0 {
				p.mu.Unlock()
				timer.Reset(wait)
				continue
			}
			if p.awaiting {
				p.mu.Unlock()
				return errors.New("cloud MQTT PINGRESP timed out")
			}
			p.lastSent = time.Now()
			p.awaiting = true
			p.mu.Unlock()
			if _, err := packets.NewControlPacket(packets.PINGREQ).WriteTo(conn); err != nil {
				return fmt.Errorf("send cloud MQTT PINGREQ: %w", err)
			}
			timer.Reset(period)
		}
	}
}

func (p *idlePinger) PacketSent() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastSent = time.Now()
}

func (p *idlePinger) PingResp() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.awaiting = false
}

func (*idlePinger) PacketReceived()         {}
func (*idlePinger) SetDebug(paholog.Logger) {}
