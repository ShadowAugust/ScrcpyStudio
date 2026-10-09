// Scrcpy Studio — Electron main process.
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Tray, Menu, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { resolveTools, getToolsInfo } = require('./tools');
const { AdbService, safeName, stamp } = require('./adb');
const { ScrcpyService } = require('./scrcpy');
const { QrPairing } = require('./pairing');
const { CameraService } = require('./camera');
const { VcamService } = require('./vcam');
const { LinkService } = require('./link');
const { Updater } = require('./updater');

const ROOT = path.join(__dirname, '..', '..');
const ICON = path.join(ROOT, 'build', 'icon.png');
const TRAY_ICON = path.join(ROOT, 'build', 'tray.png');
const LINK_ICON = path.join(ROOT, 'build', 'link.png');
const LINK_ICO = path.join(ROOT, 'build', 'link.ico');
const CAPTURE = process.env.SSTUDIO_CAPTURE || null; // dev: screenshot the UI and quit
const wantsLink = (argv) => argv.includes('--link') || process.env.SSTUDIO_LINK === '1';

if (!app.requestSingleInstanceLock() && !CAPTURE) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('com.scrcpystudio.app');

let win = null;
let linkWin = null;
let tray = null;
let quitting = false;
let store;
const adb = new AdbService();
const scrcpy = new ScrcpyService();
const pairing = new QrPairing(adb, (status) => send('pair:status', status));
const camera = new CameraService((ch, payload) => send(ch, payload));
const vcam = new VcamService(scrcpy, (ch, payload) => { send(ch, payload); if (ch !== 'vcam:level') buildTrayLater(); });
const link = new LinkService({
  scrcpy, vcam, store: () => store, deviceLabel: (serial) => deviceLabel(serial),
  emit: (ch, payload) => { send(ch, payload); if (ch !== 'link:level') buildTrayLater(); },
});

const updater = new Updater({ store: () => store, emit: (ch, payload) => { send(ch, payload); buildTrayLater(); } });

function send(channel, payload) {
  for (const w of [win, linkWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// ------------------------------------------------------------------ window
function createWindow() {
  const saved = store.get().window;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const bounds = saved && saved.width ? saved : { width: Math.min(1440, area.width - 80), height: Math.min(920, area.height - 60) };
  if (CAPTURE) Object.assign(bounds, { width: 1440, height: 900 });
  const dark = store.get().settings.theme !== 'light';

  win = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Scrcpy Studio',
    icon: ICON,
    backgroundColor: dark ? '#0e0f16' : '#f4f5fb',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#0d0e15' : '#f3f4fa', symbolColor: dark ? '#c9cbe0' : '#3a3d52', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (saved?.maximized && !CAPTURE) win.maximize();

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'), {
    hash: process.env.SSTUDIO_VIEW || '',
    query: process.env.SSTUDIO_MOCK ? { mock: '1' } : undefined, // dev: demo data for UI work
  });

  win.once('ready-to-show', () => { if (!CAPTURE) win.show(); });
  win.webContents.on('did-finish-load', () => {
    if (!CAPTURE) return;
    // dev: optional script to drive the UI before the capture
    if (process.env.SSTUDIO_EVAL) setTimeout(() => win.webContents.executeJavaScript(process.env.SSTUDIO_EVAL).catch(() => {}), 1200);
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(CAPTURE, img.toPNG());
      quitting = true;
      app.quit();
    }, Number(process.env.SSTUDIO_CAPTURE_DELAY || 2500));
  });
  if (CAPTURE) { win.showInactive(); }

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    store.set({ window: { ...(win.isMaximized() ? store.get().window || {} : win.getBounds()), maximized: win.isMaximized() } });
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('close', (e) => {
    if (!quitting && store.get().settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

// ------------------------------------------------------------------ Phone Link window
function linkTarget() {
  // Portable builds run from a temp folder: point shortcuts at the original exe.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const dev = !app.isPackaged;
  return { exe, args: dev ? `"${app.getAppPath()}" --link` : '--link' };
}

function stableLinkIcon() {
  // Shortcuts need an icon file that outlives this process (portable builds extract to temp).
  const dest = path.join(app.getPath('userData'), 'phone-link.ico');
  try { if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(LINK_ICO).size) fs.copyFileSync(LINK_ICO, dest); } catch {}
  return fs.existsSync(dest) ? dest : LINK_ICO;
}

function createLinkWindow() {
  const saved = store.get().linkWindow;
  const dark = store.get().settings.theme !== 'light';
  linkWin = new BrowserWindow({
    width: 440, height: 780, ...(saved && saved.x != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 400, minHeight: 600, maxWidth: 560,
    show: false,
    title: 'Phone Link',
    icon: LINK_ICON,
    backgroundColor: dark ? '#0b0c12' : '#f4f5fb',
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (saved?.height && !CAPTURE) linkWin.setSize(saved.width || 440, saved.height);
  if (CAPTURE) linkWin.setSize(440, 780);
  if (IS_WINDOWS) {
    const t = linkTarget();
    try {
      linkWin.setAppDetails({ appId: 'com.scrcpystudio.link', appIconPath: stableLinkIcon(), appIconIndex: 0, relaunchCommand: `"${t.exe}" ${t.args}`, relaunchDisplayName: 'Phone Link' });
    } catch {}
  }
  linkWin.loadFile(path.join(ROOT, 'src', 'renderer', 'link.html'), { query: process.env.SSTUDIO_MOCK ? { mock: '1' } : undefined });
  linkWin.once('ready-to-show', () => { if (!CAPTURE) linkWin.show(); });
  linkWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  linkWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
  if (CAPTURE) {
    linkWin.showInactive();
    linkWin.webContents.on('did-finish-load', () => {
      if (process.env.SSTUDIO_EVAL) setTimeout(() => linkWin.webContents.executeJavaScript(process.env.SSTUDIO_EVAL).catch(() => {}), 1200);
      setTimeout(async () => {
        const img = await linkWin.webContents.capturePage();
        fs.writeFileSync(CAPTURE, img.toPNG());
        quitting = true;
        app.quit();
      }, Number(process.env.SSTUDIO_CAPTURE_DELAY || 2500));
    });
  }
  const saveBounds = () => { if (linkWin && !linkWin.isDestroyed()) store.set({ linkWindow: linkWin.getBounds() }); };
  linkWin.on('resize', debounce(saveBounds, 500));
  linkWin.on('move', debounce(saveBounds, 500));
  linkWin.on('close', (e) => {
    // Keep streaming from the tray while something is on.
    const busy = Object.keys(link.running()).length > 0;
    if (!quitting && busy && tray) { e.preventDefault(); linkWin.hide(); }
  });
  linkWin.on('closed', () => { linkWin = null; buildTrayLater(); });
}

function showLink() {
  if (!linkWin) createLinkWindow();
  else { if (linkWin.isMinimized()) linkWin.restore(); linkWin.show(); linkWin.focus(); }
}

function createLinkShortcut() {
  const t = linkTarget();
  const lnk = path.join(app.getPath('desktop'), 'Phone Link.lnk');
  const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
    target: t.exe, args: t.args, icon: stableLinkIcon(), iconIndex: 0,
    description: 'Use your phone as webcam, microphone and speakers', appUserModelId: 'com.scrcpystudio.link',
  });
  return { ok, path: lnk };
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const buildTrayLater = debounce(() => { try { buildTray(); } catch {} }, 150);
const IS_WINDOWS = process.platform === 'win32';

// ------------------------------------------------------------------ tray
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip('Scrcpy Studio');
    tray.on('click', () => (linkWin && !win ? showLink() : showWindow()));
  }
  const aliases = store.get().deviceAliases || {};
  const devs = adb.merged().filter(d => d.state === 'device');
  const running = scrcpy.running();
  const trayAction = (action, serial) => () => { send('tray:action', { action, serial }); };
  const linkRun = link.running();
  const linkItems = devs.length ? (() => {
    const d = devs.find(x => x.serial === store.get().link?.serial) || devs[0];
    const on = linkRun[d.serial] || {};
    const toggle = (kind) => async () => {
      if (on[kind]) await link.stop(d.serial, kind);
      else { const r = await link.start(d.serial, kind); if (!r?.ok) showLink(); }
    };
    return [
      { label: 'Webcam', type: 'checkbox', checked: !!on.cam, click: toggle('cam') },
      { label: 'Microphone', type: 'checkbox', checked: !!on.mic, click: toggle('mic') },
      { label: 'Speakers', type: 'checkbox', checked: !!on.spk, click: toggle('spk') },
    ];
  })() : [];
  const up = updater.status();
  const updateItem = up.status === 'available' ? { label: `Update to v${up.latest.version}…`, click: () => { showWindow(); send('update:show', {}); } }
    : up.status === 'ready' ? { label: `Restart to update to v${up.latest.version}`, click: () => updater.install(() => { quitting = true; app.quit(); }) }
    : up.status === 'downloading' ? { label: `Downloading update… ${Math.round((up.progress || 0) * 100)}%`, enabled: false }
    : { label: 'Check for updates', click: async () => { const r = await updater.check({ manual: true }); showWindow(); send('update:show', { manual: true, status: r.status }); } };
  const items = [
    { label: 'Open Scrcpy Studio', click: showWindow },
    { label: 'Open Phone Link', click: showLink },
    ...(linkItems.length ? [{ label: 'Phone Link', submenu: linkItems }] : []),
    { type: 'separator' },
    ...(devs.length ? devs.map(d => ({
      label: aliases[d.serial] || d.marketName || d.model || d.serial,
      submenu: [
        { label: 'Mirror', click: trayAction('mirror', d.serial) },
        { label: 'Mirror with screen off', click: trayAction('screen-off', d.serial) },
        { label: 'Record', click: trayAction('record', d.serial) },
        { label: 'Audio only', click: trayAction('audio', d.serial) },
        { label: 'Start virtual webcam', click: trayAction('vcam', d.serial) },
        { type: 'separator' },
        { label: 'Take screenshot', click: trayAction('screenshot', d.serial) },
      ],
    })) : [{ label: 'No devices connected', enabled: false }]),
    { type: 'separator' },
    { label: `Stop all sessions${running.length ? ` (${running.length})` : ''}`, enabled: running.length > 0, click: () => { scrcpy.stopAll(); link.stopAll(); } },
    updateItem,
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ------------------------------------------------------------------ helpers
function deviceLabel(serial) {
  const d = adb.merged().find(x => x.serial === serial);
  return store.get().deviceAliases?.[serial] || d?.deviceName || d?.marketName || d?.model || serial;
}

const MEDIA_EXT = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  video: ['.mp4', '.mkv', '.webm', '.m4a', '.mka', '.opus', '.aac', '.flac', '.wav'],
};

function listMedia(dir, kind) {
  try {
    const exts = MEDIA_EXT[kind] || [];
    return fs.readdirSync(dir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          return { name: f, path: p, url: pathToFileURL(p).href, size: st.size, mtime: st.mtimeMs, ext: path.extname(f).slice(1).toLowerCase() };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

  // app
  h('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    userData: app.getPath('userData'),
    tools: getToolsInfo(),
    captureMode: !!CAPTURE,
  }));
  h('app:resolveTools', async () => {
    const info = await resolveTools(store.get().settings);
    adb.serverStarted = false;
    adb.lastSnapshot = '';
    adb.refresh();
    return info;
  });
  h('app:setTitleBar', ({ color, symbolColor }) => { try { win?.setTitleBarOverlay({ color, symbolColor, height: 44 }); } catch {} });
  h('app:setProgress', (v) => win?.setProgressBar(v));
  h('app:flashFrame', () => { if (win && !win.isFocused()) win.flashFrame(true); });
  h('app:focus', () => showWindow());
  h('app:relaunch', () => { app.relaunch(); quitting = true; app.quit(); });
  h('app:systemDark', () => nativeTheme.shouldUseDarkColors);

  // store
  h('store:get', () => store.get());
  h('store:set', (patch) => {
    const before = store.get().settings.pollInterval;
    const data = store.set(patch);
    if (patch?.settings?.pollInterval && patch.settings.pollInterval !== before) adb.startTracking(data.settings.pollInterval);
    if (patch?.deviceAliases) buildTray();
    return data;
  });
  h('store:replace', (data) => store.replace(data));
  h('store:reset', () => store.reset());

  // dialogs & shell
  h('dialog:openFile', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])], filters: opts.filters, title: opts.title });
    return r.canceled ? null : r.filePaths;
  });
  h('dialog:openFolder', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: opts.defaultPath, title: opts.title });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:saveFile', async (opts = {}) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath, filters: opts.filters, title: opts.title });
    return r.canceled ? null : r.filePath;
  });
  h('fs:writeText', (file, text) => { fs.writeFileSync(file, text, 'utf8'); return true; });
  h('fs:readText', (file) => fs.readFileSync(file, 'utf8'));
  h('fs:listMedia', (dir, kind) => listMedia(dir, kind));
  h('fs:ensureDir', (dir) => { try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; } });
  h('fs:exists', (p) => fs.existsSync(p));
  h('shell:openPath', (p) => shell.openPath(p));
  h('shell:showItem', (p) => shell.showItemInFolder(p));
  h('shell:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  h('shell:trash', async (paths) => {
    for (const p of [].concat(paths)) { try { await shell.trashItem(p); } catch (e) { return { ok: false, message: e.message }; } }
    return { ok: true };
  });
  h('clipboard:text', (t) => clipboard.writeText(String(t)));
  h('clipboard:image', (p) => { const img = nativeImage.createFromPath(p); if (!img.isEmpty()) clipboard.writeImage(img); return !img.isEmpty(); });
  h('clipboard:readText', () => clipboard.readText());

  // adb
  h('adb:devices', () => ({ devices: adb.merged() }));
  h('adb:refresh', async (serial) => { if (serial) adb.invalidate(serial); adb.lastSnapshot = ''; await adb.refresh(); return adb.merged(); });
  h('adb:details', (serial) => adb.details(serial));
  h('adb:screenshot', async (serial) => {
    const s = store.get().settings;
    const r = await adb.screenshot(serial, s.screenshotDir, deviceLabel(serial));
    if (!r.ok) return r;
    const img = nativeImage.createFromBuffer(r.buffer);
    if (s.screenshotToClipboard) clipboard.writeImage(img);
    const size = img.getSize();
    const thumb = img.resize(size.width > size.height ? { width: 480 } : { height: 480 }).toDataURL();
    return { ok: true, path: r.path, url: pathToFileURL(r.path).href, thumb, width: size.width, height: size.height };
  });
  h('adb:screenPreview', async (serial) => {
    const r = await adb.exec(['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15000 });
    if (!r.stdout || r.stdout.length < 8 || r.stdout[0] !== 0x89) return { ok: false };
    const img = nativeImage.createFromBuffer(r.stdout);
    const { width, height } = img.getSize();
    const small = height > width ? img.resize({ height: 640, quality: 'good' }) : img.resize({ width: 640, quality: 'good' });
    return { ok: true, url: 'data:image/jpeg;base64,' + small.toJPEG(78).toString('base64'), width, height };
  });
  h('adb:install', async (serial, files, opts) => {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      send('install:progress', { serial, file: files[i], index: i, total: files.length });
      results.push({ file: files[i], ...(await adb.install(serial, files[i], opts)) });
    }
    return results;
  });
  h('adb:packages', (serial) => adb.packages(serial));
  h('adb:appDetails', (serial, pkg) => adb.appDetails(serial, pkg));
  h('adb:appAction', (serial, pkg, action, extra) => adb.appAction(serial, pkg, action, extra));
  h('adb:listDir', (serial, dir) => adb.listDir(serial, dir));
  h('adb:fileOp', (serial, op, a, b) => adb.fileOp(serial, op, a, b));
  h('adb:push', (serial, locals, remote) => adb.push(serial, locals, remote));
  h('adb:pull', (serial, remotes, local) => adb.pull(serial, remotes, local || store.get().settings.pullDir));
  h('adb:openRemote', async (serial, remote) => {
    const dir = path.join(os.tmpdir(), 'scrcpy-studio', safeName(serial));
    const r = await adb.pull(serial, [remote], dir);
    if (!r.ok) return r;
    const local = path.join(dir, path.posix.basename(remote));
    const err = await shell.openPath(local);
    return { ok: !err, message: err || local, path: local };
  });
  h('adb:keyevent', (serial, codes, long) => adb.keyevent(serial, codes, long));
  h('adb:text', (serial, text) => adb.text(serial, text));
  h('adb:shell', (serial, cmd) => adb.shell(serial, cmd, { timeout: 30000 }));
  h('adb:reboot', (serial, mode) => adb.reboot(serial, mode));
  h('adb:readSettings', (serial) => adb.readSettings(serial));
  h('adb:applySetting', (serial, key, value) => adb.applySetting(serial, key, value));
  h('adb:connect', async (address) => {
    const r = await adb.connect(address);
    if (r.ok) rememberWireless(r.address);
    adb.refresh();
    return r;
  });
  h('adb:disconnect', async (address) => { const r = await adb.disconnect(address); adb.refresh(); return r; });
  h('adb:pair', (address, code) => adb.pair(address, code));
  h('adb:enableWireless', async (serial, port) => {
    const r = await adb.enableWireless(serial, port);
    if (r?.ok) rememberWireless(r.address, deviceLabel(serial));
    adb.refresh();
    return r;
  });
  h('adb:deviceIp', (serial) => adb.deviceIp(serial));
  h('adb:mdns', () => adb.mdnsServices());
  h('adb:restartServer', async () => { const r = await adb.restartServer(); adb.refresh(); return r; });
  h('adb:shellStream', (serial, cmd) => adb.startStream(['-s', serial, 'shell', cmd],
    (id, data) => send('stream:data', { id, data }), (id, code) => send('stream:exit', { id, code })));
  h('adb:logcat', (serial, { tail = 500, clear = false } = {}) => {
    const start = () => adb.startStream(['-s', serial, 'logcat', '-v', 'threadtime', '-T', String(tail)],
      (id, data) => send('stream:data', { id, data }), (id, code) => send('stream:exit', { id, code }));
    if (clear) return adb.exec(['-s', serial, 'logcat', '-c'], { timeout: 10000 }).then(start);
    return start();
  });
  h('adb:streamStop', (id) => adb.stopStream(id));

  // scrcpy
  h('scrcpy:start', (opts) => {
    const s = store.get().settings;
    let recordPath = null;
    const args = [...(opts.args || [])];
    if (opts.record) {
      const fmt = opts.record.format || s.recordFormat || 'mp4';
      recordPath = path.join(s.recordDir, `${safeName(deviceLabel(opts.serial))}_${stamp()}.${fmt}`);
      args.push(`--record=${recordPath}`);
    }
    // Camera sessions use the Studio server so pro controls work live.
    const env = opts.mode === 'camera' || args.includes('--video-source=camera') ? camera.sessionEnv() : null;
    const r = scrcpy.start({ ...opts, args, recordPath, env, label: opts.label || deviceLabel(opts.serial) });
    buildTray();
    return r;
  });
  h('scrcpy:stop', (id, force) => scrcpy.stop(id, force));
  h('scrcpy:stopAll', () => scrcpy.stopAll());
  h('scrcpy:list', () => scrcpy.list());
  h('scrcpy:logs', (id) => scrcpy.getLogs(id));
  h('scrcpy:remove', (id) => scrcpy.remove(id));
  h('scrcpy:clearEnded', () => scrcpy.clearEnded());
  h('scrcpy:query', (serial, kind) => scrcpy.query(serial, kind));

  // camera studio
  h('camera:info', () => camera.info());
  h('camera:caps', (serial, force) => camera.capabilities(serial, force));
  h('camera:conf', (serial, conf) => camera.setConf(serial, conf));
  h('camera:watch', (serial, opts) => (serial ? camera.startWatch(serial, opts) : (camera.stopWatch(), { ok: true })));

  // virtual webcam
  h('vcam:status', () => vcam.status());
  h('vcam:install', () => vcam.install(false));
  h('vcam:uninstall', () => vcam.install(true));
  h('vcam:start', (opts) => vcam.start({ ...opts, label: opts.label || deviceLabel(opts.serial) }));
  h('vcam:stop', (serial) => vcam.stop(serial));

  // updates
  h('update:status', () => updater.status());
  h('update:check', () => updater.check({ manual: true }));
  h('update:download', () => updater.download());
  h('update:install', () => updater.install(() => { quitting = true; app.quit(); }));
  h('update:skip', () => updater.skip());

  // phone link
  h('link:info', () => link.info());
  h('link:settings', (patch) => (patch ? link.saveSettings(patch) : link.settings()));
  h('link:start', (serial, kind, opts) => link.start(serial, kind, opts));
  h('link:stop', (serial, kind) => link.stop(serial, kind));
  h('link:running', () => link.running());
  h('link:volume', (serial, value) => link.volume(serial, value));
  h('link:setDefaultOutput', (id) => link.setDefaultOutput(id));
  h('link:open', () => showLink());
  h('link:shortcut', () => createLinkShortcut());
  h('link:shortcutExists', () => fs.existsSync(path.join(app.getPath('desktop'), 'Phone Link.lnk')));
  h('link:window', (op) => {
    if (!linkWin) return;
    if (op === 'minimize') linkWin.minimize();
    else if (op === 'close') linkWin.close();
    else if (op === 'pin') { linkWin.setAlwaysOnTop(!linkWin.isAlwaysOnTop()); return linkWin.isAlwaysOnTop(); }
    return linkWin.isAlwaysOnTop();
  });
  h('vcam:installed', () => vcam.isRegistered());

  // pairing
  h('pair:qrStart', () => pairing.start());
  h('pair:qrCancel', () => pairing.cancel());
}

function rememberWireless(address, name) {
  if (!address) return;
  const list = (store.get().wirelessHistory || []).filter(x => x.address !== address);
  const prev = (store.get().wirelessHistory || []).find(x => x.address === address);
  list.unshift({ address, name: name || prev?.name || null, lastUsed: Date.now() });
  store.set({ wirelessHistory: list.slice(0, 20) });
}

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', (_e, argv) => (wantsLink(argv) ? showLink() : showWindow()));

app.whenReady().then(async () => {
  store = new Store();
  registerIpc();
  await resolveTools(store.get().settings);

  adb.on('devices', (payload) => { send('devices', payload); buildTray(); });
  scrcpy.on('event', (ev) => send('scrcpy:event', ev));
  scrcpy.on('ended', () => buildTray());

  if (wantsLink(process.argv)) createLinkWindow();
  else createWindow();
  try { buildTray(); } catch (e) { console.error('tray failed', e); }
  if (!CAPTURE) setTimeout(() => updater.checkOnStartup(), 6000);
  adb.startTracking(store.get().settings.pollInterval);

  // Reconnect remembered wireless devices in the background.
  if (store.get().settings.autoReconnect && !CAPTURE) {
    setTimeout(async () => {
      const history = (store.get().wirelessHistory || []).filter(x => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(x.address)).slice(0, 5);
      await Promise.all(history.map(h => adb.connect(h.address)));
      adb.refresh();
    }, 1500);
  }
});

let linkDrained = false;
app.on('before-quit', (e) => {
  quitting = true;
  // The speakers may have switched the Windows output: wait (briefly) for it to be restored.
  if (!linkDrained && link.speakers.size) {
    e.preventDefault();
    linkDrained = true;
    Promise.race([link.stopAll(), new Promise(r => setTimeout(r, 4000))]).finally(() => app.quit());
    return;
  }
  store?.flush();
  if (store?.get().settings.stopSessionsOnExit) scrcpy.stopAll();
  adb.stopAllStreams();
  adb.stopTracking();
  pairing.cancel();
  camera.dispose();
  link.stopAll();
  vcam.stopAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', showWindow);
