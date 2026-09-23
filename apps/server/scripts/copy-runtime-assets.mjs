import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptsDir, "..");
const source = resolve(serverRoot, "src", "sofia-browser-repl.mjs");
const destination = resolve(serverRoot, "dist", "sofia-browser-repl.mjs");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
