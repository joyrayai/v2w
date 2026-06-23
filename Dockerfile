# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim
ARG APT_DEBIAN_MIRROR=http://deb.debian.org/debian
ARG APT_SECURITY_MIRROR=http://deb.debian.org/debian-security

FROM node:${NODE_VERSION} AS build
WORKDIR /app

ARG APT_DEBIAN_MIRROR
ARG APT_SECURITY_MIRROR

RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i \
      -e "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" \
      -e "s|http://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${APT_DEBIAN_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources; \
  fi; \
  apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ARG BAIDUPCS_GO_VERSION=v4.0.1
ARG APT_DEBIAN_MIRROR
ARG APT_SECURITY_MIRROR
ARG INSTALL_CHROMIUM=false
ENV NODE_ENV=production \
  PORT=5174 \
  PUBLIC_BASE_URL=http://localhost:5174 \
  DATA_DIR=/data \
  OUTPUT_DIR=/outputs \
  CACHE_DIR=/cache \
  CHROME_PATH=/usr/bin/chromium-headless-shell \
  CHROMIUM_PATH=/usr/bin/chromium-headless-shell

RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i \
      -e "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" \
      -e "s|http://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${APT_DEBIAN_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources; \
  fi; \
  apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends \
    ca-certificates \
    curl \
    gosu \
    python3 \
    python3-pip \
    tini \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  if [ "${INSTALL_CHROMIUM}" = "true" ]; then \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends chromium-headless-shell; \
    rm -rf /var/lib/apt/lists/*; \
  fi

RUN set -eux; \
  python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    amd64) baidu_arch="amd64" ;; \
    arm64) baidu_arch="arm64" ;; \
    *) echo "Unsupported architecture for BaiduPCS-Go: $arch" >&2; exit 1 ;; \
  esac \
  && zip_name="BaiduPCS-Go-${BAIDUPCS_GO_VERSION}-linux-${baidu_arch}.zip" \
  && curl -fL "https://github.com/qjfoidnh/BaiduPCS-Go/releases/download/${BAIDUPCS_GO_VERSION}/${zip_name}" -o "/tmp/${zip_name}" \
  && unzip -q "/tmp/${zip_name}" -d /tmp/baidupcs \
  && install -m 0755 "$(find /tmp/baidupcs -type f -name 'BaiduPCS-Go' | head -n 1)" /usr/local/bin/BaiduPCS-Go \
  && rm -rf "/tmp/${zip_name}" /tmp/baidupcs /root/.cache /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN set -eux; \
  ffmpeg_path="$(node -e "process.stdout.write(require('@ffmpeg-installer/ffmpeg').path)")"; \
  ffprobe_path="$(node -e "process.stdout.write(require('@ffprobe-installer/ffprobe').path)")"; \
  ln -sf "${ffmpeg_path}" /usr/local/bin/ffmpeg; \
  ln -sf "${ffprobe_path}" /usr/local/bin/ffprobe; \
  chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data/netdisk-users /outputs /cache/downloads /cache/audio \
  && chown -R node:node /app /data /outputs /cache

EXPOSE 5174
VOLUME ["/data", "/outputs", "/cache"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/src/index.js"]
