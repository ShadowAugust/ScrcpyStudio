// ADB service: device tracking/enrichment and every adb-backed feature.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { run, spawn, shQuote, tools } = require('./tools');

const SEP = '__SSTUDIO_SEP__';
const WIFI_RE = /^\d{1,3}(\.\d{1,3}){3}:\d+$|_adb-tls-connect\._tcp/;

function connType(serial) {
  if (WIFI_RE.test(serial)) return 'wifi';
  if (serial.startsWith('emulator-')) return 'emulator';
  return 'usb';
}

function parseProps(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]\s*$/);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

function parseBattery(text) {
  const get = (k) => (text.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'mi')) || [])[1]?.trim();
  const level = parseInt(get('level'), 10);
  const scale = parseInt(get('scale'), 10) || 100;
  if (Number.isNaN(level)) return null;
  const status = parseInt(get('status'), 10);
  const temp = parseInt(get('temperature'), 10);
  const voltage = parseInt(get('voltage'), 10);
  return {
    level: Math.round((level / scale) * 100),
    charging: status === 2 || status === 5,
    full: status === 5,
    ac: get('AC powered') === 'true',
    usb: get('USB powered') === 'true',
    wireless: get('Wireless powered') === 'true',
    temperature: Number.isNaN(temp) ? null : temp / 10,
    voltage: Number.isNaN(voltage) ? null : voltage / 1000,
    health: parseInt(get('health'), 10) || null,
    technology: get('technology') || null,
  };
}

function splitSections(text, n) {
  const parts = text.split(SEP);
  while (parts.length < n) parts.push('');
  return parts.map(s => s.replace(/^\r?\n/, ''));
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function safeName(s) {
  return String(s || 'device').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, '_').slice(0, 60);
}

class AdbService extends EventEmitter {
  constructor() {
    super();
    this.devices = [];
    this.cache = new Map();     // serial -> enriched info
    this.pending = new Set();
    this.timer = null;
    this.batteryTimer = null;
    this.streams = new Map();
    this.streamSeq = 0;
    this.lastSnapshot = '';
    this.serverStarted = false;
  }

  get ready() { return !!tools.adb; }

  exec(args, opts = {}) {
    if (!tools.adb) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: '', error: 'adb was not found. Set its path in Settings.' });
    return run(tools.adb, args, opts);
  }

  shell(serial, cmd, opts) {
    return this.exec(['-s', serial, 'shell', cmd], opts);
  }

  // ---------------------------------------------------------------- tracking
  async listDevices() {
    const r = await this.exec(['devices', '-l'], { timeout: 10000 });
    if (!r.ok && !r.stdout) return { ok: false, error: r.error || r.stderr, devices: [] };
    const devices = [];
    for (const line of r.stdout.split(/\r?\n/).slice(1)) {
      if (!line.trim() || line.startsWith('*')) continue;
      const parts = line.trim().split(/\s+/);
      const serial = parts[0];
      let state = parts[1];
      let rest = parts.slice(2);
      if (state === 'no' && parts[2] === 'permissions') { state = 'no-permissions'; rest = []; }
      const kv = {};
      for (const p of rest) { const i = p.indexOf(':'); if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1); }
      devices.push({
        serial, state, type: connType(serial),
        model: kv.model ? kv.model.replace(/_/g, ' ') : null,
        product: kv.product || null, codename: kv.device || null,
        transportId: kv.transport_id || null, usbPath: kv.usb || null,
      });
    }
    return { ok: true, devices };
  }

  startTracking(interval = 2000) {
    this.stopTracking();
    const tick = async () => {
      await this.refresh();
      this.timer = setTimeout(tick, Math.max(800, interval));
    };
    tick();
    this.batteryTimer = setInterval(() => this.refreshBatteries(), 30000);
  }

  stopTracking() {
    clearTimeout(this.timer); this.timer = null;
    clearInterval(this.batteryTimer); this.batteryTimer = null;
  }

  async refresh() {
    if (!this.ready) { this.publish([], 'adb not found'); return; }
    if (!this.serverStarted) { await this.exec(['start-server'], { timeout: 15000 }); this.serverStarted = true; }
    const r = await this.listDevices();
    if (!r.ok) { this.publish([], r.error); return; }
    for (const d of r.devices) {
      if (d.state === 'device' && !this.cache.has(d.serial) && !this.pending.has(d.serial)) this.enrich(d.serial);
    }
    const alive = new Set(r.devices.map(d => d.serial));
    for (const s of [...this.cache.keys()]) if (!alive.has(s)) this.cache.delete(s);
    this.devices = r.devices;
    this.publish();
  }

  merged() {
    return this.devices.map(d => ({ ...d, ...(this.cache.get(d.serial) || {}), serial: d.serial, state: d.state, type: d.type }));
  }

  publish(list, error = null) {
    const devices = list || this.merged();
    const snap = JSON.stringify({ devices, error });
    if (snap === this.lastSnapshot) return;
    this.lastSnapshot = snap;
    this.emit('devices', { devices, error });
  }

  async enrich(serial) {
    this.pending.add(serial);
    try {
      const cmd = `getprop; echo ${SEP}; wm size; wm density; echo ${SEP}; settings get global device_name; echo ${SEP}; dumpsys battery`;
      const r = await this.shell(serial, cmd, { timeout: 15000 });
      if (!r.ok && !r.stdout) return;
      const [propsTxt, wmTxt, nameTxt, battTxt] = splitSections(r.stdout, 4);
      const p = parseProps(propsTxt);
      const phys = (wmTxt.match(/Physical size:\s*(\d+x\d+)/) || [])[1];
      const over = (wmTxt.match(/Override size:\s*(\d+x\d+)/) || [])[1];
      const dens = (wmTxt.match(/Physical density:\s*(\d+)/) || [])[1];
      const deviceName = nameTxt.trim();
      this.cache.set(serial, {
        brand: p['ro.product.brand'] || p['ro.product.manufacturer'] || null,
        manufacturer: p['ro.product.manufacturer'] || null,
        model: p['ro.product.model'] || null,
        marketName: p['ro.product.marketname'] || p['ro.product.vendor.marketname'] || p['ro.config.marketing_name'] || null,
        deviceName: deviceName && deviceName !== 'null' ? deviceName : null,
        androidVersion: p['ro.build.version.release'] || null,
        sdk: parseInt(p['ro.build.version.sdk'], 10) || null,
        abi: p['ro.product.cpu.abi'] || null,
        serialno: p['ro.serialno'] || p['ro.boot.serialno'] || null,
        soc: p['ro.soc.model'] || p['ro.board.platform'] || p['ro.hardware'] || null,
        resolution: over || phys || null,
        physicalResolution: phys || null,
        density: parseInt(dens, 10) || null,
        battery: parseBattery(battTxt),
        characteristics: p['ro.build.characteristics'] || null,
      });
      this.publish();
    } finally {
      this.pending.delete(serial);
    }
  }

  async refreshBatteries() {
    for (const d of this.devices) {
      if (d.state !== 'device' || !this.cache.has(d.serial)) continue;
      const r = await this.shell(d.serial, 'dumpsys battery', { timeout: 8000 });
      const b = r.ok ? parseBattery(r.stdout) : null;
      if (b && this.cache.has(d.serial)) this.cache.get(d.serial).battery = b;
    }
    this.publish();
  }

  invalidate(serial) { this.cache.delete(serial); }

  // ---------------------------------------------------------------- info
  async details(serial) {
    const cmd = [
      'getprop', `echo ${SEP}`,
      'cat /proc/meminfo', `echo ${SEP}`,
      'df /data 2>/dev/null | tail -n 1', `echo ${SEP}`,
      'nproc 2>/dev/null; cat /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq 2>/dev/null | sort -n | tail -n 1', `echo ${SEP}`,
      'cat /proc/uptime', `echo ${SEP}`,
      'ip -f inet addr show wlan0 2>/dev/null', `echo ${SEP}`,
      'dumpsys battery', `echo ${SEP}`,
      'wm size; wm density', `echo ${SEP}`,
      'uname -r',
    ].join('; ');
    const r = await this.shell(serial, cmd, { timeout: 20000 });
    if (!r.ok && !r.stdout) return { ok: false, error: r.error || r.stderr };
    const [propsTxt, memTxt, dfTxt, cpuTxt, upTxt, ipTxt, battTxt, wmTxt, kernelTxt] = splitSections(r.stdout, 9);
    const p = parseProps(propsTxt);
    const kb = (k) => parseInt((memTxt.match(new RegExp(`^${k}:\\s*(\\d+)`, 'm')) || [])[1], 10) || null;
    const dfParts = dfTxt.trim().split(/\s+/);
    const cpuLines = cpuTxt.trim().split(/\r?\n/);
    return {
      ok: true,
      props: p,
      memory: { total: kb('MemTotal'), available: kb('MemAvailable') ?? kb('MemFree') },
      storage: dfParts.length >= 4 ? { total: parseInt(dfParts[1], 10) || null, used: parseInt(dfParts[2], 10) || null, free: parseInt(dfParts[3], 10) || null } : null,
      cpu: { cores: parseInt(cpuLines[0], 10) || null, maxFreqKHz: parseInt(cpuLines[1], 10) || null },
      uptime: parseFloat(upTxt) || null,
      ip: (ipTxt.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null,
      battery: parseBattery(battTxt),
      wm: {
        physical: (wmTxt.match(/Physical size:\s*(\d+x\d+)/) || [])[1] || null,
        override: (wmTxt.match(/Override size:\s*(\d+x\d+)/) || [])[1] || null,
        density: parseInt((wmTxt.match(/Physical density:\s*(\d+)/) || [])[1], 10) || null,
        overrideDensity: parseInt((wmTxt.match(/Override density:\s*(\d+)/) || [])[1], 10) || null,
      },
      kernel: kernelTxt.trim() || null,
    };
  }

  // ---------------------------------------------------------------- media
  async screenshot(serial, dir, label) {
    const r = await this.exec(['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 25000 });
    const buf = r.stdout;
    if (!buf || buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
      return { ok: false, error: r.error || r.stderr || 'Device returned an invalid image' };
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName(label)}_${stamp()}.png`);
    fs.writeFileSync(file, buf);
    return { ok: true, path: file, buffer: buf };
  }

  // ---------------------------------------------------------------- apps
  async install(serial, file, { grant = false, downgrade = false } = {}) {
    const args = ['-s', serial, 'install', '-r'];
    if (grant) args.push('-g');
    if (downgrade) args.push('-d');
    args.push(file);
    const r = await this.exec(args, { timeout: 10 * 60 * 1000 });
    const out = (r.stdout + '\n' + r.stderr).trim();
    const failure = out.match(/Failure \[([^\]]+)\]|(INSTALL_[A-Z_]+)/);
    return { ok: /Success/.test(out) && !failure, message: failure ? (failure[1] || failure[2]) : (r.error && !/Success/.test(out) ? r.error : out.split(/\r?\n/).pop()) };
  }

  async packages(serial) {
    const cmd = `pm list packages -f -3; echo ${SEP}; pm list packages -f -s; echo ${SEP}; pm list packages -d`;
    const r = await this.shell(serial, cmd, { timeout: 30000 });
    if (!r.ok && !r.stdout) return { ok: false, error: r.error || r.stderr };
    const [userTxt, sysTxt, disTxt] = splitSections(r.stdout, 3);
    const disabled = new Set(disTxt.split(/\r?\n/).map(l => l.replace(/^package:/, '').trim()).filter(Boolean));
    const parse = (txt, system) => txt.split(/\r?\n/).filter(l => l.startsWith('package:')).map(l => {
      const s = l.slice(8).trim();
      const i = s.lastIndexOf('=');
      const pkg = i > 0 ? s.slice(i + 1) : s;
      return { package: pkg, apk: i > 0 ? s.slice(0, i) : null, system, disabled: disabled.has(pkg) };
    });
    return { ok: true, packages: [...parse(userTxt, false), ...parse(sysTxt, true)] };
  }

  async appDetails(serial, pkg) {
    const r = await this.shell(serial, `dumpsys package ${shQuote(pkg)}`, { timeout: 20000 });
    const t = r.stdout || '';
    const g = (re) => (t.match(re) || [])[1] || null;
    return {
      ok: r.ok,
      versionName: g(/versionName=([^\s]+)/),
      versionCode: g(/versionCode=(\d+)/),
      targetSdk: g(/targetSdk=(\d+)/),
      minSdk: g(/minSdk=(\d+)/),
      firstInstall: g(/firstInstallTime=([^\r\n]+)/),
      lastUpdate: g(/lastUpdateTime=([^\r\n]+)/),
      installer: g(/installerPackageName=([^\s]+)/),
      dataDir: g(/dataDir=([^\s]+)/),
    };
  }

  async appAction(serial, pkg, action, extra = {}) {
    const q = shQuote(pkg);
    let r;
    switch (action) {
      case 'launch': r = await this.shell(serial, `monkey -p ${q} -c android.intent.category.LAUNCHER 1`); break;
      case 'stop': r = await this.shell(serial, `am force-stop ${q}`); break;
      case 'clear': r = await this.shell(serial, `pm clear ${q}`); break;
      case 'uninstall': r = await this.exec(['-s', serial, 'uninstall', ...(extra.keepData ? ['-k'] : []), pkg], { timeout: 120000 }); break;
      case 'uninstall-user': r = await this.shell(serial, `pm uninstall -k --user 0 ${q}`); break;
      case 'disable': r = await this.shell(serial, `pm disable-user --user 0 ${q}`); break;
      case 'enable': r = await this.shell(serial, `pm enable ${q}`); break;
      case 'info': r = await this.shell(serial, `am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:${pkg.replace(/[^\w.]/g, '')}`); break;
      case 'extract': {
        const apk = extra.apk || (await this.shell(serial, `pm path ${q}`)).stdout.split(/\r?\n/).find(l => l.startsWith('package:'))?.slice(8).trim();
        if (!apk) return { ok: false, message: 'Could not locate the APK on the device' };
        fs.mkdirSync(extra.dir, { recursive: true });
        const dest = path.join(extra.dir, `${safeName(pkg)}.apk`);
        r = await this.exec(['-s', serial, 'pull', apk, dest], { timeout: 10 * 60 * 1000 });
        return { ok: r.ok, message: r.ok ? dest : (r.stderr || r.error), path: dest };
      }
      default: return { ok: false, message: 'Unknown action' };
    }
    const out = (r.stdout + r.stderr).trim();
    const failed = !r.ok || /Failure|Error|Exception|No activities found|monkey aborted/i.test(out);
    return { ok: !failed, message: out || (r.error ?? '') };
  }

  // ---------------------------------------------------------------- files
  async listDir(serial, dir) {
    const q = shQuote(dir);
    const cmd = `cd ${q} 2>/dev/null || { echo __NOACCESS__; exit 0; }; stat -L -c '%F|%s|%Y|%A|%n' -- * .* 2>/dev/null; true`;
    const r = await this.shell(serial, cmd, { timeout: 30000 });
    if (/__NOACCESS__/.test(r.stdout)) return { ok: false, error: 'Folder not found or permission denied' };
    if (!r.ok && !r.stdout) return { ok: false, error: r.error || r.stderr };
    const statTxt = r.stdout;
    const entries = [];
    for (const line of statTxt.split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length < 5) continue;
      const name = parts.slice(4).join('|');
      if (name === '.' || name === '..' || name === '*' || name === '.*') continue;
      const type = parts[0];
      entries.push({
        name,
        dir: type === 'directory',
        type,
        size: parseInt(parts[1], 10) || 0,
        mtime: (parseInt(parts[2], 10) || 0) * 1000,
        mode: parts[3],
      });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { ok: true, path: dir, entries };
  }

  async fileOp(serial, op, a, b) {
    let cmd;
    if (op === 'delete') cmd = `rm -rf ${[].concat(a).map(shQuote).join(' ')}`;
    else if (op === 'mkdir') cmd = `mkdir -p ${shQuote(a)}`;
    else if (op === 'rename') cmd = `mv ${shQuote(a)} ${shQuote(b)}`;
    else return { ok: false, message: 'Unknown operation' };
    const r = await this.shell(serial, cmd + ' && echo __OK__', { timeout: 60000 });
    return { ok: /__OK__/.test(r.stdout), message: (r.stderr || r.stdout.replace('__OK__', '')).trim() || r.error };
  }

  async push(serial, locals, remoteDir) {
    const dest = remoteDir.endsWith('/') ? remoteDir : remoteDir + '/';
    const r = await this.exec(['-s', serial, 'push', ...locals, dest], { timeout: 60 * 60 * 1000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: r.ok && !/error|failed/i.test(out.split(/\r?\n/).pop() || ''), message: out.split(/\r?\n/).pop() || r.error };
  }

  async pull(serial, remotes, localDir) {
    fs.mkdirSync(localDir, { recursive: true });
    const r = await this.exec(['-s', serial, 'pull', ...[].concat(remotes), localDir], { timeout: 60 * 60 * 1000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: r.ok, message: out.split(/\r?\n/).pop() || r.error };
  }

  // ---------------------------------------------------------------- control
  keyevent(serial, codes, longpress = false) {
    const list = [].concat(codes).map(c => String(c).replace(/[^\w]/g, '')).join(' ');
    return this.shell(serial, `input keyevent ${longpress ? '--longpress ' : ''}${list}`, { timeout: 10000 });
  }

  text(serial, text) {
    // `input text` treats spaces specially; %s is its escape for a space.
    const escaped = String(text).replace(/%/g, '\\%').replace(/ /g, '%s');
    return this.shell(serial, `input text ${shQuote(escaped)}`, { timeout: 15000 });
  }

  async reboot(serial, mode) {
    const args = ['-s', serial, 'reboot'];
    if (mode && ['recovery', 'bootloader', 'sideload'].includes(mode)) args.push(mode);
    return this.exec(args, { timeout: 15000 });
  }

  async readSettings(serial) {
    const items = {
      show_touches: 'settings get system show_touches',
      pointer_location: 'settings get system pointer_location',
      stay_on: 'settings get global stay_on_while_plugged_in',
      night: 'cmd uimode night',
      anim_window: 'settings get global window_animation_scale',
      anim_transition: 'settings get global transition_animation_scale',
      anim_animator: 'settings get global animator_duration_scale',
      brightness: 'settings get system screen_brightness',
      brightness_mode: 'settings get system screen_brightness_mode',
      screen_timeout: 'settings get system screen_off_timeout',
      font_scale: 'settings get system font_scale',
      airplane: 'settings get global airplane_mode_on',
      wifi: 'settings get global wifi_on',
      bluetooth: 'settings get global bluetooth_on',
      data: 'settings get global mobile_data',
      auto_rotate: 'settings get system accelerometer_rotation',
      wm: 'wm size; wm density',
    };
    const cmd = Object.entries(items).map(([k, c]) => `echo '@@${k}'; ${c} 2>/dev/null`).join('; ');
    const r = await this.shell(serial, cmd, { timeout: 20000 });
    const out = {};
    for (const block of (r.stdout || '').split('@@').slice(1)) {
      const nl = block.indexOf('\n');
      out[block.slice(0, nl).trim()] = block.slice(nl + 1).trim();
    }
    const num = (v) => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
    return {
      ok: r.ok,
      showTouches: out.show_touches === '1',
      pointerLocation: out.pointer_location === '1',
      stayOn: (num(out.stay_on) || 0) > 0,
      darkMode: /yes/i.test(out.night || ''),
      animWindow: num(out.anim_window) ?? 1,
      animTransition: num(out.anim_transition) ?? 1,
      animAnimator: num(out.anim_animator) ?? 1,
      brightness: num(out.brightness),
      autoBrightness: out.brightness_mode === '1',
      screenTimeout: num(out.screen_timeout),
      fontScale: num(out.font_scale) ?? 1,
      airplane: out.airplane === '1',
      wifi: (num(out.wifi) || 0) > 0,
      bluetooth: (num(out.bluetooth) || 0) > 0,
      mobileData: out.data === '1',
      autoRotate: out.auto_rotate === '1',
      wmSize: (out.wm?.match(/Override size:\s*(\d+x\d+)/) || out.wm?.match(/Physical size:\s*(\d+x\d+)/) || [])[1] || null,
      wmPhysical: (out.wm?.match(/Physical size:\s*(\d+x\d+)/) || [])[1] || null,
      wmDensity: parseInt((out.wm?.match(/Override density:\s*(\d+)/) || out.wm?.match(/Physical density:\s*(\d+)/) || [])[1], 10) || null,
      wmPhysicalDensity: parseInt((out.wm?.match(/Physical density:\s*(\d+)/) || [])[1], 10) || null,
    };
  }

  async applySetting(serial, key, value) {
    const v = (x) => shQuote(String(x));
    const cmds = {
      showTouches: `settings put system show_touches ${value ? 1 : 0}`,
      pointerLocation: `settings put system pointer_location ${value ? 1 : 0}`,
      stayOn: `settings put global stay_on_while_plugged_in ${value ? 7 : 0}`,
      darkMode: `cmd uimode night ${value ? 'yes' : 'no'}`,
      animations: `settings put global window_animation_scale ${v(value)}; settings put global transition_animation_scale ${v(value)}; settings put global animator_duration_scale ${v(value)}`,
      brightness: `settings put system screen_brightness_mode 0; settings put system screen_brightness ${Math.round(Number(value))}`,
      autoBrightness: `settings put system screen_brightness_mode ${value ? 1 : 0}`,
      screenTimeout: `settings put system screen_off_timeout ${Math.round(Number(value))}`,
      fontScale: `settings put system font_scale ${v(value)}`,
      airplane: `cmd connectivity airplane-mode ${value ? 'enable' : 'disable'} 2>/dev/null || settings put global airplane_mode_on ${value ? 1 : 0}`,
      wifi: `svc wifi ${value ? 'enable' : 'disable'}`,
      bluetooth: `svc bluetooth ${value ? 'enable' : 'disable'} 2>/dev/null || cmd bluetooth_manager ${value ? 'enable' : 'disable'}`,
      mobileData: `svc data ${value ? 'enable' : 'disable'}`,
      autoRotate: `settings put system accelerometer_rotation ${value ? 1 : 0}`,
      wmSize: value ? `wm size ${String(value).replace(/[^\dx]/g, '')}` : 'wm size reset',
      wmDensity: value ? `wm density ${parseInt(value, 10)}` : 'wm density reset',
    };
    if (!cmds[key]) return { ok: false, message: 'Unknown setting' };
    const r = await this.shell(serial, cmds[key], { timeout: 15000 });
    if (key === 'wmSize' || key === 'wmDensity') this.invalidate(serial);
    const out = (r.stdout + r.stderr).trim();
    return { ok: r.ok && !/Exception|Error|not found|Unknown/i.test(out), message: out };
  }

  // ---------------------------------------------------------------- wireless
  async connect(address) {
    const addr = /:\d+$/.test(address) ? address : `${address}:5555`;
    const r = await this.exec(['connect', addr], { timeout: 20000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: /connected to/i.test(out) && !/cannot|failed|unable/i.test(out), message: out || r.error, address: addr };
  }

  async disconnect(address) {
    const r = await this.exec(address ? ['disconnect', address] : ['disconnect'], { timeout: 10000 });
    this.invalidate(address);
    return { ok: r.ok, message: (r.stdout + r.stderr).trim() };
  }

  async pair(address, code) {
    const r = await this.exec(['pair', address, String(code)], { timeout: 30000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: /Successfully paired/i.test(out), message: out || r.error };
  }

  async deviceIp(serial) {
    const r = await this.shell(serial, 'ip -f inet addr show wlan0 2>/dev/null; echo; ip route 2>/dev/null', { timeout: 10000 });
    const m = r.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/) || r.stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  }

  async enableWireless(serial, port = 5555) {
    const ip = await this.deviceIp(serial);
    if (!ip) return { ok: false, message: 'Could not find the device IP. Is it connected to Wi-Fi?' };
    const t = await this.exec(['-s', serial, 'tcpip', String(port)], { timeout: 15000 });
    if (!t.ok) return { ok: false, message: t.stderr || t.error };
    let last;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1200 + i * 600));
      last = await this.connect(`${ip}:${port}`);
      if (last.ok) return last;
    }
    return last;
  }

  async mdnsServices() {
    const r = await this.exec(['mdns', 'services'], { timeout: 10000 });
    const services = [];
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s+(_adb[-\w]*\._tcp)\.?\s+(\S+:\d+)$/);
      if (m) services.push({ name: m[1], type: m[2], address: m[3], pairing: m[2].includes('pairing') });
    }
    return { ok: r.ok, services, error: r.ok ? null : (r.stderr || r.error) };
  }

  async restartServer() {
    await this.exec(['kill-server'], { timeout: 10000 });
    const r = await this.exec(['start-server'], { timeout: 20000 });
    this.cache.clear();
    this.lastSnapshot = '';
    return { ok: r.ok, message: (r.stdout + r.stderr).trim() || r.error };
  }

  // ---------------------------------------------------------------- streams
  /** Starts a long-running adb process whose output is batched to `onData`. */
  startStream(args, onData, onExit) {
    if (!tools.adb) return { ok: false, error: 'adb not found' };
    const id = `s${++this.streamSeq}`;
    const child = spawn(tools.adb, args, { windowsHide: true });
    let buf = [];
    const flush = () => { if (buf.length) { onData(id, buf.join('')); buf = []; } };
    const timer = setInterval(flush, 120);
    const push = (chunk) => { buf.push(chunk.toString('utf8')); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { buf.push(`\n[error] ${e.message}\n`); });
    child.on('close', (code) => {
      flush(); clearInterval(timer);
      this.streams.delete(id);
      onExit?.(id, code);
    });
    this.streams.set(id, child);
    return { ok: true, id };
  }

  stopStream(id) {
    const c = this.streams.get(id);
    if (!c) return false;
    try { c.kill(); } catch {}
    return true;
  }

  stopAllStreams() { for (const id of [...this.streams.keys()]) this.stopStream(id); }
}

module.exports = { AdbService, safeName, stamp };
