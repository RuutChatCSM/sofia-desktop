#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/packaging/docker/Dockerfile.microsandbox"

IMAGE_REF="${1:-sofia-microsandbox:dev}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-}"
SOFIA_ENGINE_VERSION="${SOFIA_ENGINE_VERSION:-$(node -e 'const fs=require("fs"); const parsed=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(parsed.engineVersion || "").trim().replace(/^v/, ""));' "$ROOT_DIR/constants.json")}"
SOFIA_SERVER_VERSION="${SOFIA_SERVER_VERSION:-$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(pkg.version));' "$ROOT_DIR/apps/server/package.json")}"

args=(
  build
  -t "$IMAGE_REF"
  -f "$DOCKERFILE"
  --build-arg "SOFIA_SERVER_VERSION=$SOFIA_SERVER_VERSION"
  --build-arg "SOFIA_ENGINE_VERSION=$SOFIA_ENGINE_VERSION"
)

if [ -n "$DOCKER_PLATFORM" ]; then
  args+=(--platform "$DOCKER_PLATFORM")
fi

args+=("$ROOT_DIR")

printf 'Building micro-sandbox image %s\n' "$IMAGE_REF"
printf '  sofia-server@%s\n' "$SOFIA_SERVER_VERSION"
printf '  engine@%s\n' "$SOFIA_ENGINE_VERSION"

docker "${args[@]}"

printf '\nBuilt micro-sandbox image: %s\n' "$IMAGE_REF"
printf 'Run example:\n'
printf '  docker run --rm -p 8787:8787 -e SOFIA_CONNECT_HOST=127.0.0.1 %s\n' "$IMAGE_REF"
printf 'Verify:\n'
printf '  curl http://127.0.0.1:8787/health\n'
printf '  curl -H "Authorization: Bearer microsandbox-token" http://127.0.0.1:8787/workspaces\n'
