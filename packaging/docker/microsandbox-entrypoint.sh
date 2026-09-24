#!/usr/bin/env sh
set -eu

SOFIA_WORKSPACE="${SOFIA_WORKSPACE:-/workspace}"
SOFIA_DATA_DIR="${SOFIA_DATA_DIR:-/data/sofia-server}"
SOFIA_SIDECAR_DIR="${SOFIA_SIDECAR_DIR:-/data/sidecars}"
SOFIA_PORT="${SOFIA_PORT:-8787}"
SOFIA_TOKEN="${SOFIA_TOKEN:-microsandbox-token}"
SOFIA_HOST_TOKEN="${SOFIA_HOST_TOKEN:-microsandbox-host-token}"
SOFIA_APPROVAL_MODE="${SOFIA_APPROVAL_MODE:-auto}"
SOFIA_CORS_ORIGINS="${SOFIA_CORS_ORIGINS:-*}"
SOFIA_CONNECT_HOST="${SOFIA_CONNECT_HOST:-127.0.0.1}"
SOFIA_EXTENSIONS_PLUGIN_DIR="${SOFIA_EXTENSIONS_PLUGIN_DIR:-/opt/sofia/engine-plugins}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
export SOFIA_DATA_DIR SOFIA_TOKEN SOFIA_HOST_TOKEN SOFIA_EXTENSIONS_PLUGIN_DIR
export SOFIA_MANAGE_SOFIA_ENGINE=1
export SOFIA_SOFIA_ENGINE_BIN=/usr/local/bin/engine

mkdir -p "$SOFIA_WORKSPACE" "$SOFIA_DATA_DIR" "$SOFIA_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting Sofia micro-sandbox"
printf '%s\n' "- workspace: $SOFIA_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- sofia url: http://$SOFIA_CONNECT_HOST:$SOFIA_PORT"
printf '%s\n' "- client token: $SOFIA_TOKEN"
printf '%s\n' "- host token: $SOFIA_HOST_TOKEN"
printf '%s\n' "- health: curl http://$SOFIA_CONNECT_HOST:$SOFIA_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $SOFIA_TOKEN\" http://$SOFIA_CONNECT_HOST:$SOFIA_PORT/workspaces"

exec sofia-server \
  --workspace "$SOFIA_WORKSPACE" \
  --host 0.0.0.0 \
  --port "$SOFIA_PORT" \
  --token "$SOFIA_TOKEN" \
  --host-token "$SOFIA_HOST_TOKEN" \
  --approval "$SOFIA_APPROVAL_MODE" \
  --cors "$SOFIA_CORS_ORIGINS" \
  --verbose
