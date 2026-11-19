package mobiletsnet

import (
	"os"
	"path/filepath"
	"testing"

	"tailscale.com/tsnet"
)

func TestNewState(t *testing.T) {
	f := New()
	state := f.Status()
	if state.Phase != "new" {
		t.Fatalf("phase = %q, want new", state.Phase)
	}
	if state.ForwardCount != 0 {
		t.Fatalf("forward count = %d, want 0", state.ForwardCount)
	}
}

func TestConfigureAllowsEmptyAuthKey(t *testing.T) {
	f := New()
	if err := f.Configure("", "android", t.TempDir()); err != nil {
		t.Fatalf("Configure() error = %v", err)
	}
	if err := f.Configure("tskey-auth-test", "android", ""); err == nil {
		t.Fatal("Configure accepted an empty state directory")
	}
}

func TestCaptureLoginURL(t *testing.T) {
	f := New()
	f.mu.Lock()
	f.phase = "connecting"
	f.mu.Unlock()

	f.logf("To authenticate, visit https://headscale.example.com/a/Ab12Cd34.")
	if got := f.GetLoginURL(); got != "https://headscale.example.com/a/Ab12Cd34" {
		t.Fatalf("login URL = %q, want the enrollment link", got)
	}
	if got := f.Status().LoginURL; got != f.GetLoginURL() {
		t.Fatalf("Status().LoginURL = %q, want %q", got, f.GetLoginURL())
	}

	// Unrelated log lines must not touch the captured URL.
	f.logf("control: https://controlplane.tailscale.com")
	if got := f.GetLoginURL(); got != "https://headscale.example.com/a/Ab12Cd34" {
		t.Fatalf("login URL = %q after unrelated log line", got)
	}

	// Once connected the URL is cleared and stays empty.
	f.mu.Lock()
	f.phase = "connected"
	f.loginURL = ""
	f.mu.Unlock()
	f.logf("To authenticate, visit https://headscale.example.com/a/Ab12Cd34.")
	if got := f.GetLoginURL(); got != "" {
		t.Fatalf("login URL = %q after connect, want empty", got)
	}
}

func TestConfigureAllowsExistingStateWithoutAuthKey(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, persistedLoginMarker), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	f := New()
	if err := f.Configure("", "android", stateDir); err != nil {
		t.Fatalf("Configure() error = %v", err)
	}
}

func TestHasPersistedLogin(t *testing.T) {
	f := New()
	stateDir := t.TempDir()
	if f.HasPersistedLogin(stateDir) {
		t.Fatal("empty state directory reported a persisted login")
	}
	if err := os.WriteFile(filepath.Join(stateDir, persistedLoginMarker), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !f.HasPersistedLogin(stateDir) {
		t.Fatal("persisted login marker was not detected")
	}
}

func TestConfigurePersistsNormalizedState(t *testing.T) {
	f := New()
	stateDir := filepath.Join(t.TempDir(), "nested", "tsnet")
	if err := f.Configure(" tskey-auth-test ", " android ", stateDir); err != nil {
		t.Fatalf("Configure() error = %v", err)
	}
	state := f.Status()
	if state.Phase != "configured" {
		t.Fatalf("phase = %q, want configured", state.Phase)
	}
	if state.Hostname != "android" {
		t.Fatalf("hostname = %q, want android", state.Hostname)
	}
	if f.stateDir != filepath.Clean(stateDir) {
		t.Fatalf("state dir = %q, want %q", f.stateDir, filepath.Clean(stateDir))
	}
}

func TestStartForwardValidation(t *testing.T) {
	f := New()
	cases := []struct {
		name       string
		host       string
		remotePort int
		localPort  int
	}{
		{name: "blank host", host: " ", remotePort: 5555},
		{name: "bad remote port", host: "100.64.0.1", remotePort: 0},
		{name: "bad local port", host: "100.64.0.1", remotePort: 5555, localPort: 65536},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.StartForward(tc.host, tc.remotePort, tc.localPort); err == nil {
				t.Fatal("StartForward accepted invalid input")
			}
		})
	}
}

// A same-ID entry that is still registered while its accept loop has already
// exited (the replacement race window) must be retired by the next
// StartForward, not orphaned outside the map.
func TestStartForwardRetiresReplacedSameID(t *testing.T) {
	f := New()
	// Stop the replacement forward when the test ends; Close is overkill here
	// (the fake server never started) and StopAll reclaims the listener.
	t.Cleanup(f.StopAll)
	f.mu.Lock()
	f.server = &tsnet.Server{}
	f.phase = "connected"
	f.mu.Unlock()

	const localPort = 45971
	first, err := f.StartForward("100.64.0.1", 4096, localPort)
	if err != nil {
		t.Fatalf("StartForward() error = %v", err)
	}
	f.forwardMu.RLock()
	retired := f.forwards[first.ID]
	f.forwardMu.RUnlock()
	if retired == nil {
		t.Fatal("forward was not registered")
	}
	if err := f.StopForward(first.ID); err != nil {
		t.Fatalf("StopForward() error = %v", err)
	}
	select {
	case <-retired.done:
	default:
		t.Fatal("retired forward loop did not exit")
	}
	// Re-insert the retired entry to simulate the race window.
	f.forwardMu.Lock()
	f.forwards[first.ID] = retired
	f.forwardMu.Unlock()

	second, err := f.StartForward("100.64.0.1", 4096, localPort)
	if err != nil {
		t.Fatalf("replacement StartForward() error = %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("replacement ID = %q, want %q", second.ID, first.ID)
	}
	f.forwardMu.RLock()
	_, retiredStillThere := f.forwards[first.ID]
	count := len(f.forwards)
	entry := f.forwards[first.ID]
	f.forwardMu.RUnlock()
	if count != 1 {
		t.Fatalf("forward count = %d, want 1", count)
	}
	if !retiredStillThere || entry == retired {
		t.Fatal("retired entry was not replaced by the new pipe")
	}
	if got := f.GetForwardLocalPort(first.ID); got != localPort {
		t.Fatalf("local port = %d, want %d", got, localPort)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	f := New()
	f.Close()
	f.Close()
	if got := f.Status().Phase; got != "closed" {
		t.Fatalf("phase = %q, want closed", got)
	}
}

func TestSetAndroidNetworkInterfaces(t *testing.T) {
	f := New()
	payload := `[{"name":"wlan0","index":30,"mtu":1500,"up":true,"broadcast":true,"loopback":false,"pointToPoint":false,"multicast":true,"addrs":[{"ip":"192.168.31.65","prefixLen":24}]}]`
	if err := f.SetAndroidNetworkInterfaces(payload, "wlan0"); err != nil {
		t.Fatalf("SetAndroidNetworkInterfaces() error = %v", err)
	}
	ifaces, err := androidInterfaces()
	if err != nil {
		t.Fatalf("androidInterfaces() error = %v", err)
	}
	if len(ifaces) != 1 || ifaces[0].Name != "wlan0" {
		t.Fatalf("interfaces = %#v, want wlan0", ifaces)
	}
	if len(ifaces[0].AltAddrs) != 1 || ifaces[0].AltAddrs[0].String() != "192.168.31.65/24" {
		t.Fatalf("addresses = %#v, want 192.168.31.65/24", ifaces[0].AltAddrs)
	}
}

func TestSetAndroidNetworkInterfacesRejectsInvalidJSON(t *testing.T) {
	f := New()
	if err := f.SetAndroidNetworkInterfaces("not-json", ""); err == nil {
		t.Fatal("accepted invalid Android interface JSON")
	}
}

func TestApplyAndroidDirs(t *testing.T) {
	for _, key := range []string{"TS_LOGS_DIR", "TMPDIR", "HOME"} {
		t.Setenv(key, "")
	}
	if err := applyAndroidDirs("/data/app/tailscale"); err != nil {
		t.Fatalf("applyAndroidDirs() error = %v", err)
	}
	for key, want := range map[string]string{
		"TS_LOGS_DIR": "/data/app/tailscale",
		"TMPDIR":      "/data/app/tailscale",
		"HOME":        "/data/app/tailscale",
	} {
		if got := os.Getenv(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestSetEphemeral(t *testing.T) {
	f := New()
	if f.ephemeral {
		t.Fatal("new forwarder is ephemeral by default")
	}
	f.SetEphemeral(true)
	if !f.ephemeral {
		t.Fatal("SetEphemeral(true) did not stick")
	}
	f.SetEphemeral(false)
	if f.ephemeral {
		t.Fatal("SetEphemeral(false) did not stick")
	}
}
