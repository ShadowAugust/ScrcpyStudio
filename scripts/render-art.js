// Renders the README artwork (docs/art/*.html -> docs/art/*.png) with Electron,
// so the images use the same fonts and look as the app.
// Usage: npx electron scripts/render-art.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, '..', 'docs', 'art');
const JOBS = [
  { name: 'banner', width: 1600, height: 560 },
  { name: 'hero', width: 1600, height: 1000 },
  { name: 'download', width: 520, height: 112, transparent: true },
  { name: 'portable', width: 360, height: 112, transparent: true },
];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // keep running between images
app.whenReady().then(async () => {
  for (const job of JOBS) {
    const win = new BrowserWindow({
      width: job.width, height: job.height, show: false, frame: false, transparent: !!job.transparent,
      backgroundColor: job.transparent ? '#00000000' : '#07080d', useContentSize: true,
      webPreferences: { offscreen: true },
    });
    for (let i = 0; i < 5; i++) {
      try { await win.loadFile(path.join(ART, `${job.name}.html`)); break; } catch (e) { if (i === 4) throw e; await new Promise(r => setTimeout(r, 500)); }
    }
    await new Promise(r => setTimeout(r, 600));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: job.width, height: job.height });
    fs.writeFileSync(path.join(ART, `${job.name}.png`), img.toPNG());
    console.log('rendered', job.name, img.getSize());
    win.destroy();
  }
  app.quit();
});
