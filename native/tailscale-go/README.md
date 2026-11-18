# mobiletsnet

Embedded Tailscale connectivity for OpenCode Mobile: a `tsnet`-based TCP /
HTTP forwarder bound to loopback, so the app can reach an opencode server over
a tailnet without a system VPN interface or `VpnService` permission.

Vendored from [megumiss/tsnet-forwarder](https://github.com/megumiss/tsnet-forwarder)
(Apache-2.0, see `LICENSE`) with these local modifications:

- `ConfigureControl` adds a custom control-plane URL (self-hosted Headscale).
- `StartForwardAuto` dispatches by scheme: `http` targets use the original raw
  TCP pipe, `https` targets are served through a streaming reverse proxy
  (`FlushInterval = -1` so Server-Sent Events are not buffered).
- tsnet's own log output is routed through a redacting logger that strips the
  auth key.

## Build (Android AAR)

Requires Go 1.23+, `gomobile`/`gobind` (pinned in `go.mod`:
`golang.org/x/mobile v0.0.0-20240806205939-81131f6468ab`), a JDK with `javac`,
the Android SDK, and Android NDK 27.2.12479018.

```bash
./scripts/build-tailscale-aar.sh   # from the repository root
```

Output: `android/app/libs/mobiletsnet.aar` (arm64-v8a only, API 26+). The AAR
is a build artifact and is never committed; CI builds it for releases.
