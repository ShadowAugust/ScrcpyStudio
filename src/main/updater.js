// App updates from GitHub Releases.
//
// The check reads the latest release through the GitHub API (works for every
// build). Installing depends on how the app runs:
//   nsis      installed with the Setup exe  -> electron-updater downloads + installs
//   portable  the single portable exe       -> the new portable exe is downloaded and
//                                             swapped in place on restart
//   manual    dev / unpacked folder         -> opens the release page
const fs = require('fs');
const path = require('path');
const { app, net, shell } = require('electron');
const { spawn } = require('child_process');

const pkg = require('../../package.json');
const PUBLISH = [].concat(pkg.build?.publish || [])[0] || {};
const OWNER = PUBLISH.owner;
const REPO = PUBLISH.repo;

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function installMode() {
  if (!app.isPackaged) return 'manual';
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  const dir = path.dirname(process.execPath);
  try { if (fs.readdirSync(dir).some(f => /^Uninstall .*\.exe$/i.test(f))) return 'nsis'; } catch {}
  return 'manual';
}

class Updater {
  constructor({ store, emit }) {
    this.store = store;
    this.emit = emit;
    this.mode = installMode();
    this.state = { status: 'idle', current: app.getVersion(), mode: this.mode, repo: OWNER && REPO ? `${OWNER}/${REPO}` : null, latest: null, progress: 0, error: null };
    this.autoUpdater = null;
    this.downloaded = null; // portable: path of the downloaded exe
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('update:status', { ...this.state });
  }

  status() { return { ...this.state }; }

  /** Check GitHub for a newer release. `manual` = user asked (also reports "up to date"). */
  async check({ manual = false } = {}) {
    if (!OWNER || !REPO) { this.set({ status: 'error', error: 'No GitHub repository configured' }); return this.status(); }
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.status();
    this.set({ status: 'checking', error: null, manual });
    try {
      const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ScrcpyStudio/${app.getVersion()}` },
      });
      if (res.status === 404) { this.set({ status: 'none', latest: null, checkedAt: Date.now() }); return this.status(); }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const latest = {
        version, name: rel.name || `v${version}`, notes: rel.body || '', url: rel.html_url, date: rel.published_at,
        assets: (rel.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      };
      const newer = cmpVersion(version, app.getVersion()) > 0;
      this.set({ status: newer ? 'available' : 'none', latest, checkedAt: Date.now() });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.status();
  }

  /** Startup check: silent unless something new (and not skipped) is out. */
  async checkOnStartup() {
    const s = this.store().get().settings;
    if (s.autoUpdateCheck === false || !app.isPackaged && !process.env.SSTUDIO_UPDATE_DEV) return;
    const st = await this.check();
    if (st.status === 'available' && st.latest.version === s.skippedVersion) this.set({ status: 'none', skipped: true });
  }

  skip() {
    if (this.state.latest) this.store().set({ settings: { skippedVersion: this.state.latest.version } });
    this.set({ status: 'none', skipped: true });
  }

  async download() {
    if (this.state.status !== 'available') return this.status();
    if (this.mode === 'manual') { shell.openExternal(this.state.latest.url); return this.status(); }
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      if (this.mode === 'nsis') await this.downloadNsis();
      else await this.downloadPortable();
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.set({ status: 'available', error: `Download failed: ${e.message}` });
    }
    return this.status();
  }

  async downloadNsis() {
    if (!this.autoUpdater) {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on('download-progress', (p) => this.set({ progress: (p.percent || 0) / 100 }));
      this.autoUpdater = autoUpdater;
    }
    const r = await this.autoUpdater.checkForUpdates();
    if (!r?.updateInfo || cmpVersion(r.updateInfo.version, app.getVersion()) <= 0) throw new Error('the release has no installer for this version yet');
    await this.autoUpdater.downloadUpdate();
  }

  async downloadPortable() {
    const asset = this.state.latest.assets.find(a => /portable.*\.exe$/i.test(a.name)) || this.state.latest.assets.find(a => /\.exe$/i.test(a.name) && !/setup/i.test(a.name));
    if (!asset) throw new Error('the release has no portable exe');
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.update`);
    const res = await net.fetch(asset.url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const out = fs.createWriteStream(tmp);
    let got = 0, lastEmit = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
      if (total && Date.now() - lastEmit > 200) { lastEmit = Date.now(); this.set({ progress: got / total }); }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (total && got !== total) { fs.rmSync(tmp, { force: true }); throw new Error('incomplete download'); }
    this.downloaded = tmp;
  }

  /** Quit, replace the app and start the new version. */
  install(quitApp) {
    if (this.state.status !== 'ready') return false;
    if (this.mode === 'nsis') {
      setImmediate(() => this.autoUpdater.quitAndInstall(true, true));
      return true;
    }
    if (this.mode === 'portable' && this.downloaded) {
      const target = process.env.PORTABLE_EXECUTABLE_FILE;
      const script = path.join(app.getPath('temp'), `scrcpy-studio-update-${Date.now()}.cmd`);
      // Wait for this process tree to exit, swap the exe (retrying while Windows still holds it), restart.
      fs.writeFileSync(script, [
        '@echo off',
        'chcp 65001 >nul',
        'set n=0',
        ':retry',
        'timeout /t 1 /nobreak >nul',
        `move /y "${this.downloaded}" "${target}" >nul 2>&1`,
        'if errorlevel 1 (',
        '  set /a n+=1',
        '  if %n% lss 30 goto retry',
        '  exit /b 1',
        ')',
        `start "" "${target}"`,
        'del "%~f0"',
        '',
      ].join('\r\n'), 'utf8');
      spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      quitApp();
      return true;
    }
    return false;
  }
}

module.exports = { Updater, cmpVersion };
