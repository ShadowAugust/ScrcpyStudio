// Tiny JSON-file persistence for settings, profiles and device metadata.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function defaults() {
  const pictures = app.getPath('pictures');
  const videos = app.getPath('videos');
  return {
    settings: {
      theme: 'dark',            // dark | light | system
      accent: '#7c5cff',
      scrcpyPath: '',
      adbPath: '',
      screenshotDir: path.join(pictures, 'Scrcpy Studio'),
      recordDir: path.join(videos, 'Scrcpy Studio'),
      pullDir: app.getPath('downloads'),
      closeToTray: false,
      stopSessionsOnExit: true,
      autoReconnect: true,
      pollInterval: 2000,
      confirmDangerous: true,
      screenshotToClipboard: false,
      notifications: true,
      windowTitleFromAlias: true,
      recordFormat: 'mp4',
      compact: false,
      reduceMotion: false,
      autoUpdateCheck: true,    // look for a new GitHub release at startup
      skippedVersion: null,
    },
    profiles: [],               // user profiles; built-ins live in the renderer
    activeProfileId: 'builtin-balanced',
    deviceAliases: {},
    deviceProfiles: {},
    wirelessHistory: [],        // [{ address, name, lastUsed }]
    favoriteApps: {},           // serial -> [package]
    shellHistory: [],
    quickCommands: null,        // null = use built-in defaults
    selectedSerial: null,
    window: null,
    onboarded: false,
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const b = base[k], o = over[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o)
      ? deepMerge(b, o) : o;
  }
  return out;
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = defaults();
    try {
      if (fs.existsSync(this.file)) this.data = deepMerge(defaults(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      console.error('Failed to read config, using defaults', e);
      try { fs.copyFileSync(this.file, this.file + '.bak'); } catch {}
    }
    this.timer = null;
  }
  get() { return this.data; }
  /** Shallow-merge top level keys (settings is merged one level deeper). */
  set(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'settings') this.data.settings = { ...this.data.settings, ...v };
      else this.data[k] = v;
    }
    this.save();
    return this.data;
  }
  replace(data) {
    this.data = deepMerge(defaults(), data || {});
    this.save(true);
    return this.data;
  }
  reset() { return this.replace({}); }
  save(now = false) {
    clearTimeout(this.timer);
    const write = () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) { console.error('Failed to save config', e); }
    };
    if (now) write(); else this.timer = setTimeout(write, 250);
  }
  flush() { if (this.timer) { clearTimeout(this.timer); this.save(true); } }
}

module.exports = { Store };
