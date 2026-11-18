#!/usr/bin/env bash
# Build the embedded Tailscale forwarder AAR consumed by android/app.
#
# Requirements: Go 1.23+ (GO env var overrides the binary), gomobile/gobind
# (installed by this script), a JDK with javac on PATH, and the Android SDK
# with NDK 27.2.12479018 (ANDROID_NDK_HOME / ANDROID_NDK_ROOT).
#
# Output: android/app/libs/mobiletsnet.aar (arm64-v8a + x86_64, API 26+).
# x86_64 is required so the CI emulator (x86_64) can install the APK; the
# release builds filter packaging to arm64-v8a anyway. The AAR is a build
# artifact — never commit it; CI builds and caches it automatically.
set -euo pipefail

cd "$(dirname "$0")/.."

GO_BIN="${GO:-go}"
GOMOBILE_VERSION="v0.0.0-20240806205939-81131f6468ab"

command -v "$GO_BIN" >/dev/null 2>&1 || { echo "Go 1.23+ is required (set GO=/path/to/go to override)"; exit 1; }
command -v javac >/dev/null 2>&1 || { echo "javac must be on PATH (install a JDK)"; exit 1; }
if [[ -z "${ANDROID_NDK_HOME:-}" && -z "${ANDROID_NDK_ROOT:-}" ]]; then
  echo "ANDROID_NDK_HOME (or ANDROID_NDK_ROOT) must point at NDK 27.2.12479018 or newer"
  exit 1
fi

"$GO_BIN" install "golang.org/x/mobile/cmd/gomobile@${GOMOBILE_VERSION}"
"$GO_BIN" install "golang.org/x/mobile/cmd/gobind@${GOMOBILE_VERSION}"

GOBIN_DIR="$("$GO_BIN" env GOPATH)/bin"
export PATH="$GOBIN_DIR:$PATH"

mkdir -p android/app/libs
# gomobile bind resolves the package against the current module, so run it
# from inside native/tailscale-go (the only go.mod in this repo).
(
  cd native/tailscale-go
  gomobile bind \
    -target=android/arm64,android/amd64 \
    -androidapi 26 \
    -ldflags "-s -w" \
    -o ../../android/app/libs/mobiletsnet.aar \
    .
)

echo "Built android/app/libs/mobiletsnet.aar"
