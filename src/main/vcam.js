// Virtual webcam + microphone for Windows.
//
// Instead of the scrcpy client, a native bridge (resources/vcam/studio-vcam.exe)
// connects to the Studio scrcpy server, decodes the camera stream and publishes it
// as the "Scrcpy Studio Camera" DirectShow device, as an NDI source (video+audio)
// and plays the phone microphone into a chosen audio device (virtual cable).
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { app } = require('electron');
const { spawn, run, tools, IS_WIN } = require('./tools');
const { serverPath } = require('./camera');

// Keep the server command line short: some devices (e.g. Samsung, Android 13)
// abort app_process with "stack corruption detected" above ~255 characters.
// Each concurrent stream (Camera Studio, Phone Link webcam, Phone Link mic) gets
// its own copy: the scrcpy server deletes its jar when it exits.
const devicePaths = (ch = '') => ({ jar: `/data/local/tmp/ssv${ch}.jar`, opts: `/data/local/tmp/ssv${ch}.opts` });
const REG_KEY = 'HKCU\\Software\\ScrcpyStudio\\VirtualCamera';

function resDir() {
  const candidates = [path.join(process.resourcesPath || '', 'vcam'), path.join(__dirname, '..', '..', 'resources', 'vcam')];
  return candidates.find(p => fs.existsSync(path.join(p, 'studio-vcam.exe'))) || null;
}

function meta() {
  const dir = resDir();
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'vcam.json'), 'utf8')); } catch { return { clsid: null, name: 'Scrcpy Studio Camera' }; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function lineReader(stream, cb) {
  let rest = '';
  stream.on('data', (d) => {
    const lines = (rest + d.toString('utf8')).split(/\r?\n/);
    rest = lines.pop();
    lines.forEach(l => l.trim() && cb(l));
  });
}

class VcamService {
  constructor(scrcpy, emit) {
    this.scrcpy = scrcpy;
    this.emit = emit;
    this.active = new Map(); // key (serial, or serial#channel) -> running state
  }

  installDir() { return path.join(app.getPath('userData'), 'vcam'); }

  async isRegistered() {
    const { clsid } = meta();
    if (!clsid || !IS_WIN) return { x64: false, x86: false };
    const q = (view) => run('reg', ['query', `HKLM\\SOFTWARE\\Classes\\CLSID\\${clsid}\\InprocServer32`, '/ve', view], { timeout: 5000 });
    const [a, b] = await Promise.all([q('/reg:64'), q('/reg:32')]);
    const dll = (r) => (r.ok ? (r.stdout.match(/REG_SZ\s+(.+)/) || [])[1]?.trim() : null);
    return { x64: !!dll(a), x86: !!dll(b), path: dll(a) };
  }

  async status() {
    const dir = resDir();
    if (!IS_WIN || !dir) return { supported: IS_WIN, available: false };
    const exe = path.join(dir, 'studio-vcam.exe');
    const [reg, check, audio] = await Promise.all([
      this.isRegistered(),
      run(exe, ['--check'], { timeout: 8000 }),
      run(exe, ['--list-audio'], { timeout: 8000 }),
    ]);
    let ndi = false; let devices = [];
    try { ndi = JSON.parse(check.stdout).ndi; } catch {}
    try { devices = JSON.parse(audio.stdout); } catch {}
    const render = devices.filter(d => d.flow === 'render');
    const cableRe = /cable|voicemeeter|vb-audio|virtual|vac\b/i;
    return {
      supported: true, available: true,
      name: meta().name,
      installed: reg.x64 && reg.x86, installed64: reg.x64, installed32: reg.x86,
      ndi,
      outputs: render.map(d => ({ name: d.name, default: d.default, virtual: cableRe.test(d.name) })),
      ndiMics: devices.filter(d => d.flow === 'capture' && /NDI Webcam/i.test(d.name)).map(d => d.name),
      cableMic: devices.find(d => d.flow === 'capture' && cableRe.test(d.name))?.name || null,
      running: [...this.active.keys()],
    };
  }

  /** Copy the DLLs to a stable per-user folder and register them (UAC prompt). */
  async install(uninstall = false) {
    const dir = resDir();
    if (!dir) return { ok: false, error: 'Virtual camera files are missing (run npm run build:vcam).' };
    const dest = this.installDir();
    const dll64 = path.join(dest, 'scrcpy-studio-camera-x64.dll');
    const dll86 = path.join(dest, 'scrcpy-studio-camera-x86.dll');
    if (!uninstall) {
      fs.mkdirSync(dest, { recursive: true });
      for (const f of ['scrcpy-studio-camera-x64.dll', 'scrcpy-studio-camera-x86.dll']) {
        try { fs.copyFileSync(path.join(dir, f), path.join(dest, f)); }
        catch (e) { if (!fs.existsSync(path.join(dest, f))) return { ok: false, error: e.message }; /* in use: keep the registered copy */ }
      }
    }
    const u = uninstall ? '/u ' : '';
    const sys = process.env.SystemRoot || 'C:\\Windows';
    // A small batch file run elevated (one UAC prompt). Building this as "cmd /c ..." breaks:
    // cmd strips the outer quotes when the line holds several quoted paths with spaces.
    const script = path.join(app.getPath('temp'), `scrcpy-studio-vcam-${Date.now()}.cmd`);
    const logFile = script.replace(/\.cmd$/, '.log');
    fs.writeFileSync(script, [
      '@echo off',
      'chcp 65001 >nul',
      `"${sys}\\System32\\regsvr32.exe" /s ${u}"${dll64}"`,
      `>"${logFile}" echo x64=%errorlevel%`,
      `"${sys}\\SysWOW64\\regsvr32.exe" /s ${u}"${dll86}"`,
      `>>"${logFile}" echo x86=%errorlevel%`,
      '',
    ].join('\r\n'), 'utf8');
    const ps = `Start-Process -FilePath '${script.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden`;
    const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 120000 });
    let codes = {};
    try { codes = Object.fromEntries(fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map(l => l.trim().split('=')).filter(x => x.length === 2).map(([k, v]) => [k, +v])); } catch {}
    for (const f of [script, logFile]) fs.rmSync(f, { force: true });
    if (!r.ok && /canceled|cancelled|1223/i.test(r.stderr + r.error)) return { ok: false, error: 'Administrator permission was declined.' };
    const reg = await this.isRegistered();
    const ok = uninstall ? !reg.x64 && !reg.x86 : reg.x64 && reg.x86;
    if (ok) return { ok, error: null };
    // regsvr32 exit codes: 3 = DLL could not be loaded, 4 = no entry point, 5 = registration call failed
    const why = (c) => (c === 3 ? 'could not be loaded' : c === 4 ? 'is not a valid DLL' : c === 5 ? 'registration failed (administrator rights?)' : `exit code ${c}`);
    const detail = Object.entries(codes).filter(([, c]) => c !== 0).map(([k, c]) => `${k} camera ${why(c)}`).join(', ');
    return { ok, error: detail ? `Registration did not complete: ${detail}` : (Object.keys(codes).length ? 'Registration did not complete' : 'The administrator prompt did not run the installer') };
  }

  async setIdleFormat(width, height, fps) {
    if (!IS_WIN) return;
    const add = (name, v) => run('reg', ['add', REG_KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(v), '/f'], { timeout: 5000 });
    await Promise.all([add('Width', width), add('Height', height), add('Fps', fps)]);
  }

  /**
   * opts: { serial, key, channel, label, cameraId, size:'1920x1080', fps, rotation, bitRate, mirror, fit,
   *         video: bool (default true), camera: bool, ndi: bool, ndiName, audio: 'mic'|'none', audioSource, audioDevice }
   * `key` identifies the stream (defaults to the serial); `channel` is a short suffix for its device files.
   */
  async start(opts) {
    const dir = resDir();
    const jar = serverPath();
    if (!dir || !jar) return { ok: false, error: 'Virtual webcam components are missing.' };
    if (!tools.adb) return { ok: false, error: 'adb not found' };
    const serial = opts.serial;
    const key = opts.key || serial;
    if (this.active.has(key)) await this.stop(key);
    const { jar: DEVICE_JAR, opts: DEVICE_OPTS } = devicePaths(opts.channel);
    const video = opts.video !== false;
    const [w0, h0] = String(opts.size || '1920x1080').split('x').map(Number);
    const rotated = opts.rotation === 90 || opts.rotation === 270;
    const outW = rotated ? h0 : w0, outH = rotated ? w0 : h0;
    const fps = opts.fps || 30;
    const scid = crypto.randomBytes(4).readUInt32BE() & 0x7fffffff;
    const scidHex = scid.toString(16).padStart(8, '0');
    const port = await freePort();

    const reg = await this.isRegistered();
    const useCamera = video && opts.camera !== false && reg.x64;
    const dll = path.join(this.installDir(), 'scrcpy-studio-camera-x64.dll');
    if (useCamera) await this.setIdleFormat(outW, outH, fps);

    const label = `${opts.label || serial} · ${opts.title || (video ? 'Virtual webcam' : 'Microphone')}`;
    const handle = this.scrcpy.adopt({
      serial, label, mode: video ? 'vcam' : 'audio', profileName: opts.profileName || 'Camera Studio',
      command: ['studio-vcam', video ? `${outW}x${outH}@${fps}` : 'mic'], stopFn: () => this.stop(key),
    });
    const state = { serial, key, video, handle, port, server: null, bridge: null, stopping: false, stats: null };
    this.active.set(key, state);
    const log = (line, level) => handle.log(line, level);

    const fail = async (msg) => { log(msg, 'error'); this.active.delete(key); state.error = msg; await this.cleanup(state); handle.end(1, msg); this.publish(state, 'ended'); return { ok: false, error: msg }; };

    // 1. push the Studio server and forward a local port to its socket
    const push = await run(tools.adb, ['-s', serial, 'push', jar, DEVICE_JAR], { timeout: 30000 });
    if (!push.ok) return fail(`Could not push the server: ${push.stderr || push.error}`);
    const fwd = await run(tools.adb, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scidHex}`], { timeout: 10000 });
    if (!fwd.ok) return fail(`adb forward failed: ${fwd.stderr || fwd.error}`);

    // 2. start the server in camera mode (video to the bridge, raw PCM mic audio)
    const audio = opts.audio !== 'none';
    const sArgs = [`scid=${scidHex}`, 'tunnel_forward=true', 'control=false', 'send_device_meta=false'];
    if (video) {
      sArgs.push('video_source=camera', `camera_id=${opts.cameraId ?? 0}`, `camera_size=${w0}x${h0}`);
      // Only non-default options.
      if (fps !== 30 || opts.highSpeed) sArgs.push(`camera_fps=${fps}`);
      const bitRate = Math.min(15000000, opts.bitRate || 12000000);
      if (bitRate !== 8000000) sArgs.push(`video_bit_rate=${bitRate}`);
    } else sArgs.push('video=false');
    if (audio) {
      if ((opts.audioSource || 'mic') !== 'output') sArgs.push(`audio_source=${opts.audioSource || 'mic'}`);
      sArgs.push('audio_codec=raw');
    } else sArgs.push('audio=false');
    if (video && opts.highSpeed) sArgs.push('camera_high_speed=true');
    if (video && opts.rotation) sArgs.push(`capture_orientation=${opts.rotation}`);
    // Options travel in a file (read + deleted by the Studio server): the command line stays tiny.
    const optsFile = path.join(app.getPath('temp'), `ssv-${scidHex}.opts`);
    fs.writeFileSync(optsFile, sArgs.map(a => a + '\n').join(''));
    const pushOpts = await run(tools.adb, ['-s', serial, 'push', optsFile, DEVICE_OPTS], { timeout: 15000 });
    fs.rmSync(optsFile, { force: true });
    if (!pushOpts.ok) return fail(`Could not send options: ${pushOpts.stderr || pushOpts.error}`);
    log(`server options: ${sArgs.join(' ')}`, 'debug');
    const cmdline = `CLASSPATH=${DEVICE_JAR} app_process / com.genymobile.scrcpy.Server ${tools.scrcpyVersion || '4.1'} optfile=${DEVICE_OPTS}`;
    state.server = spawn(tools.adb, ['-s', serial, 'shell', cmdline], { windowsHide: true });
    lineReader(state.server.stdout, (l) => {
      log(l);
      if (/stack corruption|Aborted/.test(l)) state.crash = true;
    });
    lineReader(state.server.stderr, (l) => log(l));
    state.server.on('close', () => { if (!state.stopping) this.stop(key, state.crash ? 'The phone\'s video encoder crashed — try a lower bitrate or resolution.' : video ? 'The camera server stopped.' : 'The microphone stream stopped.'); });

    // 3. start the bridge
    const bArgs = ['--port', String(port), '--width', String(outW), '--height', String(outH), '--fps', String(fps)];
    if (!audio) bArgs.push('--no-audio');
    if (!video) bArgs.push('--no-video');
    if (useCamera) bArgs.push('--softcam', dll);
    if (opts.ndi) bArgs.push('--ndi', opts.ndiName || `${opts.label || 'Android'} (Scrcpy Studio)`);
    if (audio && opts.audioDevice) bArgs.push('--audio-device', opts.audioDevice);
    if (opts.mirror) bArgs.push('--mirror');
    if (opts.fit === 'cover') bArgs.push('--cover');
    state.bridge = spawn(path.join(dir, 'studio-vcam.exe'), bArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    state.bridge.on('error', (e) => this.stop(key, e.message));
    lineReader(state.bridge.stderr, (l) => log(l));
    lineReader(state.bridge.stdout, (l) => {
      let ev;
      try { ev = JSON.parse(l); } catch { log(l); return; }
      if (ev.event === 'level') { this.emit('vcam:level', { key, serial, ...ev }); return; }
      if (ev.event === 'log') log(`bridge: ${ev.message}`, ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'info');
      else if (ev.event === 'stats') {
        state.stats = ev;
        handle.update({ status: 'running', info: { texture: ev.width ? `${ev.width}x${ev.height}` : undefined, fps: ev.fps } });
        this.publish(state, 'stats');
      } else if (ev.event === 'sink') { log(`output ready: ${ev.sink}${ev.name ? ` (${ev.name})` : ''}`); state.sinks = { ...(state.sinks || {}), [ev.sink]: ev.name || true }; this.publish(state, 'sink'); }
      else if (ev.event === 'connected') { log('connected to device stream'); handle.update({ status: 'running' }); }
      else if (ev.event === 'video') log(`video ${ev.width}x${ev.height}`);
      else if (ev.event === 'ended' && !state.stopping) this.stop(key, state.crash ? 'The phone\'s video encoder crashed — try a lower bitrate.' : 'Stream ended');
    });
    state.bridge.on('close', (code) => { if (!state.stopping) this.stop(key, code ? `Bridge exited (${code})` : null); });

    if (video && !useCamera) log(reg.x64 ? '' : 'Virtual camera not installed — only NDI/audio outputs are active', 'warn');
    this.publish(state, 'started');
    return { ok: true, id: handle.id, camera: useCamera };
  }

  publish(state, kind) {
    this.emit('vcam:status', { serial: state.serial, key: state.key, video: state.video, kind, running: this.active.get(state.key) === state && !state.stopping, stats: state.stats, sinks: state.sinks || {}, sessionId: state.handle.id, error: state.error || null });
  }

  async cleanup(state) {
    state.stopping = true;
    try { state.bridge?.stdin.end('quit\n'); } catch {}
    const killLater = (p) => p && setTimeout(() => { try { p.kill(); } catch {} }, 1500);
    killLater(state.bridge);
    try { state.server?.kill(); } catch {}
    await run(tools.adb, ['-s', state.serial, 'forward', '--remove', `tcp:${state.port}`], { timeout: 5000 });
  }

  async stop(key, error = null) {
    const state = this.active.get(key);
    if (!state || state.stopping) return false;
    this.active.delete(key);
    state.error = error;
    await this.cleanup(state);
    state.handle.end(error ? 1 : 0, error);
    this.publish(state, 'ended');
    return true;
  }

  stopAll() { for (const s of [...this.active.keys()]) this.stop(s); }
}

module.exports = { VcamService, resDir, freePort, lineReader };
