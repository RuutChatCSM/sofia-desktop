import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptsDir, "..");
for (const name of ["sofia-browser-repl.mjs", "browser-cursor.mjs"]) {
  const source = resolve(serverRoot, "src", name);
  const destination = resolve(serverRoot, "dist", name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
