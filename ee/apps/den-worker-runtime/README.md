# Den Worker Runtime Root

Render worker services use this directory as `rootDir`.

The control plane installs `sofia-server`, reads the pinned Sofia version from the repository `constants.json`, runs `scripts/install-engine.mjs` during the Render build, and then launches workers with the `sofia-server` command.

That extra build step vendors the matching `engine` release asset into `./bin/engine` so the runtime does not depend on a first-boot GitHub download.
