// App bootstrap: shell layout, routing, global events, shortcuts, palette.
import { h, icon, clear, replace } from './lib/dom.js';
import { toast, showMenu, initTooltips, modal } from './lib/ui.js';
import { api, state, bus, deviceName, readyDevices, selectDevice, selectedDevice, settings, sessionsFor } from './state.js';
import { launch, screenshot, navigate, installApks, pushFiles, deviceMenu, notify, deviceIconName } from './actions.js';
import { openPalette } from './palette.js';
import { initUpdates } from './updates.js';

import devicesView from './views/devices.js';
import cameraView from './views/camera.js';
import mirrorView from './views/mirror.js';
import sessionsView from './views/sessions.js';
import mediaView from './views/media.js';
import controlView from './views/control.js';
import appsView from './views/apps.js';
import filesView from './views/files.js';
import shellView from './views/shell.js';
import logcatView from './views/logcat.js';
import infoView from './views/info.js';
import settingsView from './views/settings.js';

const VIEWS = [devicesView, cameraView, mirrorView, sessionsView, mediaView, controlView, appsView, filesView, shellView, logcatView, infoView, settingsView];
const NAV = [
  { label: 'General', items: ['devices', 'camera', 'mirror', 'sessions', 'media'] },
  { label: 'Device', items: ['control', 'apps', 'files', 'shell', 'logcat', 'info'] },
];

const els = {};
const created = new Set();

// ------------------------------------------------------------------ theme
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
export function applyTheme() {
  const s = settings();
  const theme = s.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : s.theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty('--accent', s.accent || '#7c5cff');
  root.classList.toggle('reduce-motion', !!s.reduceMotion);
  api.app.setTitleBar({ color: theme === 'dark' ? '#0d0e15' : '#f3f4fa', symbolColor: theme === 'dark' ? '#c9cbe0' : '#3a3d52' });
}
darkQuery.addEventListener('change', () => settings().theme === 'system' && applyTheme());

// ------------------------------------------------------------------ layout
function buildShell() {
  const app = document.getElementById('app');
  els.nav = h('div.rail-group');
  els.tools = h('div.rail-group');
  els.toolStatus = h('div.rail-status');
  els.content = h('div.content');
  els.pill = h('button.device-pill', { onclick: (e) => devicePicker(e.currentTarget) });
  els.title = h('div.page-title');
  els.titleActions = h('div.row', { style: { gap: '8px' } });
  els.viewActions = h('div.row.view-actions', { style: { gap: '8px' } });

  document.body.prepend(h('div.aurora', h('i'), h('i'), h('i')));
  // Shared gradient for progress rings.
  document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs></svg>');

  replace(app, h('div.app',
    h('aside.rail',
      h('img.logo', { src: 'icon.png', alt: '' }),
      els.nav,
      h('div.rail-sep'),
      els.tools,
      h('div.rail-spacer'),
      els.toolStatus,
      h('button.rail-item.link-item', { onclick: () => api.link?.open(), dataset: { tip: 'Phone Link — webcam, mic & speakers', tipPos: 'right' } }, h('img', { src: 'link-icon.png', alt: '' })),
      railButton(settingsView)),
    h('main.main',
      h('div.titlebar',
        els.title,
        h('div.spacer'),
        els.viewActions,
        h('button.search-trigger', { onclick: () => openPalette(), dataset: { tip: 'Command palette  ·  Ctrl+K' } }, icon('search')),
        els.titleActions,
        els.pill),
      els.content)));

  for (const v of VIEWS) {
    v.root = h(`section.view${v.flush ? '.flush' : ''}${v.flex ? '.flex' : ''}`, { dataset: { view: v.id } });
    els.content.appendChild(v.root);
  }
  renderNav();
  renderToolStatus();
  renderPill();
  renderTitleActions();
}

function railButton(v, idx) {
  const count = v.id === 'sessions' ? state.sessions.filter(s => !s.endedAt).length : 0;
  const tip = `${v.title}${idx != null && idx < 9 ? `  ·  Ctrl+${idx + 1}` : ''}`;
  return h(`button.rail-item${state.view === v.id ? '.active' : ''}${v.id === 'camera' ? '.camera-item' : ''}`, {
    onclick: () => go(v.id), dataset: { nav: v.id, tip, tipPos: 'right' },
  }, icon(v.icon), count ? h('span.badge-dot', count) : null);
}

function renderNav() {
  let i = 0;
  const [general, device] = NAV;
  replace(els.nav, general.items.map(id => railButton(VIEWS.find(v => v.id === id), i++)));
  replace(els.tools, device.items.map(id => railButton(VIEWS.find(v => v.id === id), i++)));
  document.querySelectorAll('.rail > .rail-item[data-nav]').forEach(b => b.classList.toggle('active', state.view === 'settings'));
  const v = VIEWS.find(x => x.id === state.view);
  if (v && els.title) replace(els.title, h('h1', v.title));
}

function renderToolStatus() {
  const t = state.info?.tools || {};
  const ok = t.scrcpy && t.adb;
  els.toolStatus.className = `rail-status${ok ? '' : ' bad'}`;
  els.toolStatus.dataset.tip = ok ? `scrcpy ${t.scrcpyVersion || ''} · adb ${t.adbVersion || ''}` : 'scrcpy/adb not found — open Settings';
  els.toolStatus.dataset.tipPos = 'right';
  els.toolStatus.onclick = () => go('settings');
}

function renderPill() {
  const d = selectedDevice();
  const ready = readyDevices();
  if (!d) {
    replace(els.pill, h('span.ic', icon('smartphone')), h('span.txt.faint', ready.length ? 'Select device' : 'No device'), icon('chevron-down', 'chev'));
    return;
  }
  const live = sessionsFor(d.serial).length;
  replace(els.pill,
    h('span.ic', icon(deviceIconName(d)), live ? h('span.dot.live') : h(`span.dot.${d.state === 'device' ? 'ok' : 'warn'}`)),
    h('span.txt', deviceName(d)),
    d.battery ? h('span.batt', `${d.battery.level}%${d.battery.charging ? ' ⚡' : ''}`) : null,
    icon('chevron-down', 'chev'));
}

function renderTitleActions() {
  const d = selectedDevice();
  const ready = d && d.state === 'device';
  replace(els.titleActions,
    h('button.btn.icon', { disabled: !ready, dataset: { tip: 'Screenshot  ·  Ctrl+Shift+S' }, onclick: () => screenshot() }, icon('camera')),
    h('button.btn.primary.icon', { disabled: !ready, dataset: { tip: 'Mirror  ·  Ctrl+M' }, onclick: () => launch() }, icon('cast')));
}

function devicePicker(anchor) {
  const items = state.devices.length ? state.devices.map(d => ({
    label: `${deviceName(d)}${d.state !== 'device' ? ` (${d.state})` : ''}`,
    icon: deviceIconName(d),
    checked: d.serial === state.selected,
    onClick: () => selectDevice(d.serial),
  })) : [{ label: 'No devices connected', disabled: true }];
  const d = selectedDevice();
  showMenu(anchor, [{ heading: 'Devices' }, ...items, '-', { label: 'Add a device…', icon: 'plus', onClick: () => { go('devices'); setTimeout(() => bus.emit('wireless-tab', 'connect'), 30); } },
    ...(d ? ['-', ...deviceMenu(d).slice(1)] : [])], { align: 'right' });
}

// ------------------------------------------------------------------ routing
export function go(id, arg) {
  const v = VIEWS.find(x => x.id === id);
  if (!v) return;
  const prev = VIEWS.find(x => x.id === state.view);
  if (prev && prev !== v) { prev.hide?.(); prev.root.classList.remove('active'); }
  state.view = id;
  if (!created.has(id)) { v.create(v.root); created.add(id); }
  v.root.classList.add('active');
  // Page actions live in the title bar to save vertical space.
  v.actionsEl ||= v.root.querySelector(':scope > .page-head .actions, :scope .page-head > .actions');
  replace(els.viewActions, v.actionsEl || []);
  v.show?.(arg);
  renderNav();
  location.hash = id;
}

// ------------------------------------------------------------------ events
function onDevices({ devices, error }) {
  const before = new Map(state.devices.map(d => [d.serial, d.state]));
  state.devices = devices;
  state.devicesError = error;
  if (before.size || state.initialized) {
    for (const d of devices) {
      if (d.state === 'device' && before.get(d.serial) !== 'device') {
        if (before.size) toast({ type: 'success', title: 'Device connected', message: `${deviceName(d)} · ${d.type === 'wifi' ? 'Wi-Fi' : 'USB'}`, duration: 2600 });
        notify('Device connected', deviceName(d));
      }
    }
    for (const [serial, st] of before) {
      if (st === 'device' && !devices.find(d => d.serial === serial)) {
        toast({ type: 'warn', title: 'Device disconnected', message: state.config.deviceAliases?.[serial] || serial, duration: 3000 });
      }
    }
  }
  state.initialized = true;
  // Keep a sensible selection.
  const sel = devices.find(d => d.serial === state.selected);
  if (!sel) {
    const first = devices.find(d => d.state === 'device') || devices[0];
    if (first) selectDevice(first.serial); else if (state.selected && !devices.length) { /* keep remembered serial */ }
  }
  bus.emit('devices', devices);
  renderPill(); renderNav(); renderTitleActions();
}

function onScrcpy(ev) {
  if (ev.type === 'update') {
    const s = ev.session;
    const i = state.sessions.findIndex(x => x.id === s.id);
    const prev = i >= 0 ? state.sessions[i] : null;
    if (i >= 0) state.sessions[i] = s; else state.sessions.unshift(s);
    if (s.endedAt && prev && !prev.endedAt) {
      if (s.status === 'failed') {
        toast({ type: 'error', title: `Session ended · ${s.label}`, message: s.error || 'scrcpy exited unexpectedly', actions: [{ label: 'View log', icon: 'scroll-text', onClick: () => go('sessions', s.id) }] });
        api.app.flashFrame();
      } else if (s.recordPath) {
        toast({ type: 'success', title: 'Recording saved', message: s.recordPath.split(/[\\/]/).pop(), duration: 8000, actions: [
          { label: 'Play', icon: 'play', onClick: () => api.shell.openPath(s.recordPath) },
          { label: 'Folder', icon: 'folder-open', onClick: () => api.shell.showItem(s.recordPath) }] });
        notify('Recording saved', s.recordPath);
        bus.emit('media-changed');
      }
    }
    bus.emit('sessions', state.sessions);
    renderNav(); renderPill();
  } else if (ev.type === 'log') {
    bus.emit('session-log', ev);
  }
}

function onTrayAction({ action, serial }) {
  if (action === 'screenshot') screenshot(serial);
  else if (action === 'vcam') { selectDevice(serial); go('camera'); setTimeout(() => bus.emit('camera-start', 'vcam'), 400); }
  else launch(serial, { mode: action });
}

// ------------------------------------------------------------------ shortcuts
function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    const ids = NAV.flatMap(g => g.items);
    if (ids[+e.key - 1]) { e.preventDefault(); go(ids[+e.key - 1]); }
    return;
  }
  if (mod && e.key === ',') { e.preventDefault(); go('settings'); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); screenshot(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); launch(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); launch(undefined, { mode: 'record' }); return; }
  if (e.key === 'F5' && !typing) { e.preventDefault(); api.adb.refresh(); toast({ title: 'Refreshing devices…', duration: 1200 }); }
}

// ------------------------------------------------------------------ drag & drop
function initDropzone() {
  const zone = h('div.dropzone', h('div.box', icon('upload-cloud'), h('h3', 'Drop to send'), h('p.hint-text', 'APKs are installed · other files go to /sdcard/Download')));
  document.body.appendChild(zone);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    const inFiles = state.view === 'files';
    zone.querySelector('.hint-text').textContent = inFiles ? 'Files will be uploaded to the current folder' : 'APKs are installed · other files go to /sdcard/Download';
    zone.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; zone.classList.remove('show'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('show');
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    if (state.view === 'files') { bus.emit('files-drop', paths); return; }
    const apks = paths.filter(p => /\.apk$/i.test(p));
    const others = paths.filter(p => !/\.apk$/i.test(p));
    if (apks.length) await installApks(undefined, apks);
    if (others.length) await pushFiles(undefined, others);
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  if (!api) { document.body.textContent = 'This page must run inside Scrcpy Studio.'; return; }
  state.config = await api.store.get();
  state.info = await api.app.info();
  state.devices = (await api.adb.devices()).devices || [];
  state.sessions = await api.scrcpy.list();
  state.selected = state.config.selectedSerial;
  if (!state.devices.find(d => d.serial === state.selected)) state.selected = (readyDevices()[0] || state.devices[0])?.serial || state.config.selectedSerial;

  applyTheme();
  buildShell();
  initTooltips();
  initDropzone();

  api.on.devices(onDevices);
  api.on.scrcpy(onScrcpy);
  api.on.trayAction(onTrayAction);
  document.addEventListener('keydown', onKey);

  bus.on('navigate', ({ view, arg }) => go(view, arg));
  initUpdates();
  bus.on('select-device', (serial) => selectDevice(serial));
  bus.on('selected', () => { renderPill(); renderTitleActions(); });
  bus.on('config', () => { applyTheme(); renderPill(); });
  bus.on('tools', (info) => { state.info.tools = info; renderToolStatus(); });

  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id !== state.view) go(id); });
  const initial = location.hash.slice(1);
  go(VIEWS.find(v => v.id === initial) ? initial : 'devices');

  if (!state.info.tools.scrcpy || !state.info.tools.adb) {
    toast({ type: 'warn', title: 'scrcpy not found', message: 'Install scrcpy or point Scrcpy Studio to it in Settings.', duration: 0, actions: [{ label: 'Open settings', icon: 'settings', onClick: () => go('settings') }] });
  }
  if (!state.config.onboarded && !state.info.captureMode) welcome();
}

function welcome() {
  api.store.set({ onboarded: true });
  modal({
    title: 'Welcome to Scrcpy Studio', icon: 'sparkles', size: 'wide',
    body: h('div.col', { style: { gap: '14px' } },
      h('p', { style: { margin: 0 } }, 'A complete desktop companion for scrcpy: mirror, record, control and manage your Android devices.'),
      h('div.steps', { style: { marginTop: 0, maxWidth: 'none' } },
        h('div.step', h('div.n', '1'), h('b', 'Enable USB debugging'), h('span', 'Settings → About phone → tap Build number 7× → Developer options → USB debugging.')),
        h('div.step', h('div.n', '2'), h('b', 'Connect'), h('span', 'Plug in via USB and accept the prompt, or pair wirelessly with a QR code.')),
        h('div.step', h('div.n', '3'), h('b', 'Mirror'), h('span', 'Hit Mirror, pick a profile, or press Ctrl+K to do anything.'))),
      h('div.row.wrap', { style: { gap: '6px' } },
        ...[['Ctrl', 'K', 'Command palette'], ['Ctrl', 'M', 'Mirror'], ['Ctrl', 'Shift', 'S', 'Screenshot'], ['Ctrl', '1-9', 'Navigate']].map(k =>
          h('span.chip', h('span.kbd', ...k.slice(0, -1).map(x => h('span', x))), k[k.length - 1])))),
    buttons: [{ label: 'Get started', primary: true, icon: 'rocket', value: true }],
  });
}

boot().catch((e) => {
  console.error(e);
  document.body.appendChild(h('pre', { style: { color: '#f87171', padding: '20px', whiteSpace: 'pre-wrap' } }, String(e.stack || e)));
});
