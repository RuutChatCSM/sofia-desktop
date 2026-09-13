// Reproducible logo derivatives using the already-bundled Electron renderer.
import { app, BrowserWindow, nativeImage } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icons = path.join(root, "resources/icons");
const publicDir = path.resolve(root, "../app/public");
app.whenReady().then(async () => {
const window = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
try {
  const svg = await readFile(path.join(icons, "sofia-source.svg"), "utf8");
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{width:100%;height:100%}</style>${svg}`)}`);
  const master = await window.webContents.capturePage();
  const sizes = [16, 32, 48, 64, 128, 180, 256, 512, 1024];
  const images = new Map(sizes.map((size) => [size, master.resize({ width: size, height: size, quality: "best" }).toPNG()]));
  await mkdir(path.join(icons, "linux"), { recursive: true });
  await mkdir(path.join(icons, "dev"), { recursive: true });
  for (const size of sizes) await writeFile(path.join(icons, `linux/${size}x${size}.png`), images.get(size));
  await writeFile(path.join(icons, "icon.png"), images.get(1024));
  await writeFile(path.join(icons, "dev/icon.png"), images.get(1024));
  for (const [name, size] of [["favicon-16x16.png", 16], ["favicon-32x32.png", 32], ["apple-touch-icon.png", 180]]) {
    await writeFile(path.join(publicDir, name), images.get(size));
  }
  const chunks = [["icp4",16],["icp5",32],["icp6",64],["ic07",128],["ic08",256],["ic09",512],["ic10",1024]].map(([type,size]) => {
    const png = images.get(size), header = Buffer.alloc(8);
    header.write(type); header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8); header.write("icns"); header.writeUInt32BE(8 + chunks.reduce((sum,c) => sum+c.length,0),4);
  await writeFile(path.join(icons, "icon.icns"), Buffer.concat([header,...chunks]));
  await writeFile(path.join(icons, "icon-dev.icns"), Buffer.concat([header,...chunks]));
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
} finally {
  window.destroy();
  app.quit();
}
}).catch((error) => { console.error(error); app.exit(1); });
