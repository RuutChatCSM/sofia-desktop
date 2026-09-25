# Local recipes for the Sofia repo.

# Build, sign, notarize, and publish a Sofia release from this macOS host.
# See apps/desktop/scripts/release-local-macos.mjs --help for all options.
app-release-local *args:
    pnpm --filter @sofia/desktop release:local:macos {{args}}
