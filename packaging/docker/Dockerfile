FROM node:22-bookworm-slim

ARG SOFIA_SERVER_VERSION=0.18.4
ARG SOFIA_ENGINE_VERSION=1.17.11
ARG SOFIA_ENGINE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "sofia-server@${SOFIA_SERVER_VERSION}"

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="engine-linux-x64-baseline.tar.gz" ;; \
    arm64) asset="engine-linux-arm64.tar.gz" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="$SOFIA_ENGINE_DOWNLOAD_URL"; \
  if [ -z "$url" ]; then \
    url="https://github.com/RuutChatCSM/sofia/releases/download/v${SOFIA_ENGINE_VERSION}/${asset}"; \
  fi; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "$url" -o "$tmpdir/$asset"; \
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"; \
  binary="$(find "$tmpdir" -type f -name engine | head -n 1)"; \
  test -n "$binary"; \
  install -m 0755 "$binary" /usr/local/bin/engine; \
  rm -rf "$tmpdir"

# Persistent directories (mount volumes here on PaaS/SSH).
# The data path deliberately keeps its historical name: existing deployments
# have volumes mounted at /data/sofia-orchestrator, and renaming it here
# would silently orphan their state. The orchestrator CLI itself is gone; this
# is only a directory name kept for compatibility.
ENV SOFIA_DATA_DIR=/data/sofia-orchestrator
ENV SOFIA_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV SOFIA_WORKSPACE=/workspace

# Sofia host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - Sofia server is published intentionally via --host 0.0.0.0
# - Sofia is managed by sofia-server and stays internal
CMD ["/bin/sh", "-lc", "plugin_dir=\"$(npm root -g)/sofia-server/dist/engine-plugins\"; test -d \"$plugin_dir\"; export SOFIA_MANAGE_SOFIA_ENGINE=1 SOFIA_SOFIA_ENGINE_BIN=/usr/local/bin/engine SOFIA_EXTENSIONS_PLUGIN_DIR=\"$plugin_dir\"; exec sofia-server --workspace \"${SOFIA_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${SOFIA_PORT:-8787}\" --cors \"${SOFIA_CORS_ORIGINS:-*}\" --approval \"${SOFIA_APPROVAL_MODE:-manual}\""]
