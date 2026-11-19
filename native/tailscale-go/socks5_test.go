package mobiletsnet

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"testing"
)

// startEchoServer binds a loopback TCP server that echoes every byte back,
// standing in for a tailnet service.
func startEchoServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen echo server: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(client net.Conn) {
				defer client.Close()
				_, _ = io.Copy(client, client)
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().String()
}

// dialerTo ignores the requested SOCKS target and always dials addr — the
// fake tailnet.
func dialerTo(addr string) dialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, addr)
	}
}

func dialerFails() dialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		return nil, fmt.Errorf("fake tailnet unreachable")
	}
}

func startTestProxy(t *testing.T, f *Forwarder, dial dialFunc) int {
	t.Helper()
	f.mu.Lock()
	port, err := f.startSocks5Locked(dial, nil, 0)
	f.mu.Unlock()
	if err != nil {
		t.Fatalf("startSocks5Locked() error = %v", err)
	}
	t.Cleanup(f.StopSocks5)
	return port
}

func dialProxy(t *testing.T, port int) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	return conn
}

// socksHandshake sends the method negotiation and returns the chosen method.
func socksHandshake(t *testing.T, conn net.Conn, methods ...byte) byte {
	t.Helper()
	if _, err := conn.Write(append([]byte{socksVersion, byte(len(methods))}, methods...)); err != nil {
		t.Fatalf("write methods: %v", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("read method reply: %v", err)
	}
	if reply[0] != socksVersion {
		t.Fatalf("method reply version = %d, want %d", reply[0], socksVersion)
	}
	return reply[1]
}

// socksRequest sends a request and returns the reply code.
func socksRequest(t *testing.T, conn net.Conn, cmd byte, target string) byte {
	t.Helper()
	host, portRaw, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatalf("split target %q: %v", target, err)
	}
	port, err := strconv.Atoi(portRaw)
	if err != nil {
		t.Fatalf("parse port %q: %v", portRaw, err)
	}
	request := []byte{socksVersion, cmd, 0}
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append(request, 1)
		request = append(request, ip.To4()...)
	} else {
		request = append(request, 3, byte(len(host)))
		request = append(request, host...)
	}
	var portBytes [2]byte
	binary.BigEndian.PutUint16(portBytes[:], uint16(port))
	request = append(request, portBytes[:]...)
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("write request: %v", err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("read request reply: %v", err)
	}
	if reply[0] != socksVersion {
		t.Fatalf("reply version = %d, want %d", reply[0], socksVersion)
	}
	return reply[1]
}

func TestSocks5ConnectEcho(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	port := startTestProxy(t, f, dialerTo(target))

	conn := dialProxy(t, port)
	defer conn.Close()
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.1.2:4096"); code != socksRepSuccess {
		t.Fatalf("connect reply = %d, want %d", code, socksRepSuccess)
	}

	payload := []byte("ping through the tunnel")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("echo = %q, want %q", got, payload)
	}
}

func TestSocks5ConnectDomainTarget(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	port := startTestProxy(t, f, dialerTo(target))

	conn := dialProxy(t, port)
	defer conn.Close()
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "node.tailnet:8443"); code != socksRepSuccess {
		t.Fatalf("connect reply = %d, want %d", code, socksRepSuccess)
	}
}

func TestSocks5RejectsUnsupportedCommand(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	port := startTestProxy(t, f, dialerTo(target))

	conn := dialProxy(t, port)
	defer conn.Close()
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, 2, target); code != socksRepCmdUnsupported {
		t.Fatalf("bind reply = %d, want %d", code, socksRepCmdUnsupported)
	}
}

func TestSocks5DialFailureReply(t *testing.T) {
	f := New()
	port := startTestProxy(t, f, dialerFails())

	conn := dialProxy(t, port)
	defer conn.Close()
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.9.9:80"); code != socksRepDialFailed {
		t.Fatalf("dial failure reply = %d, want %d", code, socksRepDialFailed)
	}
}

func TestSocks5NoAcceptableAuthMethod(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	port := startTestProxy(t, f, dialerTo(target))

	conn := dialProxy(t, port)
	defer conn.Close()
	if method := socksHandshake(t, conn, 1, 2); method != socksAuthNoAcceptable {
		t.Fatalf("method reply = %d, want %d", method, socksAuthNoAcceptable)
	}
}

func TestSocks5TargetAllowlist(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	f.mu.Lock()
	port, err := f.startSocks5Locked(dialerTo(target), f.socksTargetAllowed, 0)
	f.mu.Unlock()
	if err != nil {
		t.Fatalf("startSocks5Locked() error = %v", err)
	}
	t.Cleanup(f.StopSocks5)

	// Unregistered targets are refused with "connection not allowed".
	conn := dialProxy(t, port)
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.9.9:80"); code != socksRepNotAllowed {
		t.Fatalf("unregistered reply = %d, want %d", code, socksRepNotAllowed)
	}
	conn.Close()

	// A registered target connects, and registration is host-case-insensitive.
	f.AllowSocksTarget("100.64.1.2:4096")
	f.AllowSocksTarget("NODE.Tailnet:8443")
	conn = dialProxy(t, port)
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.1.2:4096"); code != socksRepSuccess {
		t.Fatalf("registered reply = %d, want %d", code, socksRepSuccess)
	}
	conn.Close()
	conn = dialProxy(t, port)
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "node.tailnet:8443"); code != socksRepSuccess {
		t.Fatalf("case-insensitive reply = %d, want %d", code, socksRepSuccess)
	}
	conn.Close()

	// Removal and clearing both re-arm the refusal.
	f.DisallowSocksTarget("100.64.1.2:4096")
	conn = dialProxy(t, port)
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.1.2:4096"); code != socksRepNotAllowed {
		t.Fatalf("disallowed reply = %d, want %d", code, socksRepNotAllowed)
	}
	conn.Close()

	f.AllowSocksTarget("100.64.1.2:4096")
	f.ClearSocksTargets()
	conn = dialProxy(t, port)
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.1.2:4096"); code != socksRepNotAllowed {
		t.Fatalf("cleared reply = %d, want %d", code, socksRepNotAllowed)
	}
	conn.Close()
}

// A nil allowlist lets every target through; production always installs the
// forwarder's real allowlist (see TestSocks5TargetAllowlist).
func TestSocks5NilAllowlistAllowsAll(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	f.mu.Lock()
	port, err := f.startSocks5Locked(dialerTo(target), nil, 0)
	f.mu.Unlock()
	if err != nil {
		t.Fatalf("startSocks5Locked() error = %v", err)
	}
	t.Cleanup(f.StopSocks5)
	if f.socks.allowed != nil {
		t.Fatal("expected a nil allowlist callback in tests")
	}
	conn := dialProxy(t, port)
	defer conn.Close()
	if method := socksHandshake(t, conn, 0); method != socksAuthNone {
		t.Fatalf("negotiated method = %d, want %d", method, socksAuthNone)
	}
	if code := socksRequest(t, conn, socksCmdConnect, "100.64.9.9:80"); code != socksRepSuccess {
		t.Fatalf("nil-allowlist reply = %d, want %d", code, socksRepSuccess)
	}
}

func TestStartSocks5RequiresConnectedNode(t *testing.T) {
	f := New()
	if _, err := f.StartSocks5(0); err == nil {
		t.Fatal("StartSocks5() on an unconnected forwarder should fail")
	}
}

func TestSocks5RestartReplacesListener(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	first := startTestProxy(t, f, dialerTo(target))
	f.mu.Lock()
	second, err := f.startSocks5Locked(dialerTo(target), nil, 0)
	f.mu.Unlock()
	if err != nil {
		t.Fatalf("restart error = %v", err)
	}
	if first == second {
		t.Fatalf("restart reused port %d, want a fresh listener", first)
	}
	if got := f.GetSocksPort(); got != second {
		t.Errorf("GetSocksPort() = %d, want %d", got, second)
	}
	if conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(first))); err == nil {
		conn.Close()
		t.Errorf("old listener on port %d still accepting", first)
	}
}

func TestStopSocks5IsIdempotent(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	port := startTestProxy(t, f, dialerTo(target))
	f.StopSocks5()
	f.StopSocks5()
	if got := f.GetSocksPort(); got != 0 {
		t.Errorf("GetSocksPort() after stop = %d, want 0", got)
	}
	if conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port))); err == nil {
		conn.Close()
		t.Errorf("proxy port %d still accepting after stop", port)
	}
}

func TestCloseStopsSocks5Proxy(t *testing.T) {
	target := startEchoServer(t)
	f := New()
	port := startTestProxy(t, f, dialerTo(target))
	f.Close()
	if got := f.GetSocksPort(); got != 0 {
		t.Errorf("GetSocksPort() after Close = %d, want 0", got)
	}
	if conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port))); err == nil {
		conn.Close()
		t.Errorf("proxy port %d still accepting after Close", port)
	}
}
