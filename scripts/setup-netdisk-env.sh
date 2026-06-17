#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DO_LOGIN="${1:-}"

log() {
  printf '\n==> %s\n' "$1"
}

warn() {
  printf '\n[WARN] %s\n' "$1" >&2
}

need_command() {
  command -v "$1" >/dev/null 2>&1
}

install_homebrew_macos() {
  if need_command brew; then
    return
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    warn "未找到 Homebrew，且当前不是 macOS。请先安装 Homebrew 后重试。"
    exit 1
  fi
  log "安装 Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

install_ubuntu_linux() {
  log "使用 apt 安装 Linux 依赖"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ffmpeg curl unzip ca-certificates python3 python3-pip

  if need_command BaiduPCS-Go; then
    log "BaiduPCS-Go 已安装：$(command -v BaiduPCS-Go)"
    return
  fi

  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) warn "暂不支持当前架构：$(uname -m)"; exit 1 ;;
  esac

  local version="${BAIDUPCS_GO_VERSION:-v4.0.1}"
  local zip_name="BaiduPCS-Go-${version}-linux-${arch}.zip"
  local url="https://github.com/qjfoidnh/BaiduPCS-Go/releases/download/${version}/${zip_name}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  log "下载 BaiduPCS-Go ${version} (${arch})"
  curl -fL "$url" -o "${tmp_dir}/${zip_name}"
  unzip -q "${tmp_dir}/${zip_name}" -d "$tmp_dir"
  local binary
  binary="$(find "$tmp_dir" -type f -name 'BaiduPCS-Go' | head -n 1)"
  if [[ -z "$binary" ]]; then
    warn "压缩包内没有找到 BaiduPCS-Go 可执行文件"
    exit 1
  fi
  install -m 0755 "$binary" /usr/local/bin/BaiduPCS-Go
  rm -rf "$tmp_dir"
}

install_ytdlp_linux() {
  if need_command yt-dlp; then
    log "yt-dlp 已安装：$(command -v yt-dlp)"
    return
  fi
  log "安装 yt-dlp"
  python3 -m pip install --break-system-packages -U yt-dlp || python3 -m pip install -U yt-dlp
}

install_formula() {
  local formula="$1"
  local binary="$2"
  if need_command "$binary"; then
    log "$binary 已安装：$(command -v "$binary")"
    return
  fi
  log "安装 $formula"
  brew install "$formula"
}

verify_binary() {
  local binary="$1"
  if need_command "$binary"; then
    printf '%s: %s\n' "$binary" "$(command -v "$binary")"
  else
    warn "$binary 未找到"
    return 1
  fi
}

log "准备网盘模式依赖"
if [[ "$(uname -s)" == "Darwin" ]]; then
  install_homebrew_macos
  log "更新 Homebrew 索引"
  brew update
  install_formula "ffmpeg" "ffmpeg"
  install_formula "yt-dlp" "yt-dlp"
  install_formula "baidupcs-go" "BaiduPCS-Go"
elif need_command apt-get; then
  install_ubuntu_linux
  install_ytdlp_linux
else
  warn "当前系统暂不支持自动安装。请手动安装 ffmpeg 和 BaiduPCS-Go。"
  exit 1
fi

log "验证安装结果"
verify_binary ffmpeg
verify_binary yt-dlp
verify_binary BaiduPCS-Go

printf '\nffmpeg 版本：\n'
ffmpeg -version | head -n 1 || true

printf '\nBaiduPCS-Go 版本：\n'
BaiduPCS-Go -v || BaiduPCS-Go help | head -n 5 || true

printf '\nyt-dlp 版本：\n'
yt-dlp --version || true

if [[ "$DO_LOGIN" == "--login" ]]; then
  log "启动 BaiduPCS-Go 登录"
  BaiduPCS-Go login
else
  cat <<'EOF'

下一步：
1. 运行百度网盘登录：
   BaiduPCS-Go login

2. 登录后可检查账号：
   BaiduPCS-Go who

3. 启动应用：
   npm run dev

4. 网盘页默认下载命令模板：
   BaiduPCS-Go d -savedir "{outDir}" "{url}"

如果分享链接需要提取码，请根据你的 BaiduPCS-Go 版本把页面里的模板改成支持提取码的命令。
EOF
fi

log "网盘模式环境检查完成"
printf '项目目录：%s\n' "$APP_ROOT"
