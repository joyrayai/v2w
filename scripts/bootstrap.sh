#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=0
INSTALL_SYSTEM=0
SKIP_BUILD=0
PRODUCTION=0

for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --install-system) INSTALL_SYSTEM=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --production) PRODUCTION=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/bootstrap.sh [options]

Options:
  --check-only      Only inspect the environment. Do not install npm packages.
  --install-system  Try to install ffmpeg, yt-dlp and BaiduPCS-Go.
  --production      Install production npm dependencies after building.
  --skip-build      Skip npm run build.
  -h, --help        Show this help.

Examples:
  npm run setup
  npm run setup -- --install-system
  npm run setup -- --production
  npm run doctor
EOF
      exit 0
      ;;
    *)
      printf '[ERROR] Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

cd "$APP_ROOT"

log() { printf '\n==> %s\n' "$1"; }
ok() { printf '[OK] %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1" >&2; }
fail() { printf '[ERROR] %s\n' "$1" >&2; exit 1; }
need_command() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

random_secret() {
  if need_command openssl; then
    openssl rand -hex 32
  else
    node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  fi
}

detect_platform() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf 'macos'
  elif need_command apt-get; then
    printf 'apt'
  else
    printf 'unknown'
  fi
}

install_system_dependencies() {
  log "Installing system dependencies"
  bash scripts/setup-netdisk-env.sh

  if ! need_command chromium && ! need_command chromium-browser && ! need_command google-chrome; then
    case "$(detect_platform)" in
      macos)
        if need_command brew; then
          brew install --cask google-chrome || warn "Chrome install failed. Install Chrome/Chromium manually for QR login."
        fi
        ;;
      apt)
        if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
          warn "Chromium install requires root. Run with sudo or install Chromium manually."
        else
          apt-get update
          apt-get install -y chromium || apt-get install -y chromium-browser || warn "Chromium install failed."
        fi
        ;;
      *)
        warn "Unsupported platform for automatic Chromium install."
        ;;
    esac
  fi
}

check_command() {
  local name="$1"
  local hint="$2"
  if need_command "$name"; then
    ok "$name: $(command -v "$name")"
    return 0
  fi
  warn "$name not found. $hint"
  return 1
}

log "Checking runtime"
check_command node "Install Node.js 20 or newer." || fail "Node.js is required."
check_command npm "Install npm with Node.js." || fail "npm is required."

if [[ "$(node_major)" -lt 20 ]]; then
  fail "Node.js 20 or newer is required. Current: $(node -v)"
fi
ok "Node.js: $(node -v)"
ok "npm: $(npm -v)"

if [[ "$INSTALL_SYSTEM" -eq 1 ]]; then
  install_system_dependencies
fi

log "Checking optional media/cloud-drive tools"
check_command ffmpeg "Required for local media extraction and cloud-drive downloads." || true
check_command ffprobe "Recommended for duration/cost estimation." || true
check_command yt-dlp "Required for generic video pages." || true
check_command BaiduPCS-Go "Required for Baidu Netdisk mode." || true

if need_command chromium; then
  ok "chromium: $(command -v chromium)"
elif need_command chromium-browser; then
  ok "chromium-browser: $(command -v chromium-browser)"
elif need_command google-chrome; then
  ok "google-chrome: $(command -v google-chrome)"
elif [[ -n "${CHROME_PATH:-}" && -x "${CHROME_PATH:-}" ]]; then
  ok "CHROME_PATH: $CHROME_PATH"
elif [[ -n "${CHROMIUM_PATH:-}" && -x "${CHROMIUM_PATH:-}" ]]; then
  ok "CHROMIUM_PATH: $CHROMIUM_PATH"
else
  warn "Chrome/Chromium not found. Baidu QR login will be unavailable until installed."
fi

log "Preparing environment file"
if [[ ! -f .env ]]; then
  cp .env.example .env
  secret="$(random_secret)"
  tmp_file="$(mktemp)"
  sed "s/^SESSION_SECRET=.*/SESSION_SECRET=${secret}/" .env > "$tmp_file"
  mv "$tmp_file" .env
  chmod 600 .env
  ok "Created .env from .env.example"
else
  ok ".env already exists"
fi

mkdir -p data/downloads data/audio data/outputs data/netdisk-users
ok "Data directories are ready"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  log "Check complete"
  exit 0
fi

log "Installing npm dependencies"
npm ci

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "Building web assets"
  npm run build
fi

if [[ "$PRODUCTION" -eq 1 ]]; then
  log "Pruning dev dependencies for production"
  npm prune --omit=dev
fi

cat <<EOF

Setup complete.

Development:
  npm run dev
  Open http://localhost:5173

Production:
  npm start
  Open http://localhost:${PORT:-5174}

Notes:
  - Configure model API keys in the web UI after login.
  - For cloud-drive mode, login to the corresponding drive in the model/config page.
  - Runtime data is stored in ./data and is ignored by Git.
EOF
