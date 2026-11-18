package mobiletsnet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// parseTarget splits an upstream server URL into dial components. Only http
// and https are accepted; the port defaults to the scheme's well-known port
// when absent.
func parseTarget(targetURL string) (host string, port int, isTLS bool, err error) {
	parsed, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil {
		return "", 0, false, fmt.Errorf("parse target url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", 0, false, fmt.Errorf("unsupported target scheme %q", parsed.Scheme)
	}
	host = parsed.Hostname()
	if host == "" {
		return "", 0, false, errors.New("target url is missing a host")
	}
	portStr := parsed.Port()
	if portStr == "" {
		if parsed.Scheme == "https" {
			portStr = "443"
		} else {
			portStr = "80"
		}
	}
	port, err = strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, false, fmt.Errorf("invalid target port %q", portStr)
	}
	return host, port, parsed.Scheme == "https", nil
}

// StartForwardAuto forwards a loopback port to the server described by
// targetURL. http targets use the raw TCP pipe (StartForwardID); https targets
// are served through a streaming reverse proxy that completes the upstream TLS
// handshake itself, because a raw byte pipe cannot carry the handshake. The
// returned string is a forward ID — retrieve the chosen local port with
// GetForwardLocalPort. A localPort of zero selects an ephemeral port.
func (f *Forwarder) StartForwardAuto(targetURL string, localPort int) (string, error) {
	host, port, isTLS, err := parseTarget(targetURL)
	if err != nil {
		return "", err
	}
	if !isTLS {
		return f.StartForwardID(host, port, localPort)
	}
	return f.startHTTPForwardID(targetURL, port, localPort)
}

func (f *Forwarder) startHTTPForwardID(targetURL string, port, localPort int) (string, error) {
	target, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil {
		return "", fmt.Errorf("parse target url: %w", err)
	}
	// Hold f.mu across the liveness check, listener creation, and map insert so
	// a concurrent Close cannot slip in between and leak the listener.
	f.mu.Lock()
	server := f.server
	if server == nil {
		f.mu.Unlock()
		return "", errors.New("tsnet is not connected")
	}

	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// Dial through tsnet so hostnames resolve via the tailnet's
			// MagicDNS and traffic rides the WireGuard tunnel.
			return server.Dial(ctx, network, addr)
		},
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = transport
	// Flush every write immediately so Server-Sent Events reach the app
	// token-by-token instead of being buffered by the proxy.
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		f.setLastErr(fmt.Errorf("proxy %s: %w", target.Host, err))
		w.WriteHeader(http.StatusBadGateway)
	}

	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(localPort)))
	if err != nil {
		f.mu.Unlock()
		return "", fmt.Errorf("listen on local port %d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	item := &forward{
		Forward: Forward{
			ID:         "http->" + listener.Addr().String(),
			RemoteHost: target.Host,
			RemotePort: port,
			LocalPort:  listener.Addr().(*net.TCPAddr).Port,
		},
		listener: listener,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	f.forwardMu.Lock()
	f.forwards[item.ID] = item
	f.forwardMu.Unlock()
	f.mu.Unlock()

	srv := &http.Server{Handler: proxy}
	go func() {
		defer close(item.done)
		defer func() {
			_ = listener.Close()
			f.forwardMu.Lock()
			delete(f.forwards, item.ID)
			f.forwardMu.Unlock()
		}()
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			f.setLastErr(fmt.Errorf("http forward %s: %w", item.ID, err))
		}
	}()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	return item.ID, nil
}
