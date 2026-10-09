// Phone Link: one small window to use the phone as webcam, microphone and
// speakers, each switched on only when needed.
import { h, icon, replace, clear } from './lib/dom.js';

const api = window.api;

// ------------------------------------------------------------------ constants
const ISO_STOPS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400];
const SHUTTER = [1 / 8000, 1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 200, 1 / 125, 1 / 100, 1 / 60, 1 / 50, 1 / 30, 1 / 25, 1 / 15, 1 / 10, 1 / 8];
const CONF_DEFAULT = { ae: 'auto', iso: 200, exposure: 16666667, ev: 0, af: 'continuous', focus: 0, awb: 'auto', kelvin: 5200, tint: 0, zoom: 1, meter: 'matrix',
  antibanding: 'auto', ois: 1, eis: 'off', nr: 'fast', edge: 'fast', effect: 'off', scene: 'off', contrast: 0, saturation: 0, torch: 0, aelock: 0, awblock: 0 };
const WB = [['auto', 'wand-sparkles', 'Auto'], ['daylight', 'sun', 'Sun'], ['cloudy', 'cloud', 'Cloud'], ['incandescent', 'lightbulb', 'Warm'], ['fluorescent', 'lamp', 'Office'], ['manual', 'thermometer', 'Kelvin']];
const MIC_MODES = [['mic', 'mic', 'Natural'], ['voice-communication', 'audio-lines', 'Voice'], ['mic-unprocessed', 'audio-waveform', 'Raw']];

const fmtShutter = (ns) => { if (!ns) return '—'; const s = ns / 1e9; return s >= 0.3 ? `${s.toFixed(1)}"` : `1/${Math.round(1 / s)}`; };
const fmtFocus = (d) => (d == null ? '—' : d <= 0.05 ? '∞' : 1 / d >= 1 ? `${(1 / d).toFixed(1)}m` : `${Math.round(100 / d)}cm`);
const short = (name) => String(name || '').replace(/\s*\(.*\)\s*$/, '') || name;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------------------------------------------------------------ state
const S = {
  devices: [], serial: null, config: null,
  info: null, settings: null,
  run: { cam: null, mic: null, spk: null },
  busy: { cam: false, mic: false, spk: false },
  err: { cam: null, mic: null, spk: null },
  level: { mic: 0, spk: 0 },
  tab: 'cam',
  caps: null, capsFor: null, conf: { ...CONF_DEFAULT }, lens: null,
  status: null, frameAt: 0, watching: false, trigger: 0, focusPoint: null,
  volume: null, pinned: false, proOpen: false, shortcut: false,
};
const els = {};

// ------------------------------------------------------------------ helpers
function toast(msg, kind = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = h('div.toast.' + kind, icon(kind === 'err' ? 'circle-alert' : 'circle-check'), msg);
  document.body.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3000);
}

function showMenu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = h('div.menu', items.map(it => h(`button${it.on ? '.on' : ''}`, { onclick: () => { m.remove(); it.click(); } }, icon(it.icon || 'circle'), it.label)));
  m.style.left = Math.min(r.left, innerWidth - 240) + 'px';
  m.style.top = r.bottom + 6 + 'px';
  document.body.append(m);
  setTimeout(() => addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener('pointerdown', off); } }), 0);
}

function range({ min, max, step = 1, value, color = 'var(--cam)', disabled, oninput, onchange }) {
  const el = h('input', { type: 'range', min, max, step, value, disabled });
  const paint = () => el.style.setProperty('--p', `${((el.value - min) / (max - min || 1)) * 100}%`);
  el.style.setProperty('--c', color);
  paint();
  el.addEventListener('input', () => { paint(); oninput?.(+el.value); });
  if (onchange) el.addEventListener('change', () => onchange(+el.value));
  return el;
}

function seg(options, value, onpick) {
  return h('div.seg', options.map(([v, label, ic]) => h(`button${v === value ? '.on' : ''}`, { onclick: () => onpick(v) }, ic ? icon(ic) : null, label)));
}

function switchRow(text, on, color, onchange) {
  const t = h(`span.toggle${on ? '.on' : ''}`, { style: { '--c': color } });
  return h('div.swrow', { onclick: () => onchange(!on) }, h('span.t', text), t);
}

const device = () => S.devices.find(d => d.serial === S.serial) || null;
const deviceName = (d) => (d ? S.config?.deviceAliases?.[d.serial] || d.deviceName || d.marketName || d.model || d.serial : '');

// ------------------------------------------------------------------ camera settings (shared with Camera Studio)
function lensCaps() { return S.caps?.find(c => c.id === S.lens) || S.caps?.find(c => c.facing === 'back') || S.caps?.[0] || null; }
function can() {
  const c = lensCaps() || {};
  const list = c.capabilities || [];
  return {
    manual: list.includes(1),
    focus: (c.minFocus || 0) > 0 && list.includes(1),
    wb: list.includes(2) && c.manualWb,
    flash: !!c.flash,
    zoom: c.zoom || [1, 1],
    ev: c.evRange || [0, 0],
    evStep: c.evStep || 0.1,
    iso: c.iso || [50, 3200],
    exposure: c.exposure || [1e5, 1e9 / 8],
    minFocus: c.minFocus || 0,
    eis: (c.eis || []).includes(1),
    fps: [...new Set((c.fpsRanges || [[30, 30]]).map(r => r[1]))].filter(f => f >= 15).sort((a, b) => a - b),
  };
}

const persistCamera = debounce(async () => {
  if (!S.serial) return;
  const cfg = await api.store.get();
  const all = cfg.cameraStudio || {};
  const cur = all[S.serial] || {};
  S.config = await api.store.set({ cameraStudio: { ...all, [S.serial]: { ...cur, lens: S.lens, conf: S.conf } } });
}, 500);

function confPayload() {
  const c = S.conf;
  const conf = { ...c, live: S.watching ? 1 : 0, preview: S.watching ? 1 : 0, fpsmax: S.settings?.cam.fps || 30, aftrigger: S.trigger };
  if (S.focusPoint) { conf.fx = S.focusPoint.x.toFixed(3); conf.fy = S.focusPoint.y.toFixed(3); }
  return conf;
}
let confTimer = null;
function sendConf() {
  if (confTimer || !S.serial) return;
  confTimer = setTimeout(() => { confTimer = null; api.camera.conf(S.serial, confPayload()); }, 35);
}
function setConf(patch, rerender = true) {
  Object.assign(S.conf, patch);
  persistCamera();
  sendConf();
  if (rerender) renderPanel();
}

function syncWatch() {
  const want = !!(S.run.cam && S.serial && !document.hidden && S.settings?.cam.preview !== false);
  if (want === S.watching) return;
  S.watching = want;
  api.camera.watch(want ? S.serial : null, { preview: true });
  sendConf();
  if (!want) { S.status = null; }
}

// ------------------------------------------------------------------ data loading
async function loadDevices() {
  const r = await api.adb.devices();
  setDevices(r.devices || []);
}

function setDevices(list) {
  S.devices = list.filter(d => d.state === 'device');
  const saved = S.settings?.serial;
  if (!S.devices.find(d => d.serial === S.serial)) {
    const next = S.devices.find(d => d.serial === saved) || S.devices[0] || null;
    selectDevice(next?.serial || null, false);
  }
  renderTop();
  renderAll();
}

async function selectDevice(serial, save = true) {
  S.serial = serial;
  S.caps = null;
  S.status = null;
  S.run = { cam: null, mic: null, spk: null };
  const cs = S.config?.cameraStudio?.[serial] || {};
  S.conf = { ...CONF_DEFAULT, ...(cs.conf || {}) };
  S.lens = cs.lens ?? null;
  if (save && serial) S.settings = await api.link.settings({ serial });
  if (!serial) return;
  const running = await api.link.running();
  const mine = running[serial] || {};
  for (const k of ['cam', 'mic', 'spk']) S.run[k] = mine[k] ? { stats: mine[k].stats || null } : null;
  loadCaps();
  loadVolume();
  syncWatch();
  renderAll();
}

async function loadCaps() {
  const serial = S.serial;
  if (!serial || S.capsFor === serial && S.caps) return;
  const r = await api.camera.caps(serial);
  if (serial !== S.serial) return;
  if (r.ok) {
    S.caps = r.cameras;
    S.capsFor = serial;
    if (S.lens == null || !S.caps.find(c => c.id === S.lens)) S.lens = (S.caps.find(c => c.facing === 'back') || S.caps[0])?.id ?? null;
    renderStage();
    renderPanel();
  }
}

async function loadInfo() {
  S.info = await api.link.info();
  S.settings = S.info.settings;
  renderTiles();
  renderPanel();
}

async function loadVolume() {
  if (!S.serial) return;
  const v = await api.link.volume(S.serial);
  if (v?.ok) { S.volume = v; if (S.tab === 'spk') renderPanel(); }
}

const saveSettings = async (patch) => { S.settings = await api.link.settings(patch); };

// ------------------------------------------------------------------ actions
async function toggle(kind) {
  if (!S.serial || S.busy[kind]) return;
  S.tab = kind;
  if (S.run[kind]) {
    S.busy[kind] = true;
    renderTiles();
    await api.link.stop(S.serial, kind);
    S.run[kind] = null;
    S.busy[kind] = false;
    if (kind === 'cam') syncWatch();
    renderAll();
    return;
  }
  S.err[kind] = null;
  if (kind === 'cam' && !S.info?.camera.installed) { renderAll(); return; } // the panel shows the install card
  if (kind === 'mic' && !S.info?.routes.mic) { renderAll(); return; }       // the panel shows the setup card
  await start(kind);
}

async function start(kind) {
  S.busy[kind] = true;
  renderAll();
  if (kind === 'cam') api.camera.conf(S.serial, confPayload());
  const opts = kind === 'cam' ? { cameraId: lensCaps()?.id ?? 0 } : {};
  const r = await api.link.start(S.serial, kind, opts);
  S.busy[kind] = false;
  if (!r?.ok) {
    S.err[kind] = r?.error || 'Could not start';
    toast(S.err[kind], 'err');
  } else {
    S.run[kind] = S.run[kind] || { stats: null };
    if (kind === 'cam') syncWatch();
  }
  renderAll();
}

// Restart a running channel after a setting that needs a new stream changed.
const restart = debounce(async (kind) => {
  if (!S.run[kind] || !S.serial) return;
  S.busy[kind] = true;
  renderTiles();
  await api.link.stop(S.serial, kind);
  S.run[kind] = null;
  await start(kind);
}, 500);

async function installCamera() {
  toast('Approve the Windows prompt to add the webcam device…');
  const r = await api.vcam.install();
  if (r.ok) { toast('Webcam device installed'); await loadInfo(); start('cam'); }
  else toast(r.error || 'Installation failed', 'err');
}

// ------------------------------------------------------------------ render: title bar
function renderTop() {
  const d = device();
  const batt = d?.battery?.level;
  replace(els.top,
    h('img.lk-logo', { src: 'link-icon.png', alt: '' }),
    h('button.lk-device', {
      onclick: (e) => {
        if (S.devices.length < 2) return;
        showMenu(e.currentTarget, S.devices.map(x => ({ label: deviceName(x), icon: x.serial === S.serial ? 'circle-check' : 'smartphone', on: x.serial === S.serial, click: () => selectDevice(x.serial) })));
      },
    },
    h('b', d ? deviceName(d) : 'Phone Link', S.devices.length > 1 ? icon('chevron-down') : null),
    h('span', h(`i.dot${d ? '' : '.off'}`), d ? [icon(d.type === 'wifi' || /:\d+$/.test(d.serial) ? 'wifi' : 'usb'), d.type === 'wifi' || /:\d+$/.test(d.serial) ? 'Wi-Fi' : 'USB',
      batt != null ? [' · ', icon(d.battery?.charging ? 'battery-charging' : 'battery-medium'), `${batt}%`] : null] : 'No phone connected')),
    h('div.lk-spacer'),
    h(`button.lk-win${S.pinned ? '.on' : ''}`, { title: S.pinned ? 'Unpin' : 'Keep on top', onclick: async () => { S.pinned = await api.link.window('pin'); renderTop(); } }, icon(S.pinned ? 'pin' : 'pin-off')),
    h('button.lk-win', { title: 'Minimize', onclick: () => api.link.window('minimize') }, icon('minus')),
    h('button.lk-win.close', { title: 'Close', onclick: () => api.link.window('close') }, icon('x')));
}

// ------------------------------------------------------------------ render: stage
function lensLabel(c) {
  if (c.facing === 'front') return icon('switch-camera');
  const backs = (S.caps || []).filter(x => x.facing === 'back');
  const main = backs.find(x => x.id === '0') || backs[0];
  const ratio = main?.focal35 && c.focal35 ? c.focal35 / main.focal35 : 1;
  return ratio < 0.8 ? `${(Math.round(ratio * 10) / 10).toString().replace(/^0/, '')}` : `${Math.round(ratio)}×`;
}

function renderStage() {
  const st = els.stage;
  const cam = S.run.cam;
  const cfg = S.settings?.cam || {};
  st.classList.toggle('cover', cfg.fit === 'cover');
  st.classList.toggle('mirror', !!cfg.mirror);
  clear(st);
  if (!S.serial) {
    st.append(h('div.off', h('div', h('div.big', icon('smartphone')), h('b', 'Connect your phone'), h('small', 'USB debugging on, or pair over Wi-Fi in Scrcpy Studio'))));
    return;
  }
  els.feed = h('img.feed', { alt: '', style: { opacity: 0 } });
  st.append(els.feed);
  if (!cam) {
    st.append(h('div.off', h('div',
      S.busy.cam ? h('div.spin') : h('button.big', { onclick: () => toggle('cam'), title: 'Turn the webcam on' }, icon('video-off')),
      h('b', S.busy.cam ? 'Starting camera…' : 'Webcam off'),
      h('small', S.busy.cam ? 'Opening the phone camera' : 'The phone camera is idle'))));
  } else if (!S.watching || !S.frameAt) {
    st.append(h('div.off', { style: { background: 'transparent' } }, h('div', h('div.spin'), h('small', S.watching ? 'Waiting for the preview…' : 'Preview paused'))));
  }
  const stats = cam?.stats;
  els.chips = h('div.lk-chips',
    cam ? h('span.lk-chip.live', 'LIVE') : null,
    stats?.width ? h('span.lk-chip', `${stats.height >= 1080 ? '1080p' : stats.height >= 720 ? '720p' : `${stats.height}p`} · ${stats.fps || 0} fps`) : null,
    stats?.cameraInUse ? h('span.lk-chip.used', icon('webcam'), 'In use') : null,
    stats?.ndi ? h('span.lk-chip', icon('radio'), `NDI${stats.ndiClients ? ` · ${stats.ndiClients}` : ''}`) : null,
    cam && S.status?.iso ? h('span.lk-chip', `ISO ${S.status.iso} · ${fmtShutter(S.status.exposure)}`) : null);
  st.append(els.chips);
  if (S.caps?.length > 1) {
    // one button per back lens + the (first) front camera; logical duplicates are skipped
    const backs = [];
    for (const c of S.caps.filter(x => x.facing === 'back').sort((a, b) => (a.focal35 || 0) - (b.focal35 || 0))) if (!backs.some(b => b.focal35 && b.focal35 === c.focal35)) backs.push(c);
    const sorted = [...backs, ...S.caps.filter(c => c.facing === 'front').slice(0, 1)];
    st.append(h('div.lk-lenses', sorted.map(c => h(`button.lk-lens${c.id === lensCaps()?.id ? '.on' : ''}`, {
      title: [c.facing === 'front' ? 'Front camera' : null, c.focal35 ? `${c.focal35}mm` : null].filter(Boolean).join(' · '),
      onclick: (e) => { e.stopPropagation(); if (c.id === S.lens) return; S.lens = c.id; persistCamera(); renderStage(); renderPanel(); restart('cam'); },
    }, lensLabel(c)))));
  }
}

// tap to focus
function onStageClick(e) {
  if (!S.run.cam || e.target.closest('button')) return;
  const r = els.stage.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (S.settings?.cam.mirror) x = 1 - x;
  S.focusPoint = { x, y };
  S.trigger++;
  if (S.conf.af === 'manual') S.conf.af = 'continuous';
  setConf({});
  const ring = h('div.lk-focus-ring', { style: { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px` } });
  els.stage.append(ring);
  setTimeout(() => ring.remove(), 950);
}

// ------------------------------------------------------------------ render: toggles
function tileSub(kind) {
  const i = S.info;
  if (!S.serial) return '—';
  if (S.err[kind]) return S.err[kind];
  if (S.busy[kind]) return S.run[kind] ? 'Stopping…' : 'Starting…';
  if (kind === 'cam') {
    const st = S.run.cam?.stats;
    if (S.run.cam) return st?.cameraInUse ? 'In use by an app' : st?.width ? `${st.height}p · ${st.fps} fps` : 'Live';
    if (!i?.camera.installed) return 'Set up';
    return `${(S.settings?.cam.size || '1920x1080').split('x')[1]}p · Off`;
  }
  const r = i?.routes?.[kind];
  if (kind === 'mic') {
    if (!r) return 'Set up';
    const where = r.kind === 'cable' ? short(r.cable.micName) : r.kind === 'ndi' ? 'NDI' : `on ${short(r.device.name)}`;
    return S.run.mic ? `→ ${where}` : where;
  }
  if (!r) return 'No output';
  return r.kind === 'cable' ? (S.run.spk ? 'Stereo · PC sound' : 'Phone output') : `Mirror ${short(r.device.name)}`;
}

function renderTiles() {
  const defs = [['cam', 'Webcam', S.run.cam ? 'webcam' : 'video-off'], ['mic', 'Mic', S.run.mic ? 'mic' : 'mic-off'], ['spk', 'Speakers', S.run.spk ? 'volume-2' : 'volume-x']];
  replace(els.toggles, defs.map(([k, label, ic]) => {
    const warn = !S.err[k] && !S.run[k] && ((k === 'cam' && S.info && !S.info.camera.installed) || (k === 'mic' && S.info && !S.info.routes.mic));
    return h(`button.lk-tog${S.run[k] ? '.on' : ''}${S.busy[k] ? '.busy' : ''}${S.err[k] ? '.err' : ''}${warn ? '.warn' : ''}${S.tab === k ? '.sel' : ''}`,
      { dataset: { k }, disabled: !S.serial, onclick: () => toggle(k), oncontextmenu: (e) => { e.preventDefault(); S.tab = k; renderTiles(); renderPanel(); } },
      h('span.sw'),
      h('span.ic', icon(ic)),
      h('div', h('b', label), h('small', { title: tileSub(k) }, tileSub(k))),
      k === 'cam' ? h('div.meter', h('i', { style: { width: S.run.cam ? '100%' : '0', opacity: .5 } })) : h('div.meter', h('i', { ref: (el) => { els['meter_' + k] = el; } })));
  }));
  document.querySelector('.lk-bg').className = 'lk-bg ' + ['cam', 'mic', 'spk'].filter(k => S.run[k]).join(' ');
}

// ------------------------------------------------------------------ render: panel
function renderPanel() {
  const p = els.panel;
  clear(p);
  if (!S.serial) {
    p.append(h('div.lk-empty', h('div.big', icon('cable')), h('b', 'Waiting for your phone'), h('div.muted', 'Plug it in with USB debugging enabled. It is picked up automatically.')));
    return;
  }
  p.append(seg([['cam', 'Camera', 'camera'], ['mic', 'Mic', 'mic'], ['spk', 'Speakers', 'speaker']], S.tab, (t) => { S.tab = t; renderTiles(); renderPanel(); if (t === 'spk') loadVolume(); }));
  if (S.tab === 'cam') camPanel(p);
  else if (S.tab === 'mic') micPanel(p);
  else spkPanel(p);
}

function camPanel(p) {
  const c = can();
  const cfg = S.settings?.cam || {};
  if (S.info && !S.info.camera.installed) {
    p.append(h('div.help', { style: { '--c': 'var(--cam)' } }, icon('webcam'),
      h('div', h('b', 'Add the “Scrcpy Studio Camera” device'),
        h('p', 'One-time setup so Discord, Zoom, Teams, OBS, vMix and browsers can pick your phone as a webcam. Windows asks for administrator permission.'),
        h('div.btns', h('button.btn.pri', { onclick: installCamera }, icon('download'), 'Install webcam')))));
  }
  const step = c.evStep;
  // zoom
  const zMax = Math.min(8, c.zoom[1] || 1);
  if (zMax > 1) {
    const zv = h('span.val', `${(+S.conf.zoom).toFixed(1)}×`);
    p.append(h('div.row', h('span.lbl', icon('zoom-in')), range({ min: 1, max: zMax, step: 0.1, value: S.conf.zoom, oninput: (v) => { zv.textContent = `${v.toFixed(1)}×`; setConf({ zoom: v }, false); } }), zv));
  }
  // exposure compensation (ignored in manual exposure)
  const ev = h('span.val', `${S.conf.ev > 0 ? '+' : ''}${(S.conf.ev * step).toFixed(1)}`);
  p.append(h('div.row', h('span.lbl', icon('sun')), range({ min: c.ev[0], max: c.ev[1], step: 1, value: S.conf.ev, disabled: S.conf.ae === 'manual',
    oninput: (v) => { ev.textContent = `${v > 0 ? '+' : ''}${(v * step).toFixed(1)}`; setConf({ ev: v }, false); } }), ev));

  // focus
  if (c.focus) {
    const fv = h('span.val', S.conf.af === 'manual' ? fmtFocus(S.conf.focus) : 'Auto');
    p.append(h('div.row', h('span.lbl', icon('focus')),
      seg([['continuous', 'Auto'], ['manual', 'Manual']], S.conf.af === 'manual' ? 'manual' : 'continuous', (v) => setConf({ af: v, ...(v === 'manual' && S.status?.focus != null ? { focus: +S.status.focus.toFixed(2) } : {}) }))));
    if (S.conf.af === 'manual') {
      p.append(h('div.row', h('span.lbl', icon('mountain')), range({ min: 0, max: c.minFocus, step: 0.05, value: S.conf.focus, oninput: (v) => { fv.textContent = fmtFocus(v); setConf({ focus: v }, false); } }), fv));
    }
  }

  // white balance
  p.append(h('div.chips', WB.filter(([v]) => v !== 'manual' || c.wb).map(([v, ic, label]) =>
    h(`button.chip${S.conf.awb === v ? '.on' : ''}`, { title: label, onclick: () => setConf({ awb: v }) }, icon(ic), S.conf.awb === v ? label : null))));
  if (S.conf.awb === 'manual' && c.wb) {
    const kv = h('span.val', `${S.conf.kelvin}K`);
    const r = range({ min: 2300, max: 9000, step: 50, value: S.conf.kelvin, color: 'linear-gradient(90deg,#ff9a3c,#fff2d6,#8fc4ff)', oninput: (v) => { kv.textContent = `${v}K`; setConf({ kelvin: v }, false); } });
    r.style.setProperty('--c', '#ffcf85');
    p.append(h('div.row', h('span.lbl', icon('thermometer')), r, kv));
  }

  // quick toggles
  const tile = (on, ic, label, onclick) => h(`button.tile${on ? '.on' : ''}`, { onclick }, icon(ic), label);
  p.append(h('div.tiles',
    c.flash ? tile(+S.conf.torch === 1, +S.conf.torch === 1 ? 'flashlight' : 'flashlight-off', 'Light', () => setConf({ torch: +S.conf.torch === 1 ? 0 : 1 })) : null,
    tile(!!cfg.mirror, 'arrow-right-left', 'Mirror', async () => { await saveSettings({ cam: { mirror: !cfg.mirror } }); renderStage(); renderPanel(); restart('cam'); }),
    tile(cfg.fit === 'cover', cfg.fit === 'cover' ? 'maximize' : 'minimize', cfg.fit === 'cover' ? 'Fill' : 'Fit', async () => { await saveSettings({ cam: { fit: cfg.fit === 'cover' ? 'contain' : 'cover' } }); renderStage(); renderPanel(); restart('cam'); }),
    c.eis ? tile(S.conf.eis === 'on', 'hand', 'Steady', () => setConf({ eis: S.conf.eis === 'on' ? 'off' : 'on' })) : tile(!!cfg.ndi, 'radio', 'NDI', async () => { await saveSettings({ cam: { ndi: !cfg.ndi } }); renderPanel(); restart('cam'); })));

  // quality
  const fpsList = c.fps.length ? c.fps : [30];
  p.append(h('div.row', seg([['1280x720', '720p'], ['1920x1080', '1080p']], cfg.size, async (v) => { await saveSettings({ cam: { size: v } }); renderPanel(); renderTiles(); restart('cam'); }),
    seg(fpsList.slice(-3).map(f => [f, `${f}`]), +cfg.fps, async (v) => { await saveSettings({ cam: { fps: v } }); renderPanel(); restart('cam'); })));

  // pro
  const proBtn = h(`button.fold${S.proOpen ? '.open' : ''}`, { onclick: () => { S.proOpen = !S.proOpen; renderPanel(); } }, icon('sliders-horizontal'), 'Pro', h('span.lk-spacer'), icon('chevron-down', 'chev'));
  p.append(proBtn);
  if (S.proOpen) {
    const st = S.status || {};
    const sub = h('div.sub');
    sub.append(h('div.readouts',
      h('div', h('small', 'ISO'), h('b', st.iso ?? '—')),
      h('div', h('small', 'SHUTTER'), h('b', fmtShutter(st.exposure))),
      h('div', h('small', 'FOCUS'), h('b', fmtFocus(st.focus))),
      h('div', h('small', 'WB'), h('b', st.kelvin ? `${Math.round(st.kelvin / 50) * 50}K` : '—'))));
    if (c.manual) {
      const manual = S.conf.ae === 'manual';
      sub.append(switchRow('Manual exposure (ISO + shutter)', manual, 'var(--cam)', (v) => setConf({ ae: v ? 'manual' : 'auto', ...(v && st.iso ? { iso: st.iso, exposure: st.exposure } : {}) })));
      if (manual) {
        const isos = ISO_STOPS.filter(x => x >= c.iso[0] && x <= c.iso[1]);
        const ii = Math.max(0, isos.findIndex(x => x >= S.conf.iso));
        const iv = h('span.val', `${isos[ii]}`);
        sub.append(h('div.row', h('span.lbl', h('b', { style: { fontSize: '10px' } }, 'ISO')), range({ min: 0, max: isos.length - 1, value: ii, oninput: (i) => { iv.textContent = isos[i]; setConf({ iso: isos[i] }, false); } }), iv));
        const maxExp = Math.min(c.exposure[1], 1e9 / Math.max(1, S.settings?.cam.fps || 30));
        const shs = SHUTTER.filter(s => s * 1e9 >= c.exposure[0] && s * 1e9 <= maxExp + 1);
        const si = Math.max(0, shs.findIndex(s => s * 1e9 >= S.conf.exposure - 1));
        const sv = h('span.val', fmtShutter(shs[si] * 1e9));
        sub.append(h('div.row', h('span.lbl', icon('timer')), range({ min: 0, max: shs.length - 1, value: si, oninput: (i) => { sv.textContent = fmtShutter(shs[i] * 1e9); setConf({ exposure: Math.round(shs[i] * 1e9) }, false); } }), sv));
      }
    }
    sub.append(h('div.row', h('span.lbl', icon('zap')), seg([['auto', 'Auto'], ['50', '50 Hz'], ['60', '60 Hz']], S.conf.antibanding, (v) => setConf({ antibanding: v }))));
    sub.append(switchRow('Live preview here', cfg.preview !== false, 'var(--cam)', async (v) => { await saveSettings({ cam: { preview: v } }); syncWatch(); renderStage(); renderPanel(); }));
    sub.append(h('div.btns', h('button.btn', { onclick: () => api.app.focus() }, icon('aperture'), 'All controls in Camera Studio'),
      h('button.btn', { onclick: () => setConf({ ...CONF_DEFAULT }) }, icon('rotate-ccw'), 'Reset')));
    p.append(sub);
  }
}

function micPanel(p) {
  const i = S.info;
  const r = i?.routes?.mic;
  const st = S.settings?.mic || {};
  p.append(h('div.vu', { ref: (el) => { els.vu_mic = el; } }, Array.from({ length: 28 }, () => h('i')), ));
  els.vu_mic.style.setProperty('--c', 'var(--mic)');
  p.append(h('h3', icon('mic'), 'Sound'));
  p.append(seg(MIC_MODES.map(([v, ic, label]) => [v, label, ic]), st.source || 'mic', async (v) => { await saveSettings({ mic: { source: v } }); renderPanel(); restart('mic'); }));
  p.append(h('div.muted', { style: { marginTop: '-6px' } }, { 'mic': 'Balanced, like a phone call recording.', 'voice-communication': 'Noise and echo reduction — best for calls.', 'mic-unprocessed': 'No processing — for streaming with your own filters.' }[st.source || 'mic']));

  p.append(h('h3', icon('arrow-right'), 'Windows gets it as', h('span.r', r?.auto ? h('span.tag', 'auto') : null)));
  const rows = [];
  const pick = async (route) => { await saveSettings({ mic: { route } }); await loadInfo(); restart('mic'); };
  for (const cbl of i?.cables || []) {
    const on = r?.kind === 'cable' && r.cable.id === cbl.id;
    const busy = i.routes.spk?.kind === 'cable' && i.routes.spk.cable.id === cbl.id && !on;
    rows.push(h(`button.route${on ? '.on' : ''}`, { style: { '--c': 'var(--mic)' }, onclick: () => pick(`cable:${cbl.id}`) },
      h('span.ri', icon('mic')), h('span.rt', h('b', short(cbl.micName), h('span.tag', 'microphone')), h('small', busy ? `${cbl.label} · also used by the speakers` : `Pick “${cbl.micName}” in your app`)), h('span.rk')));
  }
  if (i?.ndi) {
    const on = r?.kind === 'ndi';
    rows.push(h(`button.route${on ? '.on' : ''}`, { style: { '--c': 'var(--mic)' }, onclick: () => pick('ndi') },
      h('span.ri', icon('radio')), h('span.rt', h('b', 'NDI audio source'), h('small', 'vMix / OBS, or NDI Webcam → “NDI Webcam Audio” mic')), h('span.rk')));
  }
  for (const o of (i?.outputs || []).filter(x => !x.virtual)) {
    const on = r?.kind === 'monitor' && r.device.id === o.id;
    rows.push(h(`button.route${on ? '.on' : ''}`, { style: { '--c': 'var(--mic)' }, onclick: () => pick(`out:${o.id}`) },
      h('span.ri', icon('headphones')), h('span.rt', h('b', `Listen on ${short(o.name)}`), h('small', 'Hear the phone mic on this PC')), h('span.rk')));
  }
  p.append(h('div.routes', rows));
  if (!i?.cables?.length) {
    p.append(h('div.help', { style: { '--c': 'var(--mic)' } }, icon('cable'),
      h('div', h('b', 'Want it as a regular Windows microphone?'),
        h('p', 'Windows only lists microphones that have a driver. Install the free VB-CABLE driver once: Phone Link finds it and sends the phone mic to “CABLE Output”, which Discord, Teams, Zoom and the rest can pick.'),
        h('div.btns', h('button.btn.pri', { onclick: () => api.shell.openExternal('https://vb-audio.com/Cable/') }, icon('external-link'), 'Get VB-CABLE (free)'),
          h('button.btn', { onclick: async () => { await loadInfo(); toast(S.info.cables.length ? 'Virtual cable found' : 'No virtual cable found yet', S.info.cables.length ? 'ok' : 'err'); } }, icon('refresh-cw'), 'Check again')))));
  }
}

function spkPanel(p) {
  const i = S.info;
  const r = i?.routes?.spk;
  const st = S.settings?.spk || {};
  p.append(h('div.vu', { ref: (el) => { els.vu_spk = el; } }, Array.from({ length: 28 }, () => h('i'))));
  els.vu_spk.style.setProperty('--c', 'var(--spk)');

  // phone volume
  if (S.volume) {
    const vv = h('span.val', `${Math.round((S.volume.value / S.volume.max) * 100)}%`);
    const set = debounce((v) => api.link.volume(S.serial, v), 120);
    p.append(h('div.row', h('span.lbl', icon(S.volume.value ? 'volume-2' : 'volume-x')),
      range({ min: S.volume.min, max: S.volume.max, value: S.volume.value, color: 'var(--spk)', oninput: (v) => { S.volume.value = v; vv.textContent = `${Math.round((v / S.volume.max) * 100)}%`; set(v); } }), vv));
  }

  p.append(h('h3', icon('monitor'), 'Plays from Windows', h('span.r', r?.auto ? h('span.tag', 'auto') : null)));
  const rows = [];
  const pick = async (route) => { await saveSettings({ spk: { route } }); await loadInfo(); restart('spk'); };
  for (const cbl of i?.cables || []) {
    const on = r?.kind === 'cable' && r.cable.id === cbl.id;
    const busy = i.routes.mic?.kind === 'cable' && i.routes.mic.cable.id === cbl.id && !on;
    rows.push(h(`button.route${on ? '.on' : ''}`, { style: { '--c': 'var(--spk)' }, onclick: () => pick(`cable:${cbl.id}`) },
      h('span.ri', icon('speaker')), h('span.rt', h('b', short(cbl.outputName), h('span.tag', 'output')), h('small', busy ? 'Also used by the mic — pick another cable' : 'Only the phone plays · choose it as a Windows output')), h('span.rk')));
  }
  const outs = (i?.outputs || []).filter(x => !x.virtual);
  for (const o of outs) {
    const on = r?.kind === 'loop' && r.device.id === o.id;
    rows.push(h(`button.route${on ? '.on' : ''}`, { style: { '--c': 'var(--spk)' }, onclick: () => pick(o.default ? 'loop:default' : `loop:${o.id}`) },
      h('span.ri', icon('volume-2')), h('span.rt', h('b', `Mirror ${short(o.name)}`, o.default ? h('span.tag', 'default') : null), h('small', 'Plays on the phone and here at the same time')), h('span.rk')));
  }
  p.append(h('div.routes', rows));
  if (r?.kind === 'cable') {
    p.append(switchRow('Make it the Windows output while on', st.switchDefault !== false, 'var(--spk)', async (v) => { await saveSettings({ spk: { switchDefault: v } }); renderPanel(); }));
  }
  p.append(h('div.muted', icon('audio-lines', '', 12), ' Stereo, 48 kHz. Your phone mixes it with its own sounds.'));
  if ((i?.cables?.length || 0) < 2) {
    p.append(h('div.help', { style: { '--c': 'var(--spk)' } }, icon('speaker'),
      h('div', h('b', i?.cables?.length ? 'A separate “phone speakers” output' : 'Phone as a real Windows output'),
        h('p', i?.cables?.length
          ? 'Your virtual cable is used by the mic. Add a second one (VB-CABLE A+B, or Hi-Fi Cable) and Phone Link uses it as the speakers output, so only the phone plays.'
          : 'Install a virtual cable (VB-CABLE) and Phone Link turns it into a speakers output: pick it in Windows and only the phone plays. Until then the phone mirrors what this PC plays.'),
        h('div.btns', h('button.btn.pri', { onclick: () => api.shell.openExternal('https://vb-audio.com/Cable/') }, icon('external-link'), 'VB-Audio cables'),
          h('button.btn', { onclick: async () => { await loadInfo(); toast(`${S.info.cables.length} virtual cable${S.info.cables.length === 1 ? '' : 's'} found`); } }, icon('refresh-cw'), 'Check again')))));
  }
}

function renderAll() { renderStage(); renderTiles(); renderPanel(); }

// ------------------------------------------------------------------ app update banner
function renderUpdate(u) {
  if (!els.update) return;
  const show = u && ['available', 'downloading', 'ready'].includes(u.status);
  els.update.hidden = !show;
  if (!show) return;
  const pct = Math.round((u.progress || 0) * 100);
  replace(els.update,
    icon(u.status === 'ready' ? 'circle-check' : 'download-cloud'),
    h('span.t', u.status === 'ready' ? `v${u.latest.version} is ready` : u.status === 'downloading' ? `Downloading v${u.latest.version}… ${pct}%` : `Update v${u.latest.version} available`),
    u.status === 'available' ? [
      h('button.btn', { onclick: () => (u.mode === 'manual' ? api.shell.openExternal(u.latest.url) : api.update.download()) }, u.mode === 'manual' ? 'Download' : 'Update'),
      h('button.lk-win', { title: 'Skip this version', onclick: () => api.update.skip() }, icon('x')),
    ] : u.status === 'ready' ? h('button.btn', { onclick: () => api.update.install() }, 'Restart') : null);
}

// ------------------------------------------------------------------ live updates
function setLevel(kind, v) {
  S.level[kind] = v;
  const m = els['meter_' + kind];
  if (m) m.style.width = `${Math.min(100, Math.sqrt(v) * 120)}%`;
  const vu = els['vu_' + kind];
  if (vu && vu.isConnected) {
    const bars = vu.children;
    const lit = Math.round(Math.min(1, Math.sqrt(v) * 1.2) * bars.length);
    for (let b = 0; b < bars.length; b++) {
      const on = b < lit;
      bars[b].classList.toggle('lit', on);
      bars[b].style.height = on ? `${30 + 70 * Math.sin(Math.PI * (b + 1) / (bars.length + 1)) * (0.75 + Math.random() * 0.25)}%` : '20%';
    }
  }
}
// meters fall back to zero when no level arrives (the speaker bridge pauses on silence)
setInterval(() => { for (const k of ['mic', 'spk']) if (S.level[k] > 0.001) setLevel(k, S.level[k] * 0.6); }, 160);

function wire() {
  api.on.devices?.((p) => setDevices(p.devices || []));
  api.on.vcamStatus?.((p) => {
    const m = /^(.*)#(cam|mic)$/.exec(p.key || '');
    if (!m || m[1] !== S.serial) return;
    const k = m[2];
    if (p.running) S.run[k] = { stats: p.stats || S.run[k]?.stats || null };
    else {
      S.run[k] = null;
      if (k === 'cam') S.frameAt = 0;
      if (p.error && !S.busy[k]) { S.err[k] = p.error; toast(p.error, 'err'); }
      if (k === 'mic') setLevel('mic', 0);
    }
    if (k === 'cam') { syncWatch(); if (p.kind !== 'stats') renderStage(); else updateChips(); }
    renderTiles();
  });
  api.on.linkStatus?.((p) => {
    if (p.serial !== S.serial) return;
    if (p.running) S.run.spk = { stats: p.stats, sink: p.sink };
    else { S.run.spk = null; setLevel('spk', 0); if (p.error && !S.busy.spk) { S.err.spk = p.error; toast(p.error, 'err'); } }
    renderTiles();
  });
  api.on.vcamLevel?.((p) => { if (p.serial === S.serial && /#mic$/.test(p.key) && p.mic != null) setLevel('mic', p.mic); });
  api.on.linkLevel?.((p) => { if (p.serial === S.serial) setLevel('spk', p.level); });
  api.on.cameraPreview?.((p) => {
    if (p.serial !== S.serial || !S.run.cam || !els.feed) return;
    const first = !S.frameAt;
    S.frameAt = Date.now();
    els.feed.src = p.frame;
    els.feed.style.opacity = 1;
    if (first) renderStage();
  });
  api.on.cameraStatus?.((p) => {
    if (p.serial !== S.serial) return;
    S.status = p.status;
    updateChips();
    if (S.tab === 'cam' && S.proOpen && !document.querySelector('.lk-panel input:active')) refreshReadouts();
  });
  document.addEventListener('visibilitychange', () => { syncWatch(); if (!document.hidden) S.frameAt = 0; });
  addEventListener('focus', () => { if (S.serial) { loadInfo(); } });
  els.stage.addEventListener('click', onStageClick);
}

function updateChips() {
  if (!els.chips || !S.run.cam) return;
  const stats = S.run.cam.stats;
  replace(els.chips,
    h('span.lk-chip.live', 'LIVE'),
    stats?.width ? h('span.lk-chip', `${stats.height >= 1080 ? '1080p' : stats.height >= 720 ? '720p' : `${stats.height}p`} · ${stats.fps || 0} fps`) : null,
    stats?.cameraInUse ? h('span.lk-chip.used', icon('webcam'), 'In use') : null,
    stats?.ndi ? h('span.lk-chip', icon('radio'), `NDI${stats.ndiClients ? ` · ${stats.ndiClients}` : ''}`) : null,
    S.status?.iso ? h('span.lk-chip', `ISO ${S.status.iso} · ${fmtShutter(S.status.exposure)}`) : null);
}

function refreshReadouts() {
  const ro = document.querySelector('.readouts');
  if (!ro) return;
  const st = S.status || {};
  const vals = [st.iso ?? '—', fmtShutter(st.exposure), fmtFocus(st.focus), st.kelvin ? `${Math.round(st.kelvin / 50) * 50}K` : '—'];
  [...ro.querySelectorAll('b')].forEach((b, i) => { b.textContent = vals[i]; });
}

// ------------------------------------------------------------------ boot
async function boot() {
  S.config = await api.store.get();
  const theme = S.config.settings?.theme || 'dark';
  const dark = theme === 'system' ? await api.app.systemDark?.() : theme !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  const app = document.getElementById('app');
  document.body.prepend(h('div.lk-bg', h('i'), h('i'), h('i')));
  els.top = h('header.lk-top');
  els.stage = h('section.lk-stage');
  els.toggles = h('section.lk-toggles');
  els.panel = h('section.lk-panel');
  const shortcutBtn = h('button.btn', { onclick: async () => { const r = await api.link.shortcut(); toast(r.ok ? 'Shortcut “Phone Link” added to the desktop' : 'Could not create the shortcut', r.ok ? 'ok' : 'err'); } }, icon('pin'), 'Desktop shortcut');
  els.update = h('div.lk-update', { hidden: true });
  app.append(h('div.lk', els.top, h('div.lk-body', els.update, els.stage, els.toggles, els.panel,
    h('footer.lk-foot', h('button.btn', { onclick: () => api.app.focus() }, icon('app-window'), 'Scrcpy Studio'), shortcutBtn))));
  renderTop();
  renderAll();
  wire();

  S.settings = await api.link.settings();
  await loadDevices();
  loadInfo();
  if (api.update) { api.update.status().then(renderUpdate); api.on.updateStatus?.(renderUpdate); }
  api.link.shortcutExists?.().then((x) => { if (x) shortcutBtn.replaceChildren(icon('circle-check'), 'Shortcut on desktop'); });
}

boot();
