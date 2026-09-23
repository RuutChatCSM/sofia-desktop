# Local recipes for the Sofia App repo.

# Build, sign, notarize, and publish a Sofia App release from this macOS host.
# See apps/desktop/scripts/release-local-macos.mjs --help for all options.
app-release-local *args:
    pnpm --filter @openwork/desktop release:local:macos {{args}}
