// Minimal SOCKS5 server backing the direct-connect mode: one loopback
// listener routes CONNECT requests through tsnet, so the app's HTTP stack can
// reach any tailnet target without per-target forward plumbing.
package mobiletsnet

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

const (
	socksVersion           = 5
	socksAuthNone          = 0
	socksAuthNoAcceptable  = 0xFF
	socksCmdConnect        = 1
	socksRepSuccess        = 0
	socksRepDialFailed     = 5
	socksRepCmdUnsupported = 7
	// Handshake-bound cap so a stuck client cannot pin a goroutine forever.
	socksHandshakeTimeout = 30 * time.Second
)

// dialFunc abstracts tsnet.Server.Dial so tests can inject a fake tailnet.
type dialFunc func(ctx context.Context, network, address string) (net.Conn, error)

type socksProxy struct {
	listener net.Listener
	cancel   context.CancelFunc
	done     chan struct{}
	dial     dialFunc
}

// StartSocks5 binds the loopback SOCKS5 proxy. A localPort of zero selects an
// available ephemeral port. Requires a connected node. Restarting replaces
// the previous listener (last configuration wins).
func (f *Forwarder) StartSocks5(localPort int) (int, error) {
	if localPort < 0 || localPort > 65535 {
		return 0, fmt.Errorf("invalid local port %d", localPort)
	}
	f.mu.Lock()
	server := f.server
	// Mirror StartForward: only a fully connected node may serve traffic.
	if server == nil || f.phase != "connected" {
		f.mu.Unlock()
		return 0, errors.New("tsnet is not connected")
	}
	f.mu.Unlock()
	return f.startSocks5WithDialer(server.Dial, localPort)
}

// startSocks5WithDialer is the testable core: it binds the proxy with an
// arbitrary dial function instead of requiring a live tsnet server.
func (f *Forwarder) startSocks5WithDialer(dial dialFunc, localPort int) (int, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(localPort)))
	if err != nil {
		return 0, fmt.Errorf("listen socks5 on local port %d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	proxy := &socksProxy{listener: listener, cancel: cancel, done: make(chan struct{}), dial: dial}

	f.forwardMu.Lock()
	previous := f.socks
	f.socks = proxy
	f.forwardMu.Unlock()
	if previous != nil {
		previous.stop()
	}

	go proxy.acceptLoop(ctx, f)
	return proxy.listener.Addr().(*net.TCPAddr).Port, nil
}

// StopSocks5 closes the loopback proxy, if one is running. It is idempotent.
func (f *Forwarder) StopSocks5() {
	f.forwardMu.Lock()
	proxy := f.socks
	f.socks = nil
	f.forwardMu.Unlock()
	if proxy != nil {
		proxy.stop()
	}
}

// GetSocksPort returns the bound loopback port, or 0 when no proxy is running.
func (f *Forwarder) GetSocksPort() int {
	f.forwardMu.RLock()
	defer f.forwardMu.RUnlock()
	if f.socks != nil {
		return f.socks.listener.Addr().(*net.TCPAddr).Port
	}
	return 0
}

func (p *socksProxy) stop() {
	p.cancel()
	_ = p.listener.Close()
	<-p.done
}

func (p *socksProxy) acceptLoop(ctx context.Context, f *Forwarder) {
	defer func() {
		if recovered := recover(); recovered != nil {
			f.setLastErr(fmt.Errorf("socks5 accept panic: %v", recovered))
		}
	}()
	defer close(p.done)

	const minBackoff = 100 * time.Millisecond
	const maxBackoff = time.Second
	backoff := minBackoff
	logged := false
	for {
		client, err := p.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
			}
			// A closed listener means the proxy was stopped on purpose.
			if errors.Is(err, net.ErrClosed) {
				return
			}
			// Transient accept failures (fd exhaustion and friends) must not
			// kill the proxy: back off and retry until it is stopped.
			if !logged {
				f.setLastErr(fmt.Errorf("socks5 accept: %w", err))
				logged = true
			}
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}
		logged = false
		backoff = minBackoff
		go p.handle(ctx, f, client)
	}
}

func (p *socksProxy) handle(parent context.Context, f *Forwarder, client net.Conn) {
	defer func() {
		if recovered := recover(); recovered != nil {
			f.setLastErr(fmt.Errorf("socks5 handler panic: %v", recovered))
		}
	}()
	defer client.Close()

	target, err := p.handshake(client)
	if err != nil {
		f.setLastErr(fmt.Errorf("socks5 handshake: %w", err))
		return
	}
	ctx, cancel := context.WithTimeout(parent, defaultDialTimeout)
	defer cancel()
	remote, err := p.dial(ctx, "tcp", target)
	if err != nil {
		_ = writeSocksReply(client, socksRepDialFailed)
		f.setLastErr(fmt.Errorf("socks5 dial %s: %w", target, err))
		return
	}
	defer remote.Close()
	if err := writeSocksReply(client, socksRepSuccess); err != nil {
		return
	}

	copyDone := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, client); copyDone <- struct{}{} }()
	go func() { _, _ = io.Copy(client, remote); copyDone <- struct{}{} }()
	<-copyDone
}

// handshake performs the method negotiation and reads the CONNECT request. It
// returns the "host:port" dial target, or an error after sending the matching
// failure reply where the protocol allows one.
func (p *socksProxy) handshake(client net.Conn) (string, error) {
	if err := client.SetReadDeadline(time.Now().Add(socksHandshakeTimeout)); err != nil {
		return "", fmt.Errorf("set handshake deadline: %w", err)
	}
	header := make([]byte, 2)
	if _, err := io.ReadFull(client, header); err != nil {
		return "", fmt.Errorf("read method header: %w", err)
	}
	if header[0] != socksVersion {
		return "", fmt.Errorf("unsupported version %d", header[0])
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return "", fmt.Errorf("read methods: %w", err)
	}
	supported := false
	for _, method := range methods {
		if method == socksAuthNone {
			supported = true
		}
	}
	if !supported {
		_ = writeSocksReplyByte(client, socksAuthNoAcceptable)
		return "", errors.New("client offered no supported auth method")
	}
	if err := writeSocksReplyByte(client, socksAuthNone); err != nil {
		return "", fmt.Errorf("reply method: %w", err)
	}

	request := make([]byte, 4)
	if _, err := io.ReadFull(client, request); err != nil {
		return "", fmt.Errorf("read request header: %w", err)
	}
	if request[0] != socksVersion {
		return "", fmt.Errorf("unsupported version %d", request[0])
	}
	if request[1] != socksCmdConnect {
		_ = writeSocksReply(client, socksRepCmdUnsupported)
		return "", fmt.Errorf("unsupported command %d", request[1])
	}

	var host string
	switch request[3] {
	case 1:
		raw := make([]byte, 4)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", fmt.Errorf("read ipv4 target: %w", err)
		}
		host = net.IP(raw).String()
	case 3:
		raw := make([]byte, 1)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", fmt.Errorf("read domain length: %w", err)
		}
		name := make([]byte, int(raw[0]))
		if _, err := io.ReadFull(client, name); err != nil {
			return "", fmt.Errorf("read domain target: %w", err)
		}
		host = string(name)
	case 4:
		raw := make([]byte, 16)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", fmt.Errorf("read ipv6 target: %w", err)
		}
		host = net.IP(raw).String()
	default:
		return "", fmt.Errorf("unsupported address type %d", request[3])
	}
	portRaw := make([]byte, 2)
	if _, err := io.ReadFull(client, portRaw); err != nil {
		return "", fmt.Errorf("read target port: %w", err)
	}
	port := int(binary.BigEndian.Uint16(portRaw))
	if err := client.SetReadDeadline(time.Time{}); err != nil {
		return "", fmt.Errorf("clear handshake deadline: %w", err)
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// writeSocksReplyByte sends the single-byte method-selection reply.
func writeSocksReplyByte(w io.Writer, code byte) error {
	_, err := w.Write([]byte{socksVersion, code})
	return err
}

// writeSocksReply sends a complete request reply with a zero bind endpoint.
func writeSocksReply(w io.Writer, code byte) error {
	_, err := w.Write([]byte{socksVersion, code, 0, 1, 0, 0, 0, 0, 0, 0})
	return err
}
