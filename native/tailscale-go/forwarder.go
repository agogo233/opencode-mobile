// Package mobiletsnet exposes an application-scoped TCP forwarder backed by
// Tailscale tsnet. It intentionally does not create a system VPN interface.
package mobiletsnet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

const (
	defaultConnectTimeout = 60 * time.Second
	defaultDialTimeout    = 15 * time.Second
	// Keep the on-disk marker name stable so existing node identities can be reused.
	persistedLoginMarker = ".libtsnet-enrolled"
)

// State is a stable snapshot suitable for exposing to Android bindings.
type State struct {
	Phase          string
	Hostname       string
	LocalAddresses []string
	ForwardCount   int
	LastError      string
}

// Forward describes one loopback listener and its Tailscale destination.
type Forward struct {
	ID         string
	RemoteHost string
	RemotePort int
	LocalPort  int
}

type forward struct {
	Forward
	listener net.Listener
	cancel   context.CancelFunc
	done     chan struct{}
}

// Forwarder owns one tsnet server and zero or more loopback forwards.
type Forwarder struct {
	mu         sync.RWMutex
	forwardMu  sync.RWMutex
	server     *tsnet.Server
	authKey    string
	controlURL string
	hostname   string
	stateDir   string
	phase      string
	lastErr    string
	forwards   map[string]*forward
}

// New returns an unconfigured forwarder.
func New() *Forwarder {
	return &Forwarder{
		phase:    "new",
		forwards: make(map[string]*forward),
	}
}

// Configure sets the tsnet credentials and persistent state directory.
// Configuration is rejected while the server is active.
func (f *Forwarder) Configure(authKey, hostname, stateDir string) error {
	authKey = strings.TrimSpace(authKey)
	hostname = strings.TrimSpace(hostname)
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return errors.New("state directory is required")
	}
	stateDir = filepath.Clean(stateDir)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	if authKey == "" {
		if _, err := os.Stat(filepath.Join(stateDir, persistedLoginMarker)); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("auth key is required for first-time enrollment")
			}
			return fmt.Errorf("check existing tsnet state: %w", err)
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.server != nil {
		return errors.New("cannot configure an active forwarder")
	}
	f.authKey = authKey
	f.hostname = hostname
	f.stateDir = stateDir
	if f.forwards == nil {
		f.forwards = make(map[string]*forward)
	}
	f.phase = "configured"
	f.lastErr = ""
	return nil
}

// ConfigureControl behaves like Configure and additionally points the node at
// a custom control-plane server, for example a self-hosted Headscale. An
// empty controlURL keeps the default Tailscale coordination server.
func (f *Forwarder) ConfigureControl(authKey, controlURL, hostname, stateDir string) error {
	controlURL = strings.TrimSpace(controlURL)
	if controlURL != "" && !strings.HasPrefix(controlURL, "http://") && !strings.HasPrefix(controlURL, "https://") {
		return errors.New("control URL must start with http:// or https://")
	}
	if err := f.Configure(authKey, hostname, stateDir); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.server != nil {
		return errors.New("cannot configure an active forwarder")
	}
	f.controlURL = controlURL
	return nil
}

// Connect starts tsnet and waits for it to become usable.
func (f *Forwarder) Connect() (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("connect tsnet panic: %v", recovered)
			f.setError(err)
			err = f.redactErr(err)
		}
	}()
	f.mu.Lock()
	if f.server != nil {
		// Idempotent re-entry: report a healthy node instead of the phase a
		// previous forward-level error left behind.
		f.phase = "connected"
		f.lastErr = ""
		f.mu.Unlock()
		return nil
	}
	// An empty auth key is valid when Configure found an enrolled state
	// directory. tsnet then restores the existing node identity from Dir.
	if f.stateDir == "" {
		f.mu.Unlock()
		return errors.New("forwarder is not configured")
	}
	server := &tsnet.Server{
		AuthKey:    f.authKey,
		ControlURL: f.controlURL,
		Hostname:   f.hostname,
		Dir:        f.stateDir,
		Logf:       f.logf,
		UserLogf:   f.logf,
	}
	// Android does not provide the Unix cache/temp locations that Tailscale's
	// log policy normally discovers. Reuse the app-private tsnet directory.
	if err := os.Setenv("TS_LOGS_DIR", f.stateDir); err != nil {
		f.mu.Unlock()
		wrapped := fmt.Errorf("set tsnet log directory: %w", err)
		f.setError(wrapped)
		return f.redactErr(wrapped)
	}
	f.phase = "connecting"
	f.lastErr = ""
	f.mu.Unlock()

	if err := server.Start(); err != nil {
		wrapped := fmt.Errorf("start tsnet: %w", err)
		f.setError(wrapped)
		return f.redactErr(wrapped)
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultConnectTimeout)
	defer cancel()
	if _, err := server.Up(ctx); err != nil {
		_ = server.Close()
		wrapped := fmt.Errorf("bring tsnet up: %w", err)
		f.setError(wrapped)
		return f.redactErr(wrapped)
	}
	if err := os.WriteFile(filepath.Join(f.stateDir, persistedLoginMarker), nil, 0o600); err != nil {
		_ = server.Close()
		wrapped := fmt.Errorf("persist tsnet enrollment marker: %w", err)
		f.setError(wrapped)
		return f.redactErr(wrapped)
	}

	f.mu.Lock()
	f.server = server
	f.phase = "connected"
	f.lastErr = ""
	f.mu.Unlock()
	return nil
}

// HasPersistedLogin reports whether a previous Connect completed successfully
// for the supplied state directory.
func (f *Forwarder) HasPersistedLogin(stateDir string) bool {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(filepath.Clean(stateDir), persistedLoginMarker))
	return err == nil && !info.IsDir()
}

// StartForward binds a loopback listener. A localPort of zero selects an
// available ephemeral port. The returned Forward contains the chosen port.
func (f *Forwarder) StartForward(remoteHost string, remotePort, localPort int) (ret Forward, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("start forward panic: %v", recovered)
			f.setLastErr(err)
		}
	}()
	remoteHost = strings.TrimSpace(remoteHost)
	if remoteHost == "" {
		return Forward{}, errors.New("remote host is required")
	}
	if remotePort < 1 || remotePort > 65535 {
		return Forward{}, fmt.Errorf("invalid remote port %d", remotePort)
	}
	if localPort < 0 || localPort > 65535 {
		return Forward{}, fmt.Errorf("invalid local port %d", localPort)
	}

	// Hold f.mu across the liveness check, listener creation, and map insert so
	// a concurrent Close cannot slip in between and leak the listener.
	f.mu.Lock()
	server := f.server
	if server == nil {
		f.mu.Unlock()
		return Forward{}, errors.New("tsnet is not connected")
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(localPort)))
	if err != nil {
		f.mu.Unlock()
		return Forward{}, fmt.Errorf("listen on local port %d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := Forward{
		ID:         net.JoinHostPort(remoteHost, fmt.Sprint(remotePort)) + "->" + listener.Addr().String(),
		RemoteHost: remoteHost,
		RemotePort: remotePort,
		LocalPort:  listener.Addr().(*net.TCPAddr).Port,
	}
	item := &forward{Forward: result, listener: listener, cancel: cancel, done: make(chan struct{})}
	f.forwardMu.Lock()
	f.forwards[result.ID] = item
	f.forwardMu.Unlock()
	f.mu.Unlock()

	go f.acceptLoop(ctx, server, item)
	return result, nil
}

// StartForwardID is the gomobile-friendly form of StartForward. It returns a
// string ID; use GetForwardLocalPort to retrieve the selected local port.
func (f *Forwarder) StartForwardID(remoteHost string, remotePort, localPort int) (string, error) {
	item, err := f.StartForward(remoteHost, remotePort, localPort)
	if err != nil {
		return "", err
	}
	return item.ID, nil
}

// GetForwardLocalPort returns the local port assigned to a forward ID.
func (f *Forwarder) GetForwardLocalPort(id string) int {
	f.forwardMu.RLock()
	defer f.forwardMu.RUnlock()
	if item, ok := f.forwards[id]; ok {
		return item.LocalPort
	}
	return 0
}

func (f *Forwarder) acceptLoop(ctx context.Context, server *tsnet.Server, item *forward) {
	defer func() {
		if recovered := recover(); recovered != nil {
			f.setLastErr(fmt.Errorf("forward accept panic: %v", recovered))
		}
	}()
	defer close(item.done)
	defer func() {
		_ = item.listener.Close()
		f.forwardMu.Lock()
		delete(f.forwards, item.ID)
		f.forwardMu.Unlock()
	}()

	for {
		localConn, err := item.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
			}
			f.setLastErr(fmt.Errorf("accept forward %s: %w", item.ID, err))
			return
		}
		go f.proxy(ctx, server, item, localConn)
	}
}

func (f *Forwarder) proxy(parent context.Context, server *tsnet.Server, item *forward, local net.Conn) {
	defer func() {
		if recovered := recover(); recovered != nil {
			f.setLastErr(fmt.Errorf("forward proxy panic: %v", recovered))
		}
	}()
	defer local.Close()
	ctx, cancel := context.WithTimeout(parent, defaultDialTimeout)
	defer cancel()
	remote, err := server.Dial(ctx, "tcp", net.JoinHostPort(item.RemoteHost, fmt.Sprint(item.RemotePort)))
	if err != nil {
		f.setLastErr(fmt.Errorf("dial %s:%d: %w", item.RemoteHost, item.RemotePort, err))
		return
	}
	defer remote.Close()

	copyDone := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, local); copyDone <- struct{}{} }()
	go func() { _, _ = io.Copy(local, remote); copyDone <- struct{}{} }()
	<-copyDone
}

// StopForward closes one listener and waits for its accept loop to exit.
func (f *Forwarder) StopForward(id string) error {
	f.forwardMu.RLock()
	item, ok := f.forwards[id]
	f.forwardMu.RUnlock()
	if !ok {
		return nil
	}
	item.cancel()
	_ = item.listener.Close()
	<-item.done
	return nil
}

// StopAll closes all active loopback forwards.
func (f *Forwarder) StopAll() {
	f.forwardMu.RLock()
	ids := make([]string, 0, len(f.forwards))
	for id := range f.forwards {
		ids = append(ids, id)
	}
	f.forwardMu.RUnlock()
	for _, id := range ids {
		_ = f.StopForward(id)
	}
}

// Status returns a copy of the current forwarder state.
func (f *Forwarder) Status() State {
	f.mu.RLock()
	f.forwardMu.RLock()
	forwardCount := len(f.forwards)
	f.forwardMu.RUnlock()
	state := State{
		Phase:        f.phase,
		Hostname:     f.hostname,
		ForwardCount: forwardCount,
		LastError:    f.lastErr,
	}
	server := f.server
	f.mu.RUnlock()
	if server != nil {
		ip4, ip6 := server.TailscaleIPs()
		if ip4.IsValid() {
			state.LocalAddresses = append(state.LocalAddresses, ip4.String())
		}
		if ip6.IsValid() {
			state.LocalAddresses = append(state.LocalAddresses, ip6.String())
		}
	}
	return state
}

// GetPhase returns the current lifecycle phase.
func (f *Forwarder) GetPhase() string { return f.Status().Phase }

// GetHostname returns the configured tsnet hostname.
func (f *Forwarder) GetHostname() string { return f.Status().Hostname }

// GetForwardCount returns the number of active loopback forwards.
func (f *Forwarder) GetForwardCount() int { return f.Status().ForwardCount }

// GetLastError returns the last connection or forwarding error.
func (f *Forwarder) GetLastError() string { return f.Status().LastError }

// GetTailscaleIPv4 returns the first assigned Tailscale IPv4 address.
func (f *Forwarder) GetTailscaleIPv4() string {
	addresses := f.Status().LocalAddresses
	for _, address := range addresses {
		if strings.Contains(address, ".") {
			return address
		}
	}
	return ""
}

// GetTailscaleIPv6 returns the first assigned Tailscale IPv6 address.
func (f *Forwarder) GetTailscaleIPv6() string {
	addresses := f.Status().LocalAddresses
	for _, address := range addresses {
		if strings.Contains(address, ":") {
			return address
		}
	}
	return ""
}

// Close stops all forwards and closes the tsnet server. It is idempotent.
func (f *Forwarder) Close() {
	f.StopAll()
	f.mu.Lock()
	server := f.server
	f.server = nil
	f.phase = "closed"
	f.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
}

func (f *Forwarder) setError(err error) {
	// Node-level failure: the tsnet server itself is unusable.
	f.mu.Lock()
	f.lastErr = f.redactLocked(err.Error())
	f.phase = "error"
	f.mu.Unlock()
}

// redactErr returns a copy of err's message with the auth key stripped, safe
// to hand across the binding boundary into UI-visible error text.
func (f *Forwarder) redactErr(err error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return errors.New(f.redactLocked(err.Error()))
}

// setLastErr records a forward-level failure (one loopback pipe or one dial)
// without touching the node lifecycle phase: the tailnet node is still up, so
// a single unreachable target must not make the UI restart the whole node.
func (f *Forwarder) setLastErr(err error) {
	f.mu.Lock()
	f.lastErr = f.redactLocked(err.Error())
	f.mu.Unlock()
}

// redactLocked strips the auth key from a message. Callers must hold f.mu.
func (f *Forwarder) redactLocked(msg string) string {
	if f.authKey != "" {
		msg = strings.ReplaceAll(msg, f.authKey, "[redacted]")
	}
	return msg
}

// logf routes tsnet's own logs through the standard logger while keeping the
// auth key out of anything that could end up in logcat or the state dir. The
// message is rendered first and redacted as a whole, so a key embedded in a
// non-string argument (e.g. an error value) is covered too.
func (f *Forwarder) logf(format string, args ...any) {
	f.mu.RLock()
	secret := f.authKey
	f.mu.RUnlock()
	msg := format
	if len(args) > 0 {
		msg = fmt.Sprintf(format, args...)
	}
	if secret != "" {
		msg = strings.ReplaceAll(msg, secret, "[redacted]")
	}
	log.Printf("tsnet: %s", msg)
}
