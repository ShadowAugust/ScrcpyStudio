// Phone Link: the phone as webcam, microphone and speakers for Windows.
//
// Each part runs as its own small stream so the phone only works for what is on:
//   webcam   -> VcamService camera stream (video only) -> "Scrcpy Studio Camera" (+ NDI)
//   mic      -> VcamService audio-only stream -> played into a virtual cable / NDI
//   speakers -> Windows audio (loopback of a cable or any output) -> Studio "Speaker"
//               player on the phone (48 kHz stereo PCM over adb)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, run, tools, IS_WIN } = require('./tools');
const { serverPath } = require('./camera');
const { resDir, freePort, lineReader } = require('./vcam');

const SPK_JAR = '/data/local/tmp/ssvs.jar';
const VIRTUAL_RE = /vb-audio|\bcable\b|voicemeeter|virtual|\bvac\b|steam streaming/i;

const norm = (s) => String(s || '').toLowerCase().replace(/\b(input|output|in|out)\b/g, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Virtual cables: a render endpoint ("CABLE Input") whose audio comes out of a
 * capture endpoint ("CABLE Output") of the same virtual device.
 */
function findCables(devices) {
  const groups = new Map();
  for (const d of devices) {
    if (!VIRTUAL_RE.test(d.iface || '') && !VIRTUAL_RE.test(d.name)) continue;
    const k = (d.iface || d.name).toLowerCase();
    groups.set(k, [...(groups.get(k) || []), d]);
  }
  const cables = [];
  for (const list of groups.values()) {
    const renders = list.filter(d => d.flow === 'render');
    const captures = list.filter(d => d.flow === 'capture');
    if (renders.length === 1 && captures.length === 1) {
      cables.push({ id: renders[0].id, render: renders[0], capture: captures[0] });
      continue;
    }
    // Multi-line drivers (Virtual Audio Cable "Line 1"…, VoiceMeeter In/Out): pair by description.
    for (const r of renders) {
      const c = captures.find(x => norm(x.desc) === norm(r.desc));
      if (c) cables.push({ id: r.id, render: r, capture: c });
    }
  }
  return cables.map(c => ({
    ...c,
    label: c.render.iface || c.render.name,
    outputName: c.render.name, // what Windows lists as a speaker
    micName: c.capture.name,   // what Windows lists as a microphone
  }));
}

class LinkService {
  constructor({ scrcpy, vcam, store, emit, deviceLabel }) {
    this.scrcpy = scrcpy;
    this.vcam = vcam;
    this.store = store;
    this.emit = emit;
    this.deviceLabel = deviceLabel;
    this.speakers = new Map(); // serial -> speaker state
    this.audioCache = null;
  }

  settings() {
    const s = this.store().get().link || {};
    return {
      cam: { size: '1920x1080', fps: 30, bitRate: 10000000, mirror: false, fit: 'contain', ndi: false, preview: true, ...(s.cam || {}) },
      mic: { route: 'auto', source: 'mic', ...(s.mic || {}) },
      spk: { route: 'auto', switchDefault: true, ...(s.spk || {}) },
      ...Object.fromEntries(Object.entries(s).filter(([k]) => !['cam', 'mic', 'spk'].includes(k))),
    };
  }

  saveSettings(patch) {
    const cur = this.settings();
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch || {})) next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cur[k], ...v } : v;
    this.store().set({ link: next });
    return next;
  }

  exe() { const d = resDir(); return d ? path.join(d, 'studio-vcam.exe') : null; }

  async audio(force = false) {
    if (!force && this.audioCache && Date.now() - this.audioCache.t < 4000) return this.audioCache.data;
    const exe = this.exe();
    if (!IS_WIN || !exe) return { devices: [], cables: [], ndi: false };
    const [list, check] = await Promise.all([run(exe, ['--list-audio'], { timeout: 8000 }), run(exe, ['--check'], { timeout: 8000 })]);
    let devices = [];
    let ndi = false;
    try { devices = JSON.parse(list.stdout); } catch {}
    try { ndi = JSON.parse(check.stdout).ndi; } catch {}
    const data = { devices, cables: findCables(devices), ndi };
    this.audioCache = { t: Date.now(), data };
    return data;
  }

  /** Decide where the mic goes and where the speakers take their sound from. */
  routes(audio, s = this.settings()) {
    const { cables, devices, ndi } = audio;
    const byId = (id) => cables.find(c => c.id === id);
    const outputs = devices.filter(d => d.flow === 'render');
    let mic = null, spk = null;

    const want = (r, prefix) => (typeof r === 'string' && r.startsWith(prefix) ? r.slice(prefix.length) : null);
    // explicit choices first
    if (want(s.mic.route, 'cable:') && byId(want(s.mic.route, 'cable:'))) mic = { kind: 'cable', cable: byId(want(s.mic.route, 'cable:')) };
    else if (s.mic.route === 'ndi' && ndi) mic = { kind: 'ndi' };
    else if (want(s.mic.route, 'out:')) { const d = outputs.find(o => o.id === want(s.mic.route, 'out:')); if (d) mic = { kind: 'monitor', device: d }; }
    if (want(s.spk.route, 'cable:') && byId(want(s.spk.route, 'cable:'))) spk = { kind: 'cable', cable: byId(want(s.spk.route, 'cable:')) };
    else if (want(s.spk.route, 'loop:')) {
      const id = want(s.spk.route, 'loop:');
      const d = id === 'default' ? outputs.find(o => o.default) : outputs.find(o => o.id === id);
      if (d) spk = { kind: 'loop', device: d, followsDefault: id === 'default' };
    }
    // automatic: the mic gets the first free cable (needed for calls), the speakers the next one,
    // otherwise they mirror the default output.
    const used = new Set([mic?.cable?.id, spk?.cable?.id].filter(Boolean));
    const free = () => cables.find(c => !used.has(c.id));
    if (!mic) {
      const c = free();
      if (c) { mic = { kind: 'cable', cable: c, auto: true }; used.add(c.id); }
      else if (ndi) mic = { kind: 'ndi', auto: true };
    }
    if (!spk) {
      const c = free();
      if (c) spk = { kind: 'cable', cable: c, auto: true };
      else {
        const d = outputs.find(o => o.default && !VIRTUAL_RE.test(o.name)) || outputs.find(o => !VIRTUAL_RE.test(o.name));
        if (d) spk = { kind: 'loop', device: d, followsDefault: !!d.default, auto: true };
      }
    }
    if (mic?.kind === 'cable' && spk?.kind === 'cable' && mic.cable.id === spk.cable.id) spk = { ...spk, conflict: true };
    return { mic, spk };
  }

  async info() {
    const audio = await this.audio(true);
    const s = this.settings();
    const reg = await this.vcam.isRegistered();
    return {
      supported: IS_WIN && !!this.exe() && !!serverPath(),
      camera: { installed: reg.x64 && reg.x86, name: 'Scrcpy Studio Camera' },
      ndi: audio.ndi,
      cables: audio.cables.map(({ id, label, outputName, micName }) => ({ id, label, outputName, micName })),
      outputs: audio.devices.filter(d => d.flow === 'render').map(({ id, name, default: def }) => ({ id, name, default: def, virtual: VIRTUAL_RE.test(name) })),
      routes: this.routes(audio, s),
      settings: s,
      running: this.running(),
    };
  }

  running() {
    const out = {};
    for (const [key, st] of this.vcam.active) {
      const m = /^(.*)#(cam|mic)$/.exec(key);
      if (m) (out[m[1]] = out[m[1]] || {})[m[2]] = { stats: st.stats, sinks: st.sinks || {} };
    }
    for (const [serial, st] of this.speakers) (out[serial] = out[serial] || {}).spk = { stats: st.stats, sink: st.sink };
    return out;
  }

  // ------------------------------------------------------------------ start / stop
  async start(serial, kind, opts = {}) {
    if (!IS_WIN) return { ok: false, error: 'Phone Link needs Windows' };
    const label = this.deviceLabel(serial);
    const s = this.settings();
    if (kind === 'cam') {
      // Camera Studio's webcam uses the same virtual camera: hand it over.
      await this.vcam.stop(serial);
      const cam = { ...s.cam, ...opts };
      return this.vcam.start({
        serial, key: `${serial}#cam`, channel: 'c', title: 'Webcam', profileName: 'Phone Link', label,
        video: true, audio: 'none', cameraId: cam.cameraId ?? 0, size: cam.size, fps: cam.fps, bitRate: cam.bitRate,
        mirror: cam.mirror, fit: cam.fit, camera: true, ndi: !!cam.ndi, ndiName: `${label} (Phone Link)`,
      });
    }
    if (kind === 'mic') {
      const { mic } = this.routes(await this.audio(), s);
      if (!mic) return { ok: false, error: 'nowhere', needsSetup: true };
      return this.vcam.start({
        serial, key: `${serial}#mic`, channel: 'm', title: 'Microphone', profileName: 'Phone Link', label,
        video: false, audio: 'mic', audioSource: s.mic.source || 'mic',
        audioDevice: mic.kind === 'cable' ? `id:${mic.cable.render.id}` : mic.kind === 'monitor' ? `id:${mic.device.id}` : null,
        ndi: mic.kind === 'ndi', ndiName: `${label} Mic (Phone Link)`,
      });
    }
    if (kind === 'spk') return this.startSpeaker(serial, label, s);
    return { ok: false, error: 'unknown channel' };
  }

  async stop(serial, kind) {
    if (kind === 'spk') return this.stopSpeaker(serial);
    return this.vcam.stop(`${serial}#${kind}`);
  }

  stopAll() {
    const jobs = [];
    for (const key of [...this.vcam.active.keys()]) if (/#(cam|mic)$/.test(key)) jobs.push(this.vcam.stop(key));
    for (const serial of [...this.speakers.keys()]) jobs.push(this.stopSpeaker(serial));
    return Promise.all(jobs);
  }

  // ------------------------------------------------------------------ speakers
  async startSpeaker(serial, label, s) {
    const exe = this.exe();
    const jar = serverPath();
    if (!exe || !jar) return { ok: false, error: 'Phone Link components are missing.' };
    if (this.speakers.has(serial)) await this.stopSpeaker(serial);
    const audio = await this.audio(true);
    const { spk } = this.routes(audio, s);
    if (!spk) return { ok: false, error: 'No Windows audio output to take the sound from.' };

    const port = await freePort();
    const sock = `sstudio_spk_${crypto.randomBytes(3).toString('hex')}`;
    const handle = this.scrcpy.adopt({
      serial, label: `${label} · Speakers`, mode: 'speaker', profileName: 'Phone Link',
      command: ['studio-speaker', spk.kind === 'cable' ? spk.cable.outputName : `mirror ${spk.device.name}`], stopFn: () => this.stopSpeaker(serial),
    });
    const st = { serial, handle, port, route: spk, server: null, bridge: null, stopping: false, stats: null, sink: null, restoreDefault: null };
    this.speakers.set(serial, st);
    const log = (l, level) => handle.log(l, level);
    const fail = async (msg) => { log(msg, 'error'); st.error = msg; await this.stopSpeaker(serial, msg); return { ok: false, error: msg }; };

    const push = await run(tools.adb, ['-s', serial, 'push', jar, SPK_JAR], { timeout: 30000 });
    if (!push.ok) return fail(`Could not push the player: ${push.stderr || push.error}`);
    const fwd = await run(tools.adb, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:${sock}`], { timeout: 10000 });
    if (!fwd.ok) return fail(`adb forward failed: ${fwd.stderr || fwd.error}`);

    st.server = spawn(tools.adb, ['-s', serial, 'shell', `CLASSPATH=${SPK_JAR} app_process / com.genymobile.scrcpy.studio.Speaker ${sock}`], { windowsHide: true });
    lineReader(st.server.stdout, (l) => log(l));
    lineReader(st.server.stderr, (l) => log(l, 'warn'));
    st.server.on('close', () => { if (!st.stopping) this.stopSpeaker(serial, 'The phone speaker player stopped.'); });

    // Send all Windows sound to the phone: make the cable the default output (restored on stop).
    if (spk.kind === 'cable' && s.spk.switchDefault) {
      const prev = audio.devices.find(d => d.flow === 'render' && d.default);
      if (prev && prev.id !== spk.cable.render.id) {
        const r = await run(exe, ['--set-default', spk.cable.render.id], { timeout: 8000 });
        if (r.ok) { st.restoreDefault = prev.id; log(`Windows output switched to ${spk.cable.outputName}`); }
      }
    }

    const capture = spk.kind === 'cable' ? `id:${spk.cable.render.id}` : `id:${spk.device.id}`;
    st.bridge = spawn(exe, ['--speaker', '--port', String(port), '--capture', capture], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    st.bridge.on('error', (e) => this.stopSpeaker(serial, e.message));
    lineReader(st.bridge.stderr, (l) => log(l));
    lineReader(st.bridge.stdout, (l) => {
      let ev;
      try { ev = JSON.parse(l); } catch { log(l); return; }
      if (ev.event === 'level') { this.emit('link:level', { serial, kind: 'spk', level: ev.speaker }); return; }
      if (ev.event === 'log') log(`bridge: ${ev.message}`, ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'info');
      else if (ev.event === 'connected') { handle.update({ status: 'running' }); this.publish(st); }
      else if (ev.event === 'sink') { st.sink = ev; log(`capturing ${ev.name} (${ev.rate} Hz, ${ev.channels} ch) → phone`); this.publish(st); }
      else if (ev.event === 'stats') { st.stats = ev; this.publish(st); }
      else if (ev.event === 'ended' && !st.stopping) this.stopSpeaker(serial, 'Speaker stream ended');
    });
    st.bridge.on('close', (code) => { if (!st.stopping) this.stopSpeaker(serial, code ? `Speaker bridge exited (${code})` : null); });
    this.publish(st);
    return { ok: true, id: handle.id };
  }

  publish(st) {
    this.emit('link:status', {
      serial: st.serial, kind: 'spk', running: this.speakers.get(st.serial) === st && !st.stopping,
      stats: st.stats, sink: st.sink, error: st.error || null,
      route: st.route?.kind === 'cable' ? { kind: 'cable', name: st.route.cable.outputName } : st.route ? { kind: 'loop', name: st.route.device.name } : null,
    });
  }

  async stopSpeaker(serial, error = null) {
    const st = this.speakers.get(serial);
    if (!st || st.stopping) return false;
    st.stopping = true;
    st.error = error;
    this.speakers.delete(serial);
    try { st.bridge?.stdin.end('quit\n'); } catch {}
    const bridge = st.bridge;
    setTimeout(() => { try { bridge?.kill(); } catch {} }, 1500);
    try { st.server?.kill(); } catch {}
    await run(tools.adb, ['-s', serial, 'forward', '--remove', `tcp:${st.port}`], { timeout: 5000 });
    // Give Windows its previous output back, unless the user changed it meanwhile.
    if (st.restoreDefault) {
      const audio = await this.audio(true);
      const cur = audio.devices.find(d => d.flow === 'render' && d.default);
      if (!cur || cur.id === st.route.cable.render.id) await run(this.exe(), ['--set-default', st.restoreDefault], { timeout: 8000 });
    }
    st.handle.end(error ? 1 : 0, error);
    this.publish(st);
    return true;
  }

  // ------------------------------------------------------------------ phone volume (media stream)
  async volume(serial, value) {
    const cmd = value == null
      ? 'cmd media_session volume --stream 3 --get'
      : `cmd media_session volume --stream 3 --set ${Math.max(0, Math.round(Number(value) || 0))}`;
    const r = await run(tools.adb, ['-s', serial, 'shell', cmd], { timeout: 8000 });
    if (value != null) return this.volume(serial);
    const m = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(r.stdout || '');
    return m ? { ok: true, value: +m[1], min: +m[2], max: +m[3] } : { ok: false };
  }

  async setDefaultOutput(id) {
    const r = await run(this.exe(), ['--set-default', id], { timeout: 8000 });
    this.audioCache = null;
    return { ok: r.ok };
  }
}

module.exports = { LinkService, findCables };
