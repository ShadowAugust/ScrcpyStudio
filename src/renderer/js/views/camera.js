// Camera Studio: pro-mode camera controls (ISO, shutter, focus, WB…) applied
// live to a scrcpy camera session, which doubles as a webcam window.
import { h, icon, clear, replace, debounce } from '../lib/dom.js';
import { toast, showMenu, promptDialog, segmented, selectEl, rangeEl, switchEl, fold, infoTip, emptyState, tip } from '../lib/ui.js';
import { createDial } from '../lib/dial.js';
import { api, state, bus, selectedDevice, deviceName, saveConfig, settings } from '../state.js';
import { navigate } from '../actions.js';

// ------------------------------------------------------------------ scales
const ISO_STOPS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800];
const ISO_MAJOR = new Set([50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]);
// Shutter in seconds (1/3 stops + common anti-flicker speeds)
const SHUTTER = [1 / 12000, 1 / 8000, 1 / 6400, 1 / 5000, 1 / 4000, 1 / 3200, 1 / 2500, 1 / 2000, 1 / 1600, 1 / 1250, 1 / 1000, 1 / 800, 1 / 640, 1 / 500, 1 / 400, 1 / 320,
  1 / 250, 1 / 200, 1 / 160, 1 / 125, 1 / 100, 1 / 90, 1 / 80, 1 / 60, 1 / 50, 1 / 48, 1 / 40, 1 / 30, 1 / 25, 1 / 20, 1 / 15, 1 / 13, 1 / 10, 1 / 8, 1 / 6, 1 / 5, 1 / 4, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
const SHUTTER_MAJOR = new Set([8000, 4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4].map(x => 1 / x));
const FOCUS_MARKS = [[0, '∞'], [0.2, '5m'], [0.5, '2m'], [1, '1m'], [2, '50cm'], [3.33, '30cm'], [5, '20cm'], [6.67, '15cm'], [10, '10cm'], [14.3, '7cm'], [20, '5cm']];
const SCENES = ['off', 'face-priority', 'action', 'portrait', 'landscape', 'night', 'night-portrait', 'theatre', 'beach', 'snow', 'sunset', 'steadyphoto', 'fireworks', 'sports', 'party', 'candlelight', 'barcode', 'high-speed-video', 'hdr'];
const EFFECTS = [['off', 'None', 'linear-gradient(135deg,#ff9a8b,#a18cd1 50%,#62cff4)'], ['mono', 'Mono', 'linear-gradient(135deg,#eee,#333)'], ['negative', 'Negative', 'linear-gradient(135deg,#62cff4,#1a1a40)'], ['solarize', 'Solarize', 'linear-gradient(135deg,#f6d365,#fda085)'], ['sepia', 'Sepia', 'linear-gradient(135deg,#e6c79c,#704214)'], ['posterize', 'Poster', 'linear-gradient(135deg,#f093fb,#f5576c)'], ['aqua', 'Aqua', 'linear-gradient(135deg,#43e97b,#38f9d7)']];

const DEFAULT = {
  lens: null,
  conf: { ae: 'auto', iso: 200, exposure: 16666667, ev: 0, af: 'continuous', focus: 0, awb: 'auto', kelvin: 5200, tint: 0, zoom: 1, meter: 'matrix',
    antibanding: 'auto', ois: 1, eis: 'off', nr: 'fast', edge: 'fast', effect: 'off', scene: 'off', contrast: 0, saturation: 0, torch: 0, aelock: 0, awblock: 0 },
  output: { target: 'window', size: '1920x1080', fps: 30, highSpeed: false, rotation: 0, audio: 'none', borderless: false, onTop: false, grid: false, histogram: true,
    vcam: { camera: true, ndi: true, audioDevice: null, bitRate: 12000000, mirror: false, fit: 'contain' } },
};

const fmtShutter = (ns) => { if (!ns) return '—'; const s = ns / 1e9; return s >= 0.3 ? `${s.toFixed(1)}"` : `1/${Math.round(1 / s)}`; };
const fmtFocus = (d) => (d == null ? '—' : d <= 0.02 ? '∞' : 1 / d >= 1 ? `${(1 / d).toFixed(1)}m` : `${Math.round(100 / d)}cm`);
const fmtEv = (i, step) => { const v = i * step; return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); };

// ------------------------------------------------------------------ state
let root, els = {};
let serial = null, caps = null, capsError = null, status = null, lastFrameAt = 0;
let active = 'iso', dial = null, trigger = 0, focusPoint = null, watching = false, busy = false, lastStatusAt = 0;
let vstatus = null, vstats = null;

function devCfg() {
  const all = state.config.cameraStudio || {};
  const c = all[serial] || {};
  const output = { ...DEFAULT.output, ...(c.output || {}) };
  output.vcam = { ...DEFAULT.output.vcam, ...(c.output?.vcam || {}) };
  return { lens: c.lens ?? DEFAULT.lens, conf: { ...DEFAULT.conf, ...(c.conf || {}) }, output };
}
let cfg = null;
const persist = debounce(() => saveConfig({ cameraStudio: { ...(state.config.cameraStudio || {}), [serial]: cfg } }), 500);

function lensCaps() { return caps?.find(c => c.id === cfg.lens) || caps?.[0] || null; }
function can() {
  const c = lensCaps() || {};
  const capsList = c.capabilities || [];
  return {
    manualSensor: capsList.includes(1),
    manualPost: capsList.includes(2),
    focus: (c.minFocus || 0) > 0 && capsList.includes(1),
    wb: capsList.includes(2) && c.manualWb,
    ois: (c.ois || []).includes(1),
    eis: (c.eis || []).includes(1),
    flash: !!c.flash,
    zoom: c.zoom || [1, 1],
    ev: c.evRange || [0, 0],
    evStep: c.evStep || 0.1,
    iso: c.iso || [50, 3200],
    exposure: c.exposure || [1e5, 1e9 / 8],
    minFocus: c.minFocus || 0,
    afModes: c.afModes || [],
    effects: c.effects || [0],
    scenes: c.scenes || [],
    nr: c.nr || [],
    edge: c.edge || [],
    regions: (c.maxRegionsAe || 0) > 0,
  };
}

function session() {
  return state.sessions.find(s => s.serial === serial && (s.mode === 'camera' || s.mode === 'vcam') && !s.endedAt) || null;
}

// ------------------------------------------------------------------ device I/O
const sendNow = () => {
  if (!serial || !cfg) return;
  const c = cfg.conf;
  const conf = { ...c, live: watching ? 1 : 0, preview: watching ? 1 : 0, fpsmax: cfg.output.highSpeed ? '' : cfg.output.fps, aftrigger: trigger };
  if (focusPoint) { conf.fx = focusPoint.x.toFixed(3); conf.fy = focusPoint.y.toFixed(3); }
  if (c.meter === 'spot' && focusPoint) { conf.px = conf.fx; conf.py = conf.fy; }
  api.camera.conf(serial, conf);
};
let sendTimer = null;
function send() { if (sendTimer) return; sendTimer = setTimeout(() => { sendTimer = null; sendNow(); }, 35); }

function setConf(patch, { silent } = {}) {
  Object.assign(cfg.conf, patch);
  persist();
  send();
  if (!silent) { renderProBar(); renderDialValue(); }
}

const isVcam = () => cfg?.output.target === 'vcam';

function setVcam(patch) { setOutput({ vcam: { ...cfg.output.vcam, ...patch } }); }

function setOutput(patch) {
  Object.assign(cfg.output, patch);
  persist();
  renderSide();
  renderStage();
  if (session()) restartSoon();
}

const restartSoon = debounce(() => restart(), 600);

function buildArgs() {
  const o = cfg.output;
  const lens = lensCaps();
  const args = ['--video-source=camera', `--camera-id=${lens?.id ?? 0}`];
  if (o.highSpeed) {
    args.push(`--camera-size=${o.size}`, '--camera-high-speed', `--camera-fps=${o.fps}`);
  } else {
    args.push(`--camera-size=${o.size}`, `--camera-fps=${o.fps}`);
  }
  if (o.audio === 'none') args.push('--no-audio');
  else args.push(`--audio-source=${o.audio}`);
  if (o.rotation) args.push(`--capture-orientation=${o.rotation}`);
  if (o.borderless) args.push('--window-borderless');
  if (o.onTop) args.push('--always-on-top');
  args.push(`--window-title=${windowTitle()}`);
  return args;
}

function windowTitle() {
  const d = state.devices.find(x => x.serial === serial);
  return `${deviceName(d) || 'Android'} · Camera`;
}

async function start(record = false) {
  if (!serial || busy) return;
  busy = true;
  renderHead();
  sendNow(); // make sure the device has our settings before the camera opens
  if (isVcam()) { await startVcam(); return; }
  const r = await api.scrcpy.start({ serial, args: buildArgs(), mode: 'camera', profileName: 'Camera Studio', label: windowTitle(), record: record ? { format: settings().recordFormat } : null });
  busy = false;
  if (!r?.ok) toast({ type: 'error', title: 'Camera failed to start', message: r?.error });
  else if (!r.session.studio) toast({ type: 'warn', title: 'Pro controls unavailable', message: 'The Studio camera server is missing or does not match your scrcpy version — the webcam works, manual controls won\'t.' });
  renderHead();
  startWatch();
}

async function startVcam() {
  const o = cfg.output, v = o.vcam;
  if (v.camera && vstatus && !vstatus.installed) {
    const ok = await installVcam(true);
    if (!ok && !v.ndi && !v.audioDevice) { busy = false; renderHead(); return; }
  }
  const d = state.devices.find(x => x.serial === serial);
  const r = await api.vcam.start({
    serial, cameraId: lensCaps()?.id ?? 0, size: o.size, fps: o.fps, highSpeed: o.highSpeed, rotation: o.rotation,
    audio: o.audio === 'none' ? 'none' : 'mic', audioSource: o.audio === 'none' ? 'mic' : o.audio, audioDevice: v.audioDevice || null,
    camera: v.camera, ndi: v.ndi && !!vstatus?.ndi, ndiName: `${deviceName(d) || 'Android'} (Scrcpy Studio)`,
    bitRate: v.bitRate, mirror: v.mirror, fit: v.fit,
  });
  busy = false;
  if (!r?.ok) toast({ type: 'error', title: 'Virtual webcam failed to start', message: r?.error });
  else toast({ type: 'success', title: 'Virtual webcam live', message: [r.camera ? `“${vstatus?.name || 'Scrcpy Studio Camera'}”` : null, v.ndi && vstatus?.ndi ? 'NDI' : null, o.audio !== 'none' && v.audioDevice ? `mic → ${v.audioDevice}` : null].filter(Boolean).join(' · '), duration: 3500 });
  renderHead();
  startWatch();
}

async function installVcam(auto = false) {
  const t = toast({ type: 'loading', title: 'Installing the virtual camera…', message: 'Approve the Windows administrator prompt.', duration: 0 });
  const r = await api.vcam.install();
  t.close();
  if (r.ok) toast({ type: 'success', title: 'Virtual camera installed', message: 'Pick “Scrcpy Studio Camera” in vMix, Discord, Zoom, OBS… (restart apps that were already open).', duration: 6000 });
  else toast({ type: auto ? 'warn' : 'error', title: 'Virtual camera not installed', message: r.error });
  vstatus = await api.vcam.status();
  renderSide();
  return r.ok;
}

async function stop() {
  const s = session();
  if (!s) return;
  api.scrcpy.stop(s.id);
  for (let i = 0; i < 60 && session(); i++) await new Promise(r => setTimeout(r, 100));
  renderHead(); renderStage();
}

async function restart() {
  const s = session();
  const rec = !!s?.recordPath;
  if (s) await stop();
  await start(rec);
}

function startWatch() {
  if (!serial || state.view !== 'camera') return;
  watching = true;
  sendNow();
  api.camera.watch(serial, { preview: true });
}
function stopWatch() {
  if (!watching) return;
  watching = false;
  sendNow();
  api.camera.watch(null);
}

// ------------------------------------------------------------------ dial
function dialSpec(ctl) {
  const k = can();
  if (ctl === 'iso') {
    const v = ISO_STOPS.filter(x => x >= k.iso[0] && x <= k.iso[1]);
    return { values: v.map(x => ({ v: x, label: String(x), major: ISO_MAJOR.has(x) })), auto: cfg.conf.ae !== 'manual', manual: k.manualSensor, current: cfg.conf.iso, log: true, live: status?.iso };
  }
  if (ctl === 'speed') {
    const v = SHUTTER.map(s => Math.round(s * 1e9)).filter(ns => ns >= k.exposure[0] && ns <= k.exposure[1]);
    return { values: v.map(ns => ({ v: ns, label: fmtShutter(ns), major: [...SHUTTER_MAJOR].some(m => Math.abs(m * 1e9 - ns) < 1000) })), auto: cfg.conf.ae !== 'manual', manual: k.manualSensor, current: cfg.conf.exposure, log: true, live: status?.exposure };
  }
  if (ctl === 'ev') {
    const out = [];
    for (let i = k.ev[0]; i <= k.ev[1]; i++) out.push({ v: i, label: fmtEv(i, k.evStep).replace('.0', ''), major: Math.abs((i * k.evStep) % 1) < 1e-6 });
    return { values: out, auto: cfg.conf.ev === 0, manual: cfg.conf.ae !== 'manual' && out.length > 1, current: cfg.conf.ev, resetLabel: '0' };
  }
  if (ctl === 'focus') {
    const out = [];
    const marks = FOCUS_MARKS.filter(([d]) => d <= k.minFocus + 1e-6);
    for (let m = 0; m < marks.length; m++) {
      const [d, label] = marks[m];
      out.push({ v: d, label, major: true });
      const next = marks[m + 1]?.[0] ?? null;
      if (next != null) for (let j = 1; j < 5; j++) out.push({ v: d + ((next - d) * j) / 5 });
    }
    return { values: out, auto: cfg.conf.af !== 'manual', manual: k.focus, current: cfg.conf.focus, linear: true, live: status?.focus };
  }
  if (ctl === 'wb') {
    const out = [];
    for (let kk = 2300; kk <= 10000; kk += 100) out.push({ v: kk, label: `${(kk / 1000).toFixed(kk % 1000 ? 1 : 0)}K`, major: kk % 1000 === 0 });
    return { values: out, auto: cfg.conf.awb !== 'manual', manual: k.wb, current: cfg.conf.kelvin, linear: true, live: status?.kelvin };
  }
  // zoom
  const out = [];
  for (let z = 10; z <= Math.round(k.zoom[1] * 10); z++) out.push({ v: z / 10, label: `${z / 10}×`, major: z % 10 === 0 });
  return { values: out, auto: cfg.conf.zoom === 1, manual: out.length > 1, current: cfg.conf.zoom, linear: true, resetLabel: '1×' };
}

function renderDial() {
  const spec = dialSpec(active);
  const idx = nearest(spec.values, spec.current, spec.log);
  if (!dial) {
    dial = createDial({
      values: spec.values, index: idx,
      onChange: (x) => applyDial(x.v),
      onCommit: (x) => applyDial(x.v),
    });
    dial.addEventListener('dialgrab', () => {
      // Grabbing the dial while in auto switches this control to manual (like pro camera apps).
      const s = dialSpec(active);
      if (s.auto && s.manual && !['ev', 'zoom'].includes(active)) goManual(active);
    });
    replace(els.dialSlot, dial);
  } else {
    dial.setValues(spec.values, idx);
  }
  dial.setDisabled(!spec.manual);
  dial.dataset.grabAuto = spec.manual ? '1' : '';
  if (spec.auto && spec.live != null) spec.linear ? dial.followLinear(spec.live) : dial.follow(spec.live);
  els.autoBtn.textContent = ['ev', 'zoom'].includes(active) ? 'RESET' : 'AUTO';
  els.autoBtn.classList.toggle('on', spec.auto);
  els.autoBtn.disabled = !spec.manual && !['ev', 'zoom'].includes(active);
  renderDialValue();
}

function nearest(values, target, log) {
  let best = 0, bestD = Infinity;
  values.forEach((x, i) => {
    const d = log ? Math.abs(Math.log(Math.max(1e-9, x.v)) - Math.log(Math.max(1e-9, target || 1e-9))) : Math.abs(x.v - (target ?? 0));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function goManual(ctl) {
  if (ctl === 'iso' || ctl === 'speed') {
    const k = can();
    const iso = Math.min(k.iso[1], Math.max(k.iso[0], status?.iso || cfg.conf.iso));
    const exp = Math.min(k.exposure[1], Math.max(k.exposure[0], status?.exposure || cfg.conf.exposure));
    setConf({ ae: 'manual', iso: ISO_STOPS[nearest(ISO_STOPS.map(v => ({ v })), iso, true)], exposure: exp });
  } else if (ctl === 'focus') {
    setConf({ af: 'manual', focus: +(status?.focus ?? cfg.conf.focus).toFixed(2) });
  } else if (ctl === 'wb') {
    setConf({ awb: 'manual', kelvin: Math.round((status?.kelvin || cfg.conf.kelvin) / 100) * 100 });
  }
  renderDial();
}

function applyDial(v) {
  const spec = dialSpec(active);
  if (!spec.manual) return;
  if (active === 'iso') setConf({ ae: 'manual', iso: v });
  else if (active === 'speed') setConf({ ae: 'manual', exposure: v });
  else if (active === 'ev') setConf({ ev: v });
  else if (active === 'focus') setConf({ af: 'manual', focus: +v.toFixed(3) });
  else if (active === 'wb') setConf({ awb: 'manual', kelvin: v });
  else if (active === 'zoom') setConf({ zoom: v });
  els.autoBtn.classList.toggle('on', dialSpec(active).auto);
}

function toggleAuto() {
  const spec = dialSpec(active);
  if (active === 'ev') setConf({ ev: 0 });
  else if (active === 'zoom') setConf({ zoom: 1 });
  else if (!spec.auto) {
    if (active === 'iso' || active === 'speed') setConf({ ae: 'auto' });
    if (active === 'focus') { focusPoint = null; setConf({ af: 'continuous' }); }
    if (active === 'wb') setConf({ awb: 'auto' });
  } else goManual(active);
  renderDial();
}

function renderDialValue() {
  if (!els.dialValue) return;
  const spec = dialSpec(active);
  const txt = {
    iso: () => String(spec.auto ? status?.iso ?? '—' : cfg.conf.iso),
    speed: () => fmtShutter(spec.auto ? status?.exposure : cfg.conf.exposure),
    ev: () => fmtEv(cfg.conf.ev, can().evStep),
    focus: () => fmtFocus(spec.auto ? status?.focus : cfg.conf.focus),
    wb: () => `${spec.auto ? status?.kelvin ?? '—' : cfg.conf.kelvin}K`,
    zoom: () => `${(+cfg.conf.zoom).toFixed(1)}×`,
  }[active]();
  replace(els.dialValue, h('b', txt), h('span', spec.manual ? (spec.auto ? 'Auto' : 'Manual') : 'Auto only'));
}

// ------------------------------------------------------------------ pro bar
const CONTROLS = [
  ['iso', 'ISO'], ['speed', 'Speed'], ['ev', 'EV'], ['focus', 'Focus'], ['wb', 'WB'], ['zoom', 'Zoom'],
];

function renderProBar() {
  if (!els.proBar) return;
  const k = can();
  replace(els.proBar, CONTROLS.map(([id, label]) => {
    const spec = dialSpec(id);
    const manual = !spec.auto;
    const value = {
      iso: () => spec.auto ? (status?.iso ?? 'Auto') : cfg.conf.iso,
      speed: () => spec.auto ? (status?.exposure ? fmtShutter(status.exposure) : 'Auto') : fmtShutter(cfg.conf.exposure),
      ev: () => fmtEv(cfg.conf.ev, k.evStep),
      focus: () => spec.auto ? (cfg.conf.af === 'auto' && focusPoint ? 'Tap' : 'AF') : fmtFocus(cfg.conf.focus),
      wb: () => spec.auto ? (cfg.conf.awb === 'auto' ? (status?.kelvin ? `${status.kelvin}K` : 'AWB') : cfg.conf.awb) : `${cfg.conf.kelvin}K`,
      zoom: () => `${(+cfg.conf.zoom).toFixed(1)}×`,
    }[id]();
    const flag = ['ev', 'zoom'].includes(id) ? (manual ? '●' : '') : (spec.manual ? (manual ? 'M' : 'A') : 'A');
    return h(`button.pro-chip${active === id ? '.active' : ''}${manual && flag ? '.manual' : ''}`, {
      onclick: () => { active = id; renderProBar(); renderDial(); },
      dataset: { tip: spec.manual ? '' : 'This lens only supports automatic control' },
    }, h('span.k', label), h('span.v', String(value)), flag ? h('span.a', flag) : null);
  }),
  h('button.pro-chip', { style: { flex: '0 0 64px', minWidth: '64px' }, dataset: { tip: 'Looks: save & load camera presets' }, onclick: (e) => looksMenu(e.currentTarget) }, h('span.k', 'Looks'), h('span.v', icon('sparkles'))));
}

async function looksMenu(anchor) {
  const looks = state.config.cameraLooks || [];
  showMenu(anchor, [
    { heading: 'Camera looks' },
    ...looks.map(l => ({ label: l.name, icon: 'wand-sparkles', onClick: () => { Object.assign(cfg.conf, l.conf); persist(); send(); renderAll(); toast({ type: 'success', title: `Look applied: ${l.name}`, duration: 1600 }); } })),
    looks.length ? '-' : null,
    { label: 'Save current look…', icon: 'save', onClick: async () => {
      const name = await promptDialog({ title: 'Save look', label: 'Name', placeholder: 'Warm desk light' });
      if (!name) return;
      const { torch, ...conf } = cfg.conf;
      await saveConfig({ cameraLooks: [...looks.filter(l => l.name !== name), { name, conf }] });
      toast({ type: 'success', title: 'Look saved', message: name, duration: 1600 });
    } },
    looks.length ? { label: 'Delete a look…', icon: 'trash-2', danger: true, onClick: () => showMenu(anchor, looks.map(l => ({ label: l.name, icon: 'x', danger: true, onClick: () => saveConfig({ cameraLooks: looks.filter(x => x !== l) }) }))) } : null,
    '-',
    { label: 'Reset everything to auto', icon: 'undo-2', onClick: () => { focusPoint = null; cfg.conf = { ...DEFAULT.conf }; persist(); send(); renderAll(); } },
  ]);
}

// ------------------------------------------------------------------ stage
function renderStage() {
  if (!els.stage) return;
  if (els.idleTitle) { els.idleTitle.textContent = isVcam() ? 'Start virtual webcam' : 'Go live'; els.idleText.textContent = isVcam() ? 'Your phone becomes a camera + mic for vMix, Discord and other apps' : 'Opens the camera as a webcam window · tap the preview to focus'; }
  const live = !!session();
  els.idle.classList.toggle('hidden', live);
  els.frame.classList.toggle('hidden', !live);
  els.grid.classList.toggle('hidden', !cfg?.output.grid);
  els.histo.classList.toggle('hidden', !cfg?.output.histogram || !live);
  const rot = cfg?.output.rotation || 0;
  els.frame.style.aspectRatio = (rot === 90 || rot === 270) ? '9 / 16' : '16 / 9';
  els.img.style.transform = rot ? `rotate(${rot}deg)` : '';
  if (rot === 90 || rot === 270) { els.img.style.width = els.frame.clientHeight + 'px'; els.img.style.height = els.frame.clientWidth + 'px'; }
  else { els.img.style.width = ''; els.img.style.height = ''; }
  replace(els.cornerActions,
    tip(h(`button.glass-btn${cfg?.output.grid ? '.on' : ''}`, { onclick: () => setOutputLocal({ grid: !cfg.output.grid }) }, icon('grid-3x3')), 'Grid'),
    tip(h(`button.glass-btn${cfg?.output.histogram ? '.on' : ''}`, { onclick: () => setOutputLocal({ histogram: !cfg.output.histogram }) }, icon('chart-column')), 'Histogram'),
    can().flash ? tip(h(`button.glass-btn${cfg?.conf.torch ? '.on' : ''}`, { onclick: () => { setConf({ torch: cfg.conf.torch ? 0 : 1 }); renderStage(); } }, icon(cfg?.conf.torch ? 'flashlight' : 'flashlight-off')), 'Torch') : null,
    focusPoint ? tip(h('button.glass-btn', { onclick: () => { focusPoint = null; setConf({ af: 'continuous' }); els.reticle?.remove(); renderStage(); } }, icon('focus'), 'Continuous AF'), 'Back to continuous autofocus') : null);
}

function setOutputLocal(patch) { Object.assign(cfg.output, patch); persist(); renderStage(); }

function renderHud() {
  if (!els.hud) return;
  const s = status;
  const live = session();
  if (!live) { clear(els.hud); return; }
  const c = cfg.conf;
  const chip = (ic, text, auto, cls = '') => h(`span.hud-chip${auto ? '.auto' : ''}${cls}`, ic ? icon(ic) : null, text);
  replace(els.hud,
    chip(null, [h(`span.dot${live.recordPath ? '.rec' : '.live'}`), live.recordPath ? ' REC' : live.mode === 'vcam' ? ' WEBCAM' : ' LIVE'], false, live.recordPath ? '.rec' : ''),
    live.mode === 'vcam' && vstats ? chip(vstats.cameraInUse ? 'webcam' : 'circle-dot', vstats.cameraInUse ? 'In use' : 'Idle') : null,
    live.mode === 'vcam' && vstats?.ndi ? chip('radio', `NDI · ${vstats.ndiClients || 0}`) : null,
    live.mode === 'vcam' && vstats?.audio ? chip('mic', 'Mic') : null,
    chip('video', `${cfg.output.size.replace('x', '×')} · ${s?.fps ? Math.round(s.fps) : cfg.output.fps}fps`),
    s ? chip(null, `ISO ${s.iso ?? '—'}`, c.ae !== 'manual') : null,
    s ? chip(null, fmtShutter(s.exposure), c.ae !== 'manual') : null,
    s?.aperture ? chip('aperture', `f/${(+s.aperture).toFixed(1)}`) : null,
    s?.kelvin ? chip('thermometer', `${s.kelvin}K`, c.awb !== 'manual') : null,
    s && can().focus ? chip('focus', fmtFocus(s.focus), c.af !== 'manual') : null,
    s?.zoom && s.zoom !== 1 ? chip('zoom-in', `${(+s.zoom).toFixed(1)}×`) : null,
    !s && live.studio ? chip('loader-circle', 'Connecting…') : null,
    !live.studio ? chip('triangle-alert', 'Pro controls off') : null);
  // Histogram
  if (s?.hist && !els.histo.classList.contains('hidden')) {
    const pts = s.hist.map((v, i) => `${(i / 63) * 100},${40 - (v / 255) * 38}`).join(' ');
    els.histo.innerHTML = `<svg viewBox="0 0 100 40" preserveAspectRatio="none"><polygon points="0,40 ${pts} 100,40" fill="rgba(255,255,255,.55)"/></svg>`;
  }
  if (els.reticle && s) els.reticle.classList.toggle('locked', s.afState === 4);
}

function onTap(e) {
  if (!session()) return;
  const r = els.img.getBoundingClientRect();
  let u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  // The preview is rotated with CSS; map back to sensor coordinates.
  const rot = cfg.output.rotation || 0;
  let x = u, y = v;
  if (rot === 90) { x = v; y = 1 - u; }
  if (rot === 180) { x = 1 - u; y = 1 - v; }
  if (rot === 270) { x = 1 - v; y = u; }
  focusPoint = { x, y };
  trigger++;
  const fr = els.frame.getBoundingClientRect();
  els.reticle?.remove();
  els.reticle = h('div.reticle', { style: { left: (e.clientX - fr.left) + 'px', top: (e.clientY - fr.top) + 'px' } });
  els.frame.appendChild(els.reticle);
  setConf({ af: can().focus ? 'auto' : cfg.conf.af });
  renderStage();
}

// ------------------------------------------------------------------ side panel
function lensLabel(c, backs, fronts) {
  if (c.facing !== 'back') {
    const widest = [...fronts].sort((a, b) => (a.focal35 || 99) - (b.focal35 || 99))[0];
    return { big: icon('switch-camera'), small: fronts.length > 1 && c === widest ? 'Front wide' : 'Front' };
  }
  const main = backs.find(b => b.id === '0') || backs[0];
  const ratio = main?.focal35 && c.focal35 ? c.focal35 / main.focal35 : 1;
  const txt = ratio < 0.95 ? ratio.toFixed(1).replace(/^0/, '') : `${Math.round(ratio)}`;
  return { big: `${txt}×`, small: ratio < 0.95 ? 'Ultra wide' : ratio > 1.5 ? 'Tele' : 'Wide' };
}

function renderSide() {
  if (!els.side) return;
  if (!caps) { replace(els.side, h('div.card.card-pad', h('div.skeleton', { style: { height: '220px' } }))); return; }
  const k = can();
  const c = cfg.conf, o = cfg.output;
  const lens = lensCaps();
  const backs = caps.filter(x => x.facing === 'back').sort((a, b) => (a.focal35 || 0) - (b.focal35 || 0));
  const fronts = caps.filter(x => x.facing !== 'back');

  const lensCard = h('div.card',
    h('div.lens-row', [...backs, ...fronts].map(cam => {
      const l = lensLabel(cam, backs, fronts);
      return h(`button.lens${cam.id === lens?.id ? '.active' : ''}`, { dataset: { tip: [cam.focal35 ? `${cam.focal35}mm` : null, cam.aperture ? `f/${(+cam.aperture).toFixed(1)}` : null, `camera ${cam.id}`].filter(Boolean).join(' · ') }, onclick: () => { if (cam.id === cfg.lens) return; cfg.lens = cam.id; persist(); renderAll(); if (session()) restartSoon(); } },
        h('span.l', l.big), l.small);
    })),
    h('div.faint', { style: { textAlign: 'center', fontSize: '11.5px', padding: '0 12px 14px' } },
      [lens?.active ? `${Math.round(lens.active[0] * lens.active[1] / 1e6)}MP` : null, lens?.aperture ? `f/${(+lens.aperture).toFixed(1)}` : null, lens?.focal35 ? `${lens.focal35}mm` : null,
        k.manualSensor ? 'Manual' : 'Auto only'].filter(Boolean).join(' · ')));

  // Output
  const sizes = (lens?.sizes || []);
  const presets = [['3840x2160', '4K'], ['2560x1440', '1440p'], ['1920x1080', '1080p'], ['1280x720', '720p'], ['1440x1080', '4:3'], ['1080x1080', '1:1']].filter(([s]) => sizes.includes(s));
  const hs = (lens?.highSpeed || []).filter(x => x.startsWith(o.size + '@')).map(x => +x.split('@')[1]);
  const fpsOpts = [...new Set([...(lens?.fpsRanges || []).map(r => r[1]), ...hs])].filter(Boolean).sort((a, b) => a - b);
  const output = h('div.col', { style: { gap: '12px' } },
    vstatus?.supported ? segmented([['window', 'Window', 'app-window'], ['vcam', 'Virtual webcam', 'webcam']], o.target, (t) => { setOutput(t === 'vcam' && o.audio === 'none' ? { target: t, audio: 'mic' } : { target: t }); renderHead(); }) : null,
    h('div.row.wrap', { style: { gap: '6px' } }, presets.map(([s, l]) => h(`button.chip${o.size === s ? '.on' : ''}`, { onclick: () => setOutput({ size: s, highSpeed: false, fps: Math.min(o.fps, 30) }) }, l))),
    h('div.kv-line', h('div.l', icon('gauge', '', 15), 'FPS'), segmented(fpsOpts.map(f => [f, String(f)]), o.fps, (f) => setOutput({ fps: f, highSpeed: f > 30 && hs.includes(f) }))),
    h('div.kv-line', h('div.l', icon('rotate-cw', '', 15), 'Rotate'), segmented([[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], o.rotation, (r) => setOutput({ rotation: r }))),
    h('div.kv-line', h('div.l', icon('mic', '', 15), 'Phone mic'), selectEl([['none', 'Off'], ['mic', 'Microphone'], ['mic-camcorder', 'Camcorder mic'], ['mic-voice-communication', 'Voice (echo cancel)'], ['mic-unprocessed', 'Raw mic']], o.audio, (a) => setOutput({ audio: a }), 'sm')),
    isVcam() ? vcamPanel() : h('div.opt-grid',
      h(`button.opt-tile${o.borderless ? '.on' : ''}`, { onclick: () => setOutput({ borderless: !o.borderless }) }, icon('square-dashed'), 'Borderless'),
      h(`button.opt-tile${o.onTop ? '.on' : ''}`, { onclick: () => setOutput({ onTop: !o.onTop }) }, icon('pin'), 'On top'),
      h('button.opt-tile', { onclick: () => api.clipboard.text(windowTitle()).then(() => toast({ type: 'success', title: 'Window title copied', message: 'In OBS: Window Capture → pick this window → Start Virtual Camera.', duration: 5000 })) }, icon('copy'), 'OBS title')));

  // Image
  const tile = (on, ic, label, onclick, disabled, tipText) => h(`button.opt-tile${on ? '.on' : ''}`, { onclick, disabled, dataset: tipText ? { tip: tipText } : {} }, icon(ic), label);
  const image = h('div.col', { style: { gap: '12px' } },
    h('div.section-title', 'Metering'),
    h('div.opt-grid',
      tile(c.meter === 'matrix', 'scan', 'Matrix', () => setConf({ meter: 'matrix' }) || renderSide()),
      tile(c.meter === 'center', 'circle-dot', 'Center', () => setConf({ meter: 'center' }) || renderSide(), !k.regions),
      tile(c.meter === 'spot', 'crosshair', 'Spot', () => setConf({ meter: 'spot' }) || renderSide(), !k.regions, 'Meters where you tap the preview')),
    h('div.section-title', 'Focus mode'),
    h('div.opt-grid',
      tile(c.af === 'continuous', 'focus', 'Continuous', () => { focusPoint = null; setConf({ af: 'continuous' }); renderSide(); }, !k.afModes.includes(3)),
      tile(c.af === 'auto', 'crosshair', 'Tap / single', () => { setConf({ af: 'auto' }); trigger++; send(); renderSide(); }, !k.afModes.includes(1)),
      tile(c.af === 'macro', 'flower', 'Macro', () => setConf({ af: 'macro' }) || renderSide(), !k.afModes.includes(2))),
    h('div.section-title', 'White balance'),
    h('div.opt-grid',
      ...[['auto', 'wand-sparkles', 'Auto'], ['daylight', 'sun', 'Daylight'], ['cloudy', 'cloud', 'Cloudy'], ['shade', 'cloud-sun', 'Shade'], ['incandescent', 'lightbulb', 'Tungsten'], ['fluorescent', 'lamp', 'Fluoresc.']].map(([m, ic, l]) =>
        tile(c.awb === m, ic, l, () => { setConf({ awb: m }); renderSide(); renderDial(); }))),
    k.wb ? h('div.slider-line', 'Tint', rangeEl({ min: -50, max: 50, value: c.tint, onInput: (v) => { setConf({ tint: v }, { silent: true }); } }), h('span.v', String(c.tint))) : null,
    h('div.section-title', 'Stabilization & flicker'),
    h('div.opt-grid',
      tile(+c.ois === 1, 'hand', 'OIS', () => setConf({ ois: +c.ois === 1 ? 0 : 1 }) || renderSide(), !k.ois, 'Optical image stabilization'),
      tile(c.eis === 'on', 'move', 'EIS', () => setConf({ eis: c.eis === 'on' ? 'off' : 'on' }) || renderSide(), !k.eis, 'Electronic stabilization (crops slightly)'),
      tile(c.aelock == 1, c.aelock == 1 ? 'lock' : 'lock-open', 'AE lock', () => setConf({ aelock: c.aelock == 1 ? 0 : 1 }) || renderSide(), c.ae === 'manual')),
    h('div.kv-line', h('div.l', icon('zap', '', 15), 'Anti-flicker', infoTip('Match your mains frequency to remove banding from LED/fluorescent lights (50Hz: Europe/Brazil…, 60Hz: Americas).')),
      segmented([['auto', 'Auto'], ['50', '50Hz'], ['60', '60Hz'], ['off', 'Off']], c.antibanding, (v) => setConf({ antibanding: v }))),
    h('div.section-title', 'Processing'),
    h('div.kv-line', h('div.l', 'Noise reduction'), segmented([['off', 'Off'], ['fast', 'Fast'], ['hq', 'HQ']].filter(([m], i) => k.nr.includes(i)), c.nr, (v) => setConf({ nr: v }))),
    h('div.kv-line', h('div.l', 'Sharpening'), segmented([['off', 'Off'], ['fast', 'Fast'], ['hq', 'HQ']].filter(([m], i) => k.edge.includes(i)), c.edge, (v) => setConf({ edge: v }))),
    h('div.slider-line', 'Contrast', rangeEl({ min: -100, max: 100, value: c.contrast, onInput: (v) => { setConf({ contrast: v }, { silent: true }); } }), h('span.v', String(c.contrast))),
    h('div.slider-line', { style: { opacity: k.wb && c.awb === 'manual' ? 1 : .45 }, dataset: { tip: 'Saturation works with manual (Kelvin) white balance' } }, 'Saturation',
      rangeEl({ min: -100, max: 100, value: c.saturation, onInput: (v) => { setConf({ saturation: v }, { silent: true }); } }), h('span.v', String(c.saturation))),
    h('div.section-title', 'Effect'),
    h('div.swatch-row', EFFECTS.filter((e, i) => k.effects.includes(i === 5 ? 5 : i === 6 ? 8 : i)).map(([id, label, bg]) =>
      h(`button.fx${c.effect === id ? '.on' : ''}`, { style: { background: bg }, dataset: { tip: label }, onclick: () => { setConf({ effect: id }); renderSide(); } }))),
    k.scenes.length > 1 ? h('div.kv-line', h('div.l', icon('mountain', '', 15), 'Scene'),
      selectEl(k.scenes.map(i => [SCENES[i] || 'off', i === 0 ? 'None' : (SCENES[i] || String(i)).replace(/-/g, ' ')]), c.scene, (v) => setConf({ scene: v }), 'sm')) : null);

  replace(els.side,
    lensCard,
    h('div.card', { style: { overflow: 'hidden' } },
      fold(isVcam() ? 'Virtual webcam & mic' : 'Output & window', isVcam() ? 'webcam' : 'video', output, true),
      fold('Image & light', 'aperture', image, false)));
}

function vcamPanel() {
  const v = cfg.output.vcam, st = vstatus || {};
  const outputs = st.outputs || [];
  const cable = outputs.find(x => x.virtual);
  const row = (ic, title, tipText, control) => h('div.kv-line', h('div.l', icon(ic, '', 15), title, infoTip(tipText)), control);
  const deviceOpts = [['', 'Don\'t route'], ...outputs.map(x => [x.name, `${x.name}${x.virtual ? '  (virtual mic)' : x.default ? '  (speakers)' : ''}`])];
  const help = [
    ['vMix', 'Add Input → Camera → “Scrcpy Studio Camera” (or NDI → this phone for video + audio).'],
    ['Discord', 'Settings → Voice & Video → Camera: “Scrcpy Studio Camera”. Input device: the virtual mic (CABLE Output) or NDI Webcam Audio.'],
    ['Zoom / Teams / Meet', 'Choose “Scrcpy Studio Camera” as the camera. Browsers and apps must be restarted after installing.'],
    ['Windows Camera app', 'Apps that only use Media Foundation (like the Camera app) need NDI Webcam: send NDI and pick this phone in NDI Webcam Input.'],
  ];
  return h('div.col', { style: { gap: '10px' } },
    row('webcam', 'Webcam device', 'DirectShow camera visible to vMix, Discord, Zoom, OBS, Chrome/Edge and most Windows apps.',
      st.installed
        ? h('div.row', { style: { gap: '6px' } }, h('span.chip.success', icon('check'), 'Installed'), switchEl(v.camera, (on) => setVcam({ camera: on })))
        : h('button.btn.sm.primary', { onclick: () => installVcam() }, icon('download'), 'Install')),
    row('radio', 'NDI output', st.ndi ? 'Sends video + mic as an NDI source: native in vMix/OBS; NDI Webcam turns it into a camera and microphone for any app.' : 'Install NDI Tools to enable NDI output.',
      switchEl(v.ndi && st.ndi, (on) => setVcam({ ndi: on }), { disabled: !st.ndi })),
    row('mic', 'Mic output', 'Plays the phone microphone into this device. Pick a virtual audio cable (e.g. VB-CABLE Input) and apps can use its other end as a microphone.',
      selectEl(deviceOpts, v.audioDevice || '', (d) => setVcam({ audioDevice: d || null }), 'sm')),
    !cable && !st.ndi ? h('div.banner', { style: { margin: 0, padding: '10px 12px' } }, icon('info'), h('div.grow', h('span', 'For a microphone in Discord & co. install a free virtual audio cable.')),
      h('button.btn.sm', { onclick: () => api.shell.openExternal('https://vb-audio.com/Cable/') }, 'VB-CABLE')) : null,
    row('gauge', 'Quality', 'Video bitrate from the phone. 15 Mbps is the safe maximum for the S20 FE encoder.',
      segmented([[4000000, '4'], [8000000, '8'], [12000000, '12'], [15000000, '15']], v.bitRate, (b) => setVcam({ bitRate: b }))),
    h('div.opt-grid',
      h(`button.opt-tile${v.mirror ? '.on' : ''}`, { onclick: () => setVcam({ mirror: !v.mirror }), dataset: { tip: 'Flip horizontally (selfie view)' } }, icon('arrow-right-left'), 'Mirror'),
      h(`button.opt-tile${v.fit === 'cover' ? '.on' : ''}`, { onclick: () => setVcam({ fit: v.fit === 'cover' ? 'contain' : 'cover' }), dataset: { tip: 'Fill the frame (crop) instead of letterboxing' } }, icon('crop'), 'Fill'),
      h('button.opt-tile', { onclick: (e) => showMenu(e.currentTarget, [{ heading: 'Use it in…' }, ...help.map(([app, text]) => ({ label: app, icon: 'info', onClick: () => toast({ title: app, message: text, duration: 9000 }) })),
        st.installed ? '-' : null, st.installed ? { label: 'Uninstall virtual camera', icon: 'trash-2', danger: true, onClick: async () => { const r = await api.vcam.uninstall(); toast(r.ok ? { type: 'success', title: 'Virtual camera removed' } : { type: 'error', title: 'Uninstall failed', message: r.error }); vstatus = await api.vcam.status(); renderSide(); } } : null]) }, icon('circle-help'), 'How to use')));
}

// ------------------------------------------------------------------ head
function renderHead() {
  if (!els.headActions) return;
  const live = session();
  const d = selectedDevice();
  const ready = d?.state === 'device' && caps;
  els.sub.textContent = live ? (live.mode === 'vcam' ? `Virtual webcam live${vstats?.cameraInUse ? ' · in use by an app' : ''}${vstats?.ndiClients ? ` · ${vstats.ndiClients} NDI receiver${vstats.ndiClients > 1 ? 's' : ''}` : ''}` : `Live as “${windowTitle()}”`) : '';
  replace(els.headActions,
    live ? tip(h('button.btn.icon', { onclick: () => restart() }, icon('refresh-cw')), 'Restart camera') : null,
    !live?.recordPath && !isVcam() ? h('button.btn', { disabled: !ready || busy, onclick: async () => { if (live) await stop(); await start(true); } }, icon('disc'), 'Record') : null,
    live
      ? h('button.btn.danger', { onclick: stop }, icon('square'), 'Stop')
      : h('button.btn.hot', { disabled: !ready || busy, onclick: () => start(false) }, icon(busy ? 'loader-circle' : 'video', busy ? 'spin' : ''), busy ? 'Starting…' : isVcam() ? 'Start webcam' : 'Go live'));
}

function renderAll() {
  renderHead();
  renderSide();
  renderProBar();
  renderDial();
  renderStage();
  renderHud();
}

// ------------------------------------------------------------------ lifecycle
async function load() {
  const d = selectedDevice();
  const newSerial = d?.state === 'device' ? d.serial : null;
  if (newSerial !== serial) { stopWatch(); serial = newSerial; caps = null; status = null; focusPoint = null; }
  if (!serial) { renderEmpty(); return; }
  cfg = devCfg();
  els.body.classList.remove('hidden');
  els.empty.classList.add('hidden');
  renderAll();
  if (!caps) {
    const r = await api.camera.caps(serial);
    if (serial !== d.serial) return;
    if (!r.ok) { capsError = r.error; caps = []; toast({ type: 'error', title: 'Could not read cameras', message: r.error }); }
    else { caps = r.cameras; capsError = null; }
    if (!cfg.lens || !caps.find(c => c.id === cfg.lens)) cfg.lens = caps[0]?.id ?? null;
    renderAll();
  }
  if (!vstatus) api.vcam?.status().then((st) => {
    vstatus = st;
    if (cfg && st?.outputs && cfg.output.vcam.audioDevice == null) { const cab = st.outputs.find(x => x.virtual); if (cab) cfg.output.vcam.audioDevice = cab.name; }
    renderSide();
  });
  if (session()) startWatch();
}

function renderEmpty() {
  els.body.classList.add('hidden');
  els.empty.classList.remove('hidden');
  replace(els.empty, h('div.card', emptyState({ icon: 'camera', title: 'Connect a device', text: 'Camera Studio turns your phone camera into a pro webcam with manual ISO, shutter, focus and white balance.', actions: [h('button.btn.primary', { onclick: () => navigate('devices') }, 'Go to devices')] })));
  replace(els.headActions);
}

export default {
  id: 'camera', title: 'Camera', icon: 'aperture', flex: true,
  create(r) {
    root = r;
    els.sub = h('div.sub');
    els.headActions = h('div.actions');
    els.img = h('img', { alt: '', draggable: false });
    els.grid = h('div.grid-lines.hidden');
    els.frame = h('div.frame.hidden', { onclick: onTap, ondblclick: () => { focusPoint = null; setConf({ af: 'continuous' }); els.reticle?.remove(); renderStage(); } }, els.img, els.grid);
    els.idle = h('div.cam-idle', h('div',
      h('button.big', { onclick: () => start(false) }, icon('video')),
      els.idleTitle = h('h3', 'Go live'),
      els.idleText = h('p', 'Opens the camera as a webcam window · tap the preview to focus')));
    els.hud = h('div.cam-hud');
    els.histo = h('div.cam-histo.hidden');
    els.cornerActions = h('div.corner-actions');
    els.stage = h('div.cam-stage', els.frame, els.idle, els.hud, els.histo, els.cornerActions);
    els.proBar = h('div.card.pro-bar');
    els.autoBtn = h('button.dial-auto', { onclick: toggleAuto });
    els.dialSlot = h('div', { style: { flex: 1, minWidth: 0 } });
    els.dialValue = h('div.dial-value');
    els.side = h('div.cam-side');
    els.body = h('div.cam.fill',
      h('div.cam-main', els.stage, els.proBar, h('div.card.dial-wrap', els.autoBtn, els.dialSlot, els.dialValue)),
      els.side);
    els.empty = h('div.hidden');
    root.append(h('div.page-head', els.sub, els.headActions), els.body, els.empty);

    api.on.cameraStatus(({ serial: s, status: st }) => {
      if (s !== serial) return;
      status = st;
      lastStatusAt = Date.now();
      renderHud();
      renderProBar();
      const spec = dialSpec(active);
      if (dial && spec.auto && spec.live != null) { spec.linear ? dial.followLinear(spec.live) : dial.follow(spec.live); renderDialValue(); }
    });
    api.on.cameraPreview(({ serial: s, frame }) => {
      if (s !== serial) return;
      els.img.src = frame;
      lastFrameAt = Date.now();
    });
    api.on.vcamStatus?.(({ serial: s, stats, running, video }) => { if (s !== serial || video === false) return; vstats = running ? stats : null; renderHud(); renderHead(); });
    bus.on('sessions', () => { if (state.view !== 'camera') return; renderHead(); renderStage(); renderHud(); if (session()) startWatch(); });
    bus.on('selected', () => { if (state.view === 'camera') load(); });
    bus.on('camera-start', async (target) => {
      for (let i = 0; i < 40 && (!caps || !serial); i++) await new Promise(r => setTimeout(r, 250));
      if (!serial || session()) return;
      if (target && cfg.output.target !== target) setOutput(target === 'vcam' && cfg.output.audio === 'none' ? { target, audio: 'mic' } : { target });
      start(false);
    });
    bus.on('devices', () => { if (state.view === 'camera' && !serial) load(); });
    window.addEventListener('resize', () => { if (state.view === 'camera') renderStage(); });
  },
  show() { load(); },
  hide() { stopWatch(); },
};
