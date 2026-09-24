// Reproducible logo derivatives from the committed brand master.
//
// `sofia-mark.png` is the transparent colour cut-out. The launcher tile is that
// mark composited over TILE_BACKGROUND, so the tile background is a constant
// here rather than something baked into a second opaque master; the in-app mark
// is the same artwork with its transparency kept.
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
// Apple's macOS icon grid: an 824x824 tile with a 185.4 corner radius on a
// 1024 canvas. A tile drawn edge to edge reads visibly larger than the system
// apps beside it in the Dock and Finder, so the macOS outputs are inset to the
// grid while the Linux, Windows and web outputs stay full bleed.
const MACOS_TILE_BODY_RATIO = 824 / MASTER_SIZE;
const MACOS_TILE_CORNER_RADIUS_RATIO = 185.4 / 824;
// Launcher tile background, and how much of the tile height the mark's full
// extent fills. The mark carries a soft halo that is barely distinguishable
// from the tile, so its measured box is larger than the figure inside it: at 1
// the figure reads at about 72% of the tile with a 10% margin, and only the
// halo meets the tile edge. Sizing by the box alone leaves the figure looking
// undersized.
const TILE_BACKGROUND = "#f5f1e8";
const TILE_GLYPH_HEIGHT_RATIO = 1;

function loadMaster(name) {
  const image = nativeImage.createFromPath(path.join(icons, name));
  if (image.isEmpty()) throw new Error(`Missing or unreadable resources/icons/${name}`);
  return image;
}

function render(master, size) {
  return master.resize({ width: size, height: size, quality: "best" }).toPNG();
}

/**
 * Draw the launcher tile: the mark centred on TILE_BACKGROUND, clipped to a
 * rounded square with transparent corners. The shell is written beside the
 * master so the page and its image share one `file://` origin; a data: URL page
 * cannot load a file: subresource.
 */
async function renderTile({ bodyRatio = 1, cornerRadiusRatio = TILE_CORNER_RADIUS_RATIO } = {}) {
  const shellPath = path.join(icons, ".sofia-tile.html");
  const body = Math.round(MASTER_SIZE * bodyRatio);
  const inset = Math.round((MASTER_SIZE - body) / 2);
  const radius = Math.round(body * cornerRadiusRatio);
  const glyphHeight = Math.round(body * TILE_GLYPH_HEIGHT_RATIO);
  await writeFile(shellPath, `<style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}.tile{position:absolute;left:${inset}px;top:${inset}px;width:${body}px;height:${body}px;background:${TILE_BACKGROUND};border-radius:${radius}px;display:flex;align-items:center;justify-content:center}.tile img{height:${glyphHeight}px}</style><div class="tile"><img src="sofia-mark.png"></div>`, "utf8");
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
  const macTile = await renderTile({
    bodyRatio: MACOS_TILE_BODY_RATIO,
    cornerRadiusRatio: MACOS_TILE_CORNER_RADIUS_RATIO,
  });
  const images = new Map(sizes.map((size) => [size, render(tile, size)]));
  const macImages = new Map(sizes.map((size) => [size, render(macTile, size)]));

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
    const png = macImages.get(size), header = Buffer.alloc(8);
    header.write(type); header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8); header.write("icns"); header.writeUInt32BE(8 + chunks.reduce((sum,c) => sum+c.length,0),4);
  const icns = Buffer.concat([header,...chunks]);
  await writeFile(path.join(icons, "icon.icns"), icns);
  // resolveAppIconPath() in electron/main.mjs reads these three for dev builds,
  // falling through icon.png → 128x128@2x.png → icon-dev.icns, so all of them
  // have to track the master or the dev dock icon silently reverts to old art.
  // They are the macOS dock icon, so they take the macOS grid.
  await writeFile(path.join(icons, "dev/icon.png"), macImages.get(1024));
  await writeFile(path.join(icons, "dev/128x128@2x.png"), macImages.get(256));
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
