// Copies the self-contained sofia-bootstrap CLI into the landing app's
// public dir so it can be served statically at /sofia-bootstrap.mjs.
//
// install.sh downloads this file and installs it as the `sofia-bootstrap`
// command, so the installer never depends on npm/npx or a pinned GitHub ref —
// it always matches the deployed landing build.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "..", "..", "packages", "sofia-bootstrap", "bin", "sofia.mjs");
const targetDir = resolve(here, "..", "public");
const target = join(targetDir, "sofia-bootstrap.mjs");

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`[copy-bootstrap-cli] ${source} -> ${target}`);
