// Reproducible logo derivatives from the committed brand masters.
//
// Two masters, because the launcher tile and the in-app mark have different
// jobs: `sofia-source.png` is the opaque tile, which stays legible on any
// desktop, dock or browser tab; `sofia-mark.png` is the transparent cut-out
// rendered inside the app next to the "Sofia" wordmark.
import { app, BrowserWindow, nativeImage } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icons = path.join(root, "resources/icons");
const publicDir = path.resolve(root, "../app/public");
// 24/48/96 are the freedesktop hicolor sizes Linux desktops look for; every
// size written here is regenerated, so none can drift from the master.
const sizes = [16, 24, 32, 48, 64, 96, 128, 180, 256, 512, 1024];
// The retired vector tile used rx=275 on a 1254 canvas. Keep that corner radius
// so the launcher icon keeps its rounded-square silhouette instead of squaring
// off to the edge of the bitmap master.
const TILE_CORNER_RADIUS_RATIO = 275 / 1254;
const MASTER_SIZE = 1024;

function loadMaster(name) {
  const image = nativeImage.createFromPath(path.join(icons, name));
  if (image.isEmpty()) throw new Error(`Missing or unreadable resources/icons/${name}`);
  return image;
}

function render(master, size) {
  return master.resize({ width: size, height: size, quality: "best" }).toPNG();
}

/**
 * Clip the opaque tile to the brand's rounded square, keeping transparent
 * corners. The shell is written beside the master so the page and its image
 * share one `file://` origin; a data: URL page cannot load a file: subresource.
 */
async function renderTile() {
  const shellPath = path.join(icons, ".sofia-tile.html");
  const radius = Math.round(MASTER_SIZE * TILE_CORNER_RADIUS_RATIO);
  await writeFile(shellPath, `<style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}img{display:block;width:100%;height:100%;border-radius:${radius}px}</style><img src="sofia-source.png">`, "utf8");
  const window = new BrowserWindow({
    width: MASTER_SIZE, height: MASTER_SIZE, show: false, transparent: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(shellPath);
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error("Rounded tile capture came back empty");
    return image;
  } finally {
    window.destroy();
    await rm(shellPath, { force: true });
  }
}

// The render window is destroyed mid-run. Without this handler Electron's
// default "quit when the last window closes" ends the process before the
// derivatives below are written.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const tile = await renderTile();
  const images = new Map(sizes.map((size) => [size, render(tile, size)]));

  await mkdir(path.join(icons, "linux"), { recursive: true });
  await mkdir(path.join(icons, "dev"), { recursive: true });
  for (const size of sizes) await writeFile(path.join(icons, `linux/${size}x${size}.png`), images.get(size));
  await writeFile(path.join(icons, "icon.png"), images.get(1024));
  for (const [name, size] of [["favicon-16x16.png", 16], ["favicon-32x32.png", 32], ["apple-touch-icon.png", 180]]) {
    await writeFile(path.join(publicDir, name), images.get(size));
  }
  // The in-app mark keeps its transparency: only window, dock, tab and
  // launcher tiles want the opaque background baked in.
  await writeFile(path.join(publicDir, "sofia-mark.png"), render(loadMaster("sofia-mark.png"), 512));

  const chunks = [["icp4",16],["icp5",32],["icp6",64],["ic07",128],["ic08",256],["ic09",512],["ic10",1024]].map(([type,size]) => {
    const png = images.get(size), header = Buffer.alloc(8);
    header.write(type); header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8); header.write("icns"); header.writeUInt32BE(8 + chunks.reduce((sum,c) => sum+c.length,0),4);
  const icns = Buffer.concat([header,...chunks]);
  await writeFile(path.join(icons, "icon.icns"), icns);
  // resolveAppIconPath() in electron/main.mjs reads these three for dev builds,
  // falling through icon.png → 128x128@2x.png → icon-dev.icns, so all of them
  // have to track the master or the dev dock icon silently reverts to old art.
  await writeFile(path.join(icons, "dev/icon.png"), images.get(1024));
  await writeFile(path.join(icons, "dev/128x128@2x.png"), images.get(256));
  await writeFile(path.join(icons, "dev/icon-dev.icns"), icns);

  const icoSizes = [16,32,48,64,128,256], icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(1,2); icoHeader.writeUInt16LE(icoSizes.length,4);
  let offset = 6 + 16 * icoSizes.length;
  const entries = icoSizes.map((size) => {
    const entry = Buffer.alloc(16), png = images.get(size);
    entry[0] = entry[1] = size % 256;
    entry.writeUInt16LE(1,4); entry.writeUInt16LE(32,6);
    entry.writeUInt32LE(png.length,8); entry.writeUInt32LE(offset,12); offset += png.length;
    return entry;
  });
  await writeFile(path.join(icons,"icon.ico"),Buffer.concat([icoHeader,...entries,...icoSizes.map((size)=>images.get(size))]));
  if (nativeImage.createFromPath(path.join(icons,"icon.png")).isEmpty()) throw new Error("Empty Sofia icon");
  console.log("Generated Sofia App PNG, ICNS, ICO and web icons.");
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
