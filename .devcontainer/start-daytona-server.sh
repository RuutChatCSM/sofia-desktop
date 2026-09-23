#!/usr/bin/env bash
set -euo pipefail

# Start the Den server stack inside a Daytona sandbox.
# Services: MySQL, Den API, Den Web, and worker proxy.

if [ -n "${SOFIA_WORKSPACE_DIR:-}" ]; then
  REPO_DIR="$SOFIA_WORKSPACE_DIR"
elif [ -f /workspace/package.json ]; then
  REPO_DIR="/workspace"
else
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$REPO_DIR"

DEN_API_PORT="${DEN_API_PORT:-8788}"
DEN_WEB_PORT="${DEN_WEB_PORT:-3005}"
DEN_WORKER_PROXY_PORT="${DEN_WORKER_PROXY_PORT:-8789}"
PNPM_STORE="${PNPM_STORE:-$REPO_DIR/.sofia-daytona/pnpm-store}"

DEN_API_PUBLIC_URL="${DEN_API_PUBLIC_URL:-http://localhost:$DEN_API_PORT}"
DEN_WEB_PUBLIC_URL="${DEN_WEB_PUBLIC_URL:-http://localhost:$DEN_WEB_PORT}"
DEN_WORKER_PROXY_PUBLIC_URL="${DEN_WORKER_PROXY_PUBLIC_URL:-http://localhost:$DEN_WORKER_PROXY_PORT}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_URL#http://}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_HOST#https://}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_HOST%%/*}"

export SOFIA_DEV_MODE="${SOFIA_DEV_MODE:-1}"
export DEN_ORG_MODE="${DEN_ORG_MODE:-multi_org}"
# Eval sign-ups must not depend on the HIBP API.
export DEN_PASSWORD_BREACH_SCREENING_ENABLED="${DEN_PASSWORD_BREACH_SCREENING_ENABLED:-false}"
export DEN_GENERATED_ARTIFACT_VIEWS_ENABLED="${DEN_GENERATED_ARTIFACT_VIEWS_ENABLED:-false}"
export DATABASE_URL="${DATABASE_URL:-mysql://root:password@127.0.0.1:3306/sofia_den}"
export DEN_DB_ENCRYPTION_KEY="${DEN_DB_ENCRYPTION_KEY:-daytona-den-db-encryption-key-please-change-1234567890}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-daytona-den-auth-secret-please-change-1234567890}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-$DEN_WEB_PUBLIC_URL}"
export DEN_BETTER_AUTH_URL="$BETTER_AUTH_URL"
export DEN_API_PUBLIC_URL
export DEN_MCP_RESOURCE_URL="${DEN_MCP_RESOURCE_URL:-$DEN_API_PUBLIC_URL/mcp}"
export DEN_API_BASE="${DEN_API_BASE:-http://127.0.0.1:$DEN_API_PORT}"
export DEN_AUTH_ORIGIN="${DEN_AUTH_ORIGIN:-$DEN_WEB_PUBLIC_URL}"
export DEN_AUTH_FALLBACK_BASE="${DEN_AUTH_FALLBACK_BASE:-http://127.0.0.1:$DEN_API_PORT}"
export NEXT_PUBLIC_SOFIA_AUTH_CALLBACK_URL="${NEXT_PUBLIC_SOFIA_AUTH_CALLBACK_URL:-$DEN_WEB_PUBLIC_URL}"
export DEN_PROVISIONER_MODE="${DEN_PROVISIONER_MODE:-stub}"
export DEN_WORKER_URL_TEMPLATE="${DEN_WORKER_URL_TEMPLATE:-https://workers.local/{workerId}}"
export DAYTONA_WORKER_PROXY_BASE_URL="${DAYTONA_WORKER_PROXY_BASE_URL:-$DEN_WORKER_PROXY_PUBLIC_URL}"
export DEN_DAYTONA_WORKER_PROXY_BASE_URL="$DAYTONA_WORKER_PROXY_BASE_URL"
export DEN_WEB_ALLOWED_DEV_ORIGINS="${DEN_WEB_ALLOWED_DEV_ORIGINS:-$DEN_WEB_PUBLIC_HOST}"

DEFAULT_ORIGINS="$DEN_WEB_PUBLIC_URL,$DEN_API_PUBLIC_URL,$DEN_WORKER_PROXY_PUBLIC_URL,http://localhost:$DEN_WEB_PORT,http://127.0.0.1:$DEN_WEB_PORT,http://localhost:$DEN_API_PORT,http://127.0.0.1:$DEN_API_PORT,http://localhost:$DEN_WORKER_PROXY_PORT,http://127.0.0.1:$DEN_WORKER_PROXY_PORT"
export CORS_ORIGINS="${CORS_ORIGINS:-$DEFAULT_ORIGINS}"

# Daytona mints a fresh preview hostname on every preview-url call, so any
# origin baked at boot goes stale immediately. Trust the preview proxy domain
# by wildcard (better-auth supports wildcard trusted origins) so rotated
# preview URLs keep working. Local hosts produce no wildcard.
PREVIEW_PROXY_HOST="${DEN_WEB_PUBLIC_URL#http://}"
PREVIEW_PROXY_HOST="${PREVIEW_PROXY_HOST#https://}"
PREVIEW_PROXY_HOST="${PREVIEW_PROXY_HOST%%/*}"
PREVIEW_PROXY_WILDCARD=""
case "$PREVIEW_PROXY_HOST" in
  localhost*|127.*|0.0.0.0*|\[*) ;;
  *.*.*)
    PREVIEW_PROXY_WILDCARD="https://*.${PREVIEW_PROXY_HOST#*.}"
    ;;
esac
# Preview hosts are not app.*: tell den-api the preview domain serves den-web
# so desktop handoff links point at the den-web /api/den proxy.
export DEN_WEB_APP_HOSTS="${DEN_WEB_APP_HOSTS:-${PREVIEW_PROXY_WILDCARD:+.${PREVIEW_PROXY_HOST#*.}}}"
export DEN_BETTER_AUTH_TRUSTED_ORIGINS="${DEN_BETTER_AUTH_TRUSTED_ORIGINS:-$CORS_ORIGINS${PREVIEW_PROXY_WILDCARD:+,$PREVIEW_PROXY_WILDCARD}}"

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "ERROR: root privileges are required to start MySQL." >&2
    exit 1
  fi
}

MYSQL_ROOT_CMD=(run_root mysql -uroot)

wait_for_http() {
  local url="$1"
  local label="$2"
  local max_wait="${3:-180}"
  local elapsed=0

  while [ "$elapsed" -lt "$max_wait" ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "==> $label ready after ${elapsed}s"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo "ERROR: $label did not become ready at $url" >&2
  return 1
}

echo "==> Starting MySQL..."
run_root service mysql start >/tmp/sofia-mysql-service.log 2>&1 || run_root service mariadb start >/tmp/sofia-mysql-service.log 2>&1

for _ in $(seq 1 60); do
  if mysql -uroot -ppassword -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ROOT_CMD=(mysql -uroot -ppassword)
    break
  fi
  if run_root mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ROOT_CMD=(run_root mysql -uroot)
    break
  fi
  sleep 2
done

"${MYSQL_ROOT_CMD[@]}" <<'SQL'
CREATE DATABASE IF NOT EXISTS sofia_den;
ALTER USER 'root'@'localhost' IDENTIFIED BY 'password';
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

echo "==> Installing dependencies if needed..."
mkdir -p "$PNPM_STORE" .sofia-daytona
baseline=.sofia-daytona/pnpm-lock.sha256
current="$(sha256sum pnpm-lock.yaml | cut -d " " -f 1)"
if [ ! -d node_modules ] || [ ! -f "$baseline" ] || [ "$(cat "$baseline")" != "$current" ]; then
  CI=1 pnpm install --store-dir "$PNPM_STORE" --frozen-lockfile || CI=1 pnpm install --store-dir "$PNPM_STORE"
  printf "%s" "$current" > "$baseline"
else
  echo "==> Skipping pnpm install (node_modules present and lockfile unchanged)."
fi

echo "==> Pushing Den DB schema..."
pnpm --filter @sofia-ee/den-db db:push > /tmp/den-db-push.log 2>&1

echo "==> Building Den API runtime assets..."
pnpm --filter @sofia-ee/den-api run build:mcp-apps

echo "==> Starting Den API on :$DEN_API_PORT..."
# The den-api process cmdline is "tsx watch src/main.ts" (cwd-relative), so a
# pattern anchored on the repo path never matches and restarts silently keep
# the old server alive on the port. main.ts is unique to den-api here.
pkill -f "tsx watch src/main.ts" >/dev/null 2>&1 || true
nohup env \
  PORT="$DEN_API_PORT" \
  DATABASE_URL="$DATABASE_URL" \
  DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
  BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  BETTER_AUTH_URL="$BETTER_AUTH_URL" \
  DEN_API_PUBLIC_URL="$DEN_API_PUBLIC_URL" \
  DEN_WEB_APP_HOSTS="$DEN_WEB_APP_HOSTS" \
  DEN_MCP_RESOURCE_URL="$DEN_MCP_RESOURCE_URL" \
  DEN_BETTER_AUTH_TRUSTED_ORIGINS="$DEN_BETTER_AUTH_TRUSTED_ORIGINS" \
  CORS_ORIGINS="$CORS_ORIGINS" \
  DEN_BOOTSTRAP_ADMIN_EMAILS="${DEN_BOOTSTRAP_ADMIN_EMAILS:-}" \
  PROVISIONER_MODE="$DEN_PROVISIONER_MODE" \
  WORKER_URL_TEMPLATE="$DEN_WORKER_URL_TEMPLATE" \
  DAYTONA_WORKER_PROXY_BASE_URL="$DAYTONA_WORKER_PROXY_BASE_URL" \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  DEN_PASSWORD_BREACH_SCREENING_ENABLED="$DEN_PASSWORD_BREACH_SCREENING_ENABLED" \
  DEN_GENERATED_ARTIFACT_VIEWS_ENABLED="$DEN_GENERATED_ARTIFACT_VIEWS_ENABLED" \
  SOFIA_DEV_MODE="$SOFIA_DEV_MODE" \
  NODE_OPTIONS="--conditions=development" \
  pnpm --filter @sofia-ee/den-api exec tsx watch src/main.ts > /tmp/den-api.log 2>&1 &

wait_for_http "http://127.0.0.1:$DEN_API_PORT/health" "Den API" 180

if [ "${RUN_SEED:-0}" = "1" ]; then
  demo_email="${DEN_DEMO_OWNER_EMAIL:-alex@acme.test}"
  demo_password="${DEN_DEMO_OWNER_PASSWORD:-SofiaDemo123!}"
  signin_ok() {
    curl -sf -o /dev/null -X POST "http://127.0.0.1:$DEN_API_PORT/api/auth/sign-in/email" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$demo_email\",\"password\":\"$demo_password\"}"
  }
  if signin_ok; then
    echo "==> Demo org already present ($demo_email)"
  else
    echo "==> Seeding demo org..."
    (cd ee/apps/den-api && env \
      DATABASE_URL="$DATABASE_URL" \
      DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
      BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
      BETTER_AUTH_URL="$BETTER_AUTH_URL" \
      DEN_API_PUBLIC_URL="$DEN_API_PUBLIC_URL" \
      DEN_ORG_MODE="$DEN_ORG_MODE" \
      SOFIA_DEV_MODE="$SOFIA_DEV_MODE" \
      DEN_DEMO_SEED_FETCH_GITHUB="${DEN_DEMO_SEED_FETCH_GITHUB:-0}" \
      node --conditions=development --import tsx scripts/seed-demo-org.ts) > /tmp/den-seed.log 2>&1
    if signin_ok; then
      echo "==> Demo org seeded ($demo_email)"
    else
      echo "ERROR: seed completed but $demo_email cannot sign in. See /tmp/den-seed.log" >&2
      tail -40 /tmp/den-seed.log >&2 || true
      exit 1
    fi
  fi
  echo "DEMO_OWNER_READY=$demo_email"
fi

echo "==> Starting worker proxy on :$DEN_WORKER_PROXY_PORT..."
pkill -f "tsx watch src/server.ts" >/dev/null 2>&1 || true
nohup env \
  PORT="$DEN_WORKER_PROXY_PORT" \
  DATABASE_URL="$DATABASE_URL" \
  SOFIA_DEV_MODE="$SOFIA_DEV_MODE" \
  DAYTONA_API_URL="${DAYTONA_API_URL:-}" \
  DAYTONA_API_KEY="${DAYTONA_API_KEY:-}" \
  DAYTONA_TARGET="${DAYTONA_TARGET:-}" \
  DAYTONA_SOFIA_PORT="${DAYTONA_SOFIA_PORT:-8787}" \
  DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS="${DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS:-86400}" \
  pnpm --filter @sofia-ee/den-worker-proxy exec tsx watch src/server.ts > /tmp/den-worker-proxy.log 2>&1 &

wait_for_http_status() {
  local url="$1"
  local label="$2"
  local max_wait="${3:-120}"
  local elapsed=0
  local status=""

  while [ "$elapsed" -lt "$max_wait" ]; do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [ "$status" != "000" ]; then
      echo "==> $label ready after ${elapsed}s (HTTP $status)"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo "ERROR: $label did not respond at $url" >&2
  return 1
}

wait_for_http_status "http://127.0.0.1:$DEN_WORKER_PROXY_PORT/unknown" "worker proxy" 120

echo "==> Building Den Web (dev-mode HMR websockets 502 through the preview proxy and block hydration)..."
if ! env \
  DEN_WEB_PORT="$DEN_WEB_PORT" \
  DEN_API_BASE="$DEN_API_BASE" \
  DEN_AUTH_ORIGIN="$DEN_AUTH_ORIGIN" \
  DEN_AUTH_FALLBACK_BASE="$DEN_AUTH_FALLBACK_BASE" \
  NEXT_PUBLIC_SOFIA_AUTH_CALLBACK_URL="$NEXT_PUBLIC_SOFIA_AUTH_CALLBACK_URL" \
  NEXT_PUBLIC_POSTHOG_KEY= \
  NEXT_PUBLIC_POSTHOG_API_KEY= \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  SOFIA_DEV_MODE="$SOFIA_DEV_MODE" \
  DEN_WEB_ALLOWED_DEV_ORIGINS="$DEN_WEB_ALLOWED_DEV_ORIGINS" \
  bash -c 'pnpm --filter @sofia/ui build && pnpm --filter @sofia-ee/utils build && pnpm --filter @sofia-ee/den-web build' > /tmp/den-web-build.log 2>&1; then
  echo "ERROR: Den Web build failed. Last 80 lines:" >&2
  tail -n 80 /tmp/den-web-build.log >&2
  exit 1
fi

echo "==> Starting Den Web on :$DEN_WEB_PORT..."
pkill -f "next dev --hostname 0.0.0.0 --port $DEN_WEB_PORT" >/dev/null 2>&1 || true
pkill -f "next start --hostname 0.0.0.0 --port $DEN_WEB_PORT" >/dev/null 2>&1 || true
nohup env \
  DEN_WEB_PORT="$DEN_WEB_PORT" \
  DEN_API_BASE="$DEN_API_BASE" \
  DEN_AUTH_ORIGIN="$DEN_AUTH_ORIGIN" \
  DEN_AUTH_FALLBACK_BASE="$DEN_AUTH_FALLBACK_BASE" \
  NEXT_PUBLIC_SOFIA_AUTH_CALLBACK_URL="$NEXT_PUBLIC_SOFIA_AUTH_CALLBACK_URL" \
  NEXT_PUBLIC_POSTHOG_KEY= \
  NEXT_PUBLIC_POSTHOG_API_KEY= \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  SOFIA_DEV_MODE="$SOFIA_DEV_MODE" \
  DEN_WEB_ALLOWED_DEV_ORIGINS="$DEN_WEB_ALLOWED_DEV_ORIGINS" \
  pnpm --filter @sofia-ee/den-web exec next start --hostname 0.0.0.0 --port "$DEN_WEB_PORT" > /tmp/den-web.log 2>&1 &

wait_for_http "http://127.0.0.1:$DEN_WEB_PORT/api/den/health" "Den Web" 180

cat > .sofia-daytona/server-env <<EOF
DEN_API_URL=$DEN_API_PUBLIC_URL
DEN_WEB_URL=$DEN_WEB_PUBLIC_URL
DEN_WORKER_PROXY_URL=$DEN_WORKER_PROXY_PUBLIC_URL
BETTER_AUTH_URL=$BETTER_AUTH_URL
DEN_MCP_RESOURCE_URL=$DEN_MCP_RESOURCE_URL
DEN_PROVISIONER_MODE=$DEN_PROVISIONER_MODE
EOF

echo ""
echo "============================================"
echo "  Sofia Daytona server stack ready"
echo ""
echo "  Den Web:       $DEN_WEB_PUBLIC_URL"
echo "  Den API:       $DEN_API_PUBLIC_URL"
echo "  Worker Proxy:  $DEN_WORKER_PROXY_PUBLIC_URL"
echo ""
echo "  Logs:"
echo "    /tmp/den-api.log"
echo "    /tmp/den-web.log"
echo "    /tmp/den-worker-proxy.log"
echo "    /tmp/den-db-push.log"
echo "============================================"
