package mobiletsnet

import "testing"

func TestParseTarget(t *testing.T) {
	cases := []struct {
		in      string
		host    string
		port    int
		tls     bool
		wantErr bool
	}{
		{in: "http://100.64.12.34:4096", host: "100.64.12.34", port: 4096},
		{in: "http://my-mac.tailnet.ts.net", host: "my-mac.tailnet.ts.net", port: 80},
		{in: "https://opencode.example.com", host: "opencode.example.com", port: 443, tls: true},
		{in: " https://opencode.example.com:8443/ ", host: "opencode.example.com", port: 8443, tls: true},
		{in: "ftp://example.com", wantErr: true},
		{in: "http://", wantErr: true},
		{in: "http://host:99999", wantErr: true},
		{in: "not a url", wantErr: true},
		{in: "", wantErr: true},
	}
	for _, tc := range cases {
		host, port, tls, err := parseTarget(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("parseTarget(%q) = %q:%d, want error", tc.in, host, port)
			}
			continue
		}
		if err != nil {
			t.Fatalf("parseTarget(%q) error = %v", tc.in, err)
		}
		if host != tc.host || port != tc.port || tls != tc.tls {
			t.Fatalf("parseTarget(%q) = %q:%d tls=%v, want %q:%d tls=%v", tc.in, host, port, tls, tc.host, tc.port, tc.tls)
		}
	}
}

func TestStartForwardAutoRejectsBadTarget(t *testing.T) {
	f := New()
	if _, err := f.StartForwardAuto("ftp://example.com", 0); err == nil {
		t.Fatal("StartForwardAuto accepted an unsupported scheme")
	}
	if _, err := f.StartForwardAuto("", 0); err == nil {
		t.Fatal("StartForwardAuto accepted an empty target")
	}
}

func TestConfigureControlValidatesURL(t *testing.T) {
	f := New()
	if err := f.ConfigureControl("tskey-auth-test", "notaurl", "android", t.TempDir()); err == nil {
		t.Fatal("ConfigureControl accepted a control URL without a scheme")
	}
	if err := f.ConfigureControl("tskey-auth-test", "https://headscale.example.com", "android", t.TempDir()); err != nil {
		t.Fatalf("ConfigureControl() error = %v", err)
	}
}
