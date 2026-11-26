// Package ingest subscribes to ChirpStack uplinks. Telemetry can run on
// receipt while an ordered worker handles history and other database writes.
package ingest

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/url"
	"runtime/debug"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"osi-edge/internal/jsvalue"
)

// Topic is the only subscription the flows use (AGENTS.md, MQTT IN topic rule).
const Topic = "application/+/device/+/event/up"

type Uplink struct {
	Topic    string
	Payload  []byte
	Received time.Time
}

type Handler func(ctx context.Context, u Uplink) error

type named struct {
	name string
	fn   Handler
}

type delivery struct {
	uplink Uplink
	ack    func()
}

type Service struct {
	mu        sync.Mutex
	pending   int
	stopped   bool
	idle      *sync.Cond
	receivers sync.WaitGroup

	handlers  []named
	onReceipt []named
	queue     chan delivery
	done      chan struct{}
	ctx       context.Context
	cancel    context.CancelFunc
	client    mqtt.Client
	ready     chan struct{}
	readyOnce sync.Once
}

func New() *Service {
	s := &Service{ready: make(chan struct{})}
	s.idle = sync.NewCond(&s.mu)
	return s
}

// Handle adds an ordered writer. Call before Start.
func (s *Service) Handle(name string, fn Handler) {
	s.handlers = append(s.handlers, named{name, fn})
}

// HandleOnReceipt adds a branch that runs without waiting for the writer or
// the broker. Call before Start.
func (s *Service) HandleOnReceipt(name string, fn Handler) {
	s.onReceipt = append(s.onReceipt, named{name, fn})
}

// Start connects as the flows' local broker node does: MQTT 3.1.1, client id
// "nodered", clean session off, keepalive 0 (no PINGREQ), QoS 1, so queued
// uplinks survive a restart and carry across a backend switch.
func (s *Service) Start(ctx context.Context, brokerURL, clientID string, beforeDial func() error) error {
	opts := mqtt.NewClientOptions().AddBroker(brokerURL).SetClientID(clientID).
		SetProtocolVersion(4).SetCleanSession(false).SetAutoReconnect(true).
		SetConnectRetry(true).SetConnectRetryInterval(2 * time.Second).SetOrderMatters(true).
		SetAutoAckDisabled(true).SetKeepAlive(0)
	if len(opts.Servers) != 1 || (opts.Servers[0].Scheme != "tcp" && opts.Servers[0].Scheme != "mqtt") {
		return fmt.Errorf("expected a TCP URL for the local broker")
	}
	s.startDispatch(ctx)
	opts.SetCustomOpenConnectionFn(func(uri *url.URL, opts mqtt.ClientOptions) (net.Conn, error) {
		if err := beforeDial(); err != nil {
			return nil, err
		}
		dialer := net.Dialer{Timeout: opts.ConnectTimeout}
		conn, err := dialer.DialContext(s.ctx, "tcp", uri.Host)
		if err != nil {
			return nil, err
		}
		// A cancelled backend must close even a socket still waiting for
		// CONNACK, which Paho's Disconnect cannot reach.
		stop := context.AfterFunc(s.ctx, func() {
			defer func() {
				if p := recover(); p != nil {
					log.Printf("close local MQTT panic: %v", p)
				}
			}()
			conn.Close()
		})
		return &localConnection{Conn: conn, stop: stop}, nil
	})
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		token := c.Subscribe(Topic, 1, nil)
		token.Wait()
		if err := token.Error(); err != nil {
			log.Printf("ingest: subscribe failed: %v", err)
			return
		}
		s.readyOnce.Do(func() { close(s.ready) })
	})
	s.client = mqtt.NewClient(opts)
	// A persistent session can deliver PUBLISH immediately after CONNACK,
	// before OnConnect runs or the broker handles the new SUBSCRIBE.
	s.client.AddRoute(Topic, s.receive)
	s.client.Connect()
	return nil
}

type localConnection struct {
	net.Conn
	stop func() bool
}

func (c *localConnection) Close() error {
	c.stop()
	return c.Conn.Close()
}

func (s *Service) startDispatch(ctx context.Context) {
	s.ctx, s.cancel = context.WithCancel(ctx)
	s.queue = make(chan delivery, 1024)
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		defer func() {
			if p := recover(); p != nil {
				log.Printf("ingest worker panic: %v\n%s", p, debug.Stack())
			}
		}()
		for d := range s.queue {
			s.write(d)
		}
	}()
}

// Ready is closed after the first successful subscription.
func (s *Service) Ready() <-chan struct{} { return s.ready }

func (s *Service) receive(_ mqtt.Client, m mqtt.Message) {
	s.mu.Lock()
	if s.stopped || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.receivers.Add(1)
	s.pending++
	s.mu.Unlock()
	defer s.receivers.Done()

	u := Uplink{Topic: m.Topic(), Payload: append([]byte(nil), m.Payload()...), Received: time.Now()}
	s.dispatch(s.onReceipt, u)
	select {
	case s.queue <- delivery{uplink: u, ack: m.Ack}:
	case <-s.ctx.Done():
		s.finish()
	}
}

func (s *Service) write(d delivery) {
	defer s.finish()
	if s.ctx.Err() == nil {
		s.dispatch(s.handlers, d.uplink)
	}
	// Pending frames stay available to the broker across a backend switch.
	if s.ctx.Err() == nil {
		d.ack()
	}
}

func (s *Service) dispatch(handlers []named, u Uplink) {
	for _, h := range handlers {
		if s.ctx.Err() != nil {
			return
		}
		if err := run(s.ctx, h, u); err != nil {
			log.Printf("ingest %s: %v", h.name, err)
		}
	}
}

func (s *Service) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending--
	if s.pending == 0 {
		s.idle.Broadcast()
	}
}

func run(ctx context.Context, h named, u Uplink) (err error) {
	defer func() {
		if p := recover(); p != nil {
			if exception, ok := p.(*jsvalue.JSError); ok {
				err = exception
				return
			}
			err = fmt.Errorf("panic: %v\n%s", p, debug.Stack())
		}
	}()
	return h.fn(ctx, u)
}

// Settle waits until every uplink received so far has been handled.
// A counter with a condition variable, not a WaitGroup: a new uplink may
// arrive while a settle waiter is waking, which a WaitGroup forbids.
func (s *Service) Settle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.pending > 0 {
		s.idle.Wait()
	}
}

func (s *Service) Stop() {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
	s.cancel()
	if s.client != nil {
		s.client.Disconnect(1)
	}
	s.receivers.Wait()
	close(s.queue)
	<-s.done
}
