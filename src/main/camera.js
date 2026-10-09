// Camera Studio backend: talks to the Studio-patched scrcpy server running on the
// device (see native/server-overlay). Settings go through a control file, live
// readings and a small JPEG preview come back through adb streams.
const fs = require('fs');
const path = require('path');
const { spawn, run, tools } = require('./tools');

const DEVICE_DIR = '/data/local/tmp/';
const CONF = DEVICE_DIR + 'scrcpy-studio-camera.conf';
const STATUS = DEVICE_DIR + 'scrcpy-studio-camera.json';
const PREVIEW = DEVICE_DIR + 'scrcpy-studio-camera.jpg';
const PROBE = DEVICE_DIR + 'scrcpy-studio-probe.jar';

function serverPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'scrcpy-server-studio'),
    path.join(__dirname, '..', '..', 'resources', 'scrcpy-server-studio'),
  ];
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function serverVersion() {
  const p = serverPath();
  if (!p) return null;
  try { return fs.readFileSync(p + '.version', 'utf8').trim(); } catch { return null; }
}

/** Keeps one `adb shell` open per device so control writes are near-instant. */
class ShellPipe {
  constructor(serial) {
    this.serial = serial;
    this.child = null;
  }
  ensure() {
    if (this.child && !this.child.killed && this.child.exitCode == null) return this.child;
    this.child = spawn(tools.adb, ['-s', this.serial, 'shell'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    this.child.on('error', () => { this.child = null; });
    this.child.on('close', () => { this.child = null; });
    return this.child;
  }
  send(line) {
    try { this.ensure().stdin.write(line + '\n'); return true; } catch { this.child = null; return false; }
  }
  close() { try { this.child?.stdin.end(); this.child?.kill(); } catch {} this.child = null; }
}

class CameraService {
  constructor(emit) {
    this.emit = emit;
    this.pipes = new Map();
    this.caps = new Map();
    this.watch = null; // { serial, status, preview }
  }

  info() {
    return { server: serverPath(), serverVersion: serverVersion(), scrcpyVersion: tools.scrcpyVersion };
  }

  /** Env for scrcpy sessions that should use the Studio server (null if unavailable/mismatched). */
  sessionEnv() {
    const p = serverPath();
    const v = serverVersion();
    if (!p || (v && tools.scrcpyVersion && v !== tools.scrcpyVersion)) return null;
    return { SCRCPY_SERVER_PATH: p };
  }

  async capabilities(serial, force = false) {
    if (!force && this.caps.has(serial)) return { ok: true, cameras: this.caps.get(serial) };
    const p = serverPath();
    if (!p) return { ok: false, error: 'Studio camera server is missing. Run "npm run build:server".' };
    const push = await run(tools.adb, ['-s', serial, 'push', p, PROBE], { timeout: 30000 });
    if (!push.ok) return { ok: false, error: push.stderr || push.error };
    const version = serverVersion() || tools.scrcpyVersion || '4.1';
    const r = await run(tools.adb, ['-s', serial, 'shell', `CLASSPATH=${PROBE} app_process / com.genymobile.scrcpy.Server ${version} studio_camera_caps=true`], { timeout: 30000 });
    const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('['));
    if (!line) return { ok: false, error: (r.stdout + r.stderr).trim().split('\n').pop() || r.error || 'No camera data' };
    try {
      const cameras = JSON.parse(line);
      this.caps.set(serial, cameras);
      return { ok: true, cameras };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Write the full settings object to the device control file (atomic rename). */
  setConf(serial, conf) {
    const body = Object.entries(conf)
      .filter(([k, v]) => /^[a-z0-9_]+$/i.test(k) && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${String(v).replace(/[^\w.\-]/g, '')}`)
      .join('\\n');
    let pipe = this.pipes.get(serial);
    if (!pipe) { pipe = new ShellPipe(serial); this.pipes.set(serial, pipe); }
    const ok = pipe.send(`printf '${body}\\n' > ${CONF}.tmp && mv ${CONF}.tmp ${CONF}`);
    return { ok };
  }

  /** Start/stop streaming live readings (+ preview frames) for one device. */
  startWatch(serial, { preview = true } = {}) {
    if (this.watch?.serial === serial && !!this.watch.preview === preview) return { ok: true };
    this.stopWatch();
    const w = { serial, status: null, preview: null };
    this.watch = w;

    // Text stream of status JSON documents separated by a marker line.
    w.status = spawn(tools.adb, ['-s', serial, 'exec-out', `while true; do cat ${STATUS} 2>/dev/null; echo; echo @@; sleep 0.25; done`], { windowsHide: true });
    let buf = '';
    let last = '';
    w.status.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n@@\n')) >= 0) {
        const chunk = buf.slice(0, i).trim();
        buf = buf.slice(i + 4);
        if (!chunk || chunk === last) { if (!chunk) this.emit('camera:status', { serial, status: null }); continue; }
        last = chunk;
        try { this.emit('camera:status', { serial, status: JSON.parse(chunk) }); } catch {}
      }
      if (buf.length > 1e6) buf = '';
    });

    if (preview) {
      // Binary stream of JPEG frames; split on SOI/EOI markers.
      w.preview = spawn(tools.adb, ['-s', serial, 'exec-out', `while true; do cat ${PREVIEW} 2>/dev/null; sleep 0.18; done`], { windowsHide: true });
      let bin = Buffer.alloc(0);
      let lastLen = 0;
      w.preview.stdout.on('data', (d) => {
        bin = Buffer.concat([bin, d]);
        for (;;) {
          const soi = bin.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
          if (soi < 0) { bin = Buffer.alloc(0); break; }
          const eoi = bin.indexOf(Buffer.from([0xff, 0xd9]), soi + 3);
          if (eoi < 0) { bin = bin.slice(soi); break; }
          const frame = bin.slice(soi, eoi + 2);
          bin = bin.slice(eoi + 2);
          // The same file is re-read until the server replaces it: skip exact repeats.
          if (frame.length !== lastLen) {
            lastLen = frame.length;
            this.emit('camera:preview', { serial, frame: 'data:image/jpeg;base64,' + frame.toString('base64') });
          }
        }
        if (bin.length > 8e6) bin = Buffer.alloc(0);
      });
    }
    for (const c of [w.status, w.preview].filter(Boolean)) c.on('error', () => {});
    return { ok: true };
  }

  stopWatch() {
    if (!this.watch) return;
    for (const c of [this.watch.status, this.watch.preview]) { try { c?.kill(); } catch {} }
    this.watch = null;
  }

  dispose() {
    this.stopWatch();
    for (const p of this.pipes.values()) p.close();
    this.pipes.clear();
  }
}

module.exports = { CameraService, serverPath };
