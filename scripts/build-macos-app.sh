#!/usr/bin/env bash
# Build a self-contained Farshelf.app (bundles Node.js, so end users need nothing else installed).
# Usage: npm run package:mac          -> dist/macos/Farshelf.app
# Optional: put google-oauth.json in the repo root to build in one-click Google sign-in (that copy then
# contains your OAuth client secret; see docs/AI_AND_PROVIDERS.md before sharing it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/macos"
APP="$OUT/Farshelf.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(uname -m)"
NODE_BIN="$(node -p 'process.execPath')"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ "$(uname)" == "Darwin" ]] || { echo "This script builds a macOS app and must run on macOS." >&2; exit 1; }

echo "› Building Farshelf $VERSION for $ARCH"
cd "$ROOT"
npm run build >/dev/null

echo "› Packing and installing production dependencies"
npm pack --ignore-scripts --pack-destination "$WORK" >/dev/null
mkdir -p "$WORK/app"
(cd "$WORK/app" && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund "$WORK"/farshelf-*.tgz >/dev/null)

echo "› Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$WORK/app/node_modules" "$APP/Contents/Resources/node_modules"
if [[ -f "$ROOT/google-oauth.json" ]]; then
  cp "$ROOT/google-oauth.json" "$APP/Contents/Resources/node_modules/farshelf/google-oauth.json"
  echo "  included google-oauth.json (one-click Google sign-in)"
fi

# Node.js runtime: keep only this machine's architecture to halve the size.
if lipo -info "$NODE_BIN" 2>/dev/null | grep -q "Architectures in the fat file"; then
  lipo "$NODE_BIN" -thin "$ARCH" -output "$APP/Contents/Resources/node"
else
  cp -L "$NODE_BIN" "$APP/Contents/Resources/node"
fi
chmod 755 "$APP/Contents/Resources/node"

echo "› Rendering the icon"
ICONSET="$WORK/Farshelf.iconset"
mkdir -p "$ICONSET"
SRC_PNG="$ROOT/assets/icon-1024.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Farshelf.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Farshelf</string>
  <key>CFBundleDisplayName</key><string>Farshelf</string>
  <key>CFBundleIdentifier</key><string>io.github.farshelf</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Farshelf</string>
  <key>CFBundleIconFile</key><string>Farshelf</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- Background app: the UI opens in your browser; quit from Settings › Farshelf app. -->
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Apache-2.0 · The Farshelf contributors</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Farshelf" <<'LAUNCHER'
#!/bin/bash
# Farshelf launcher: start the daemon (or, if it is already running, just open its window in the browser).
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
NODE="$RES/node"
CLI="$RES/node_modules/farshelf/dist/server/server/cli.js"
LOG="$HOME/Library/Logs/Farshelf.log"
PORT="${FARSHELF_PORT:-7420}"
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  exec "$NODE" "$CLI" url --open
fi
mkdir -p "$(dirname "$LOG")"
echo "=== Farshelf started $(date) ===" >>"$LOG"
exec "$NODE" "$CLI" start --port "$PORT" >>"$LOG" 2>&1
LAUNCHER
chmod 755 "$APP/Contents/MacOS/Farshelf"

# Ad-hoc signature so macOS runs the bundle locally. Sharing it with others needs a Developer ID
# signature and notarization (see docs/RELEASING.md).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign unavailable; app left unsigned)"

echo "✓ Built $APP ($(du -sh "$APP" | cut -f1))"
