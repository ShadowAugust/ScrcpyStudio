// Ctrl+K command palette with fuzzy matching over every app action.
import { h, icon, clear } from './lib/dom.js';
import { api, state, bus, deviceName, allProfiles, selectDevice, saveSettings, settings, saveConfig, selectedDevice } from './state.js';
import { launch, screenshot, navigate, reboot, enableWireless, renameDevice } from './actions.js';
import { QUICK_MODES } from './options.js';
import { toast } from './lib/ui.js';
import { checkNow } from './updates.js';

const KEYS = [
  ['Home', 'KEYCODE_HOME', 'house'], ['Back', 'KEYCODE_BACK', 'arrow-left'], ['Recent apps', 'KEYCODE_APP_SWITCH', 'layers'],
  ['Power', 'KEYCODE_POWER', 'power'], ['Volume up', 'KEYCODE_VOLUME_UP', 'volume-2'], ['Volume down', 'KEYCODE_VOLUME_DOWN', 'volume-1'],
  ['Mute', 'KEYCODE_VOLUME_MUTE', 'volume-x'], ['Play / pause', 'KEYCODE_MEDIA_PLAY_PAUSE', 'play'], ['Next track', 'KEYCODE_MEDIA_NEXT', 'skip-forward'],
  ['Wake screen', 'KEYCODE_WAKEUP', 'sun'], ['Sleep screen', 'KEYCODE_SLEEP', 'moon'], ['Open notifications', 'KEYCODE_NOTIFICATION', 'bell'],
];

function commands() {
  const d = selectedDevice();
  const ready = d?.state === 'device';
  const list = [];
  const add = (group, title, ic, run, desc, kbd) => list.push({ group, title, icon: ic, run, desc, kbd });

  if (ready) {
    for (const m of QUICK_MODES) add('Mirror', `${m.label} — ${deviceName(d)}`, m.icon, () => launch(d.serial, { mode: m.id }), m.desc, m.id === 'mirror' ? 'Ctrl M' : m.id === 'record' ? 'Ctrl ⇧ R' : null);
    for (const p of allProfiles()) add('Profiles', `Mirror with “${p.name}”`, p.icon || 'sliders-horizontal', () => launch(d.serial, { profileId: p.id }), p.description);
    add('Device', 'Take screenshot', 'camera', () => screenshot(d.serial), null, 'Ctrl ⇧ S');
    add('Device', 'Switch to Wi-Fi', 'wifi', () => enableWireless(d.serial), 'Enable adb over TCP/IP and connect');
    add('Device', 'Rename device', 'pencil', () => renameDevice(d.serial));
    add('Device', 'Reboot device', 'rotate-cw', () => reboot(d.serial));
    add('Device', 'Reboot to recovery', 'wrench', () => reboot(d.serial, 'recovery'));
    add('Device', 'Reboot to bootloader', 'cpu', () => reboot(d.serial, 'bootloader'));
    for (const [label, code, ic] of KEYS) add('Keys', `Press ${label}`, ic, () => api.adb.keyevent(d.serial, code), code);
  }
  for (const dev of state.devices) {
    if (dev.serial !== d?.serial) add('Switch device', `Select ${deviceName(dev)}`, 'smartphone', () => selectDevice(dev.serial), dev.serial);
  }
  const views = [['devices', 'Home', 'house'], ['camera', 'Camera Studio', 'aperture'], ['mirror', 'Mirroring profiles', 'sliders-horizontal'], ['sessions', 'Sessions', 'activity'], ['media', 'Media gallery', 'images'],
    ['control', 'Remote control', 'gamepad-2'], ['apps', 'Apps', 'layout-grid'], ['files', 'Files', 'folder'], ['shell', 'Shell', 'square-terminal'], ['logcat', 'Logcat', 'scroll-text'], ['info', 'Device info', 'info'], ['settings', 'Settings', 'settings']];
  for (const [id, t, ic] of views) add('Go to', t, ic, () => navigate(id));
  add('App', 'Connect wireless device', 'wifi', () => { navigate('devices'); setTimeout(() => bus.emit('wireless-tab', 'connect'), 50); });
  add('App', 'Pair with QR code', 'qr-code', () => { navigate('devices'); setTimeout(() => bus.emit('wireless-tab', 'qr'), 50); });
  add('App', 'Check for updates', 'download-cloud', () => checkNow(), 'Look for a new version on GitHub');
  add('Device', 'Open Phone Link', 'webcam', () => api.link?.open(), 'Phone as webcam, microphone and speakers');
  if (ready) add('Device', 'Start virtual webcam', 'webcam', () => { navigate('camera'); setTimeout(() => bus.emit('camera-start', 'vcam'), 400); }, 'Camera + mic for vMix, Discord, Zoom…');
  add('App', 'Stop all sessions', 'circle-stop', () => api.scrcpy.stopAll());
  add('App', 'Restart adb server', 'refresh-cw', async () => { toast({ type: 'loading', title: 'Restarting adb…', duration: 1500 }); await api.adb.restartServer(); });
  add('App', `Switch to ${settings().theme === 'light' ? 'dark' : 'light'} theme`, settings().theme === 'light' ? 'moon' : 'sun', () => saveSettings({ theme: settings().theme === 'light' ? 'dark' : 'light' }));
  add('App', 'Open screenshots folder', 'folder-open', () => { api.fs.ensureDir(settings().screenshotDir); api.shell.openPath(settings().screenshotDir); });
  add('App', 'Open recordings folder', 'folder-open', () => { api.fs.ensureDir(settings().recordDir); api.shell.openPath(settings().recordDir); });
  for (const p of allProfiles()) add('Set default profile', `Use “${p.name}” by default`, 'star', () => saveConfig({ activeProfileId: p.id }), null);
  return list;
}

function score(q, text) {
  if (!q) return 1;
  text = text.toLowerCase();
  const i = text.indexOf(q);
  if (i >= 0) return 100 - i;
  let ti = 0, s = 0;
  for (const ch of q) {
    const f = text.indexOf(ch, ti);
    if (f < 0) return 0;
    s += f === ti ? 3 : 1;
    ti = f + 1;
  }
  // Loose subsequence matches are noise; require mostly-consecutive hits.
  return s > q.length * 2 ? s : 0;
}

let open = false;
export function openPalette() {
  if (open) return;
  open = true;
  const all = commands();
  let items = [];
  let focus = 0;
  const input = h('input', { placeholder: 'Type a command, device, profile or page…', spellcheck: false });
  const listEl = h('div.list');
  const close = () => { open = false; scrim.remove(); };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = all.map(c => ({ c, s: score(q, `${c.title} ${c.group} ${c.desc || ''}`) })).filter(x => x.s > 0)
      .sort((a, b) => q ? b.s - a.s : 0).slice(0, 60).map(x => x.c);
    if (!q) items = items.filter(c => c.group !== 'Set default profile' && c.group !== 'Keys').slice(0, 40);
    focus = Math.min(focus, Math.max(0, items.length - 1));
    clear(listEl);
    let group = null;
    items.forEach((c, i) => {
      if (c.group !== group && !q) { group = c.group; listEl.appendChild(h('div.group', group)); }
      listEl.appendChild(h(`div.item${i === focus ? '.focus' : ''}`, {
        onmousemove: () => { if (focus !== i) { focus = i; highlight(); } },
        onclick: () => runItem(i),
      }, h('div.ic', icon(c.icon)), h('div.grow', h('div.t', c.title), c.desc ? h('div.d.ellipsis', c.desc) : null),
      c.kbd ? h('span.kbd', ...c.kbd.split(' ').map(k => h('span', k))) : (q ? h('span.chip', c.group) : null)));
    });
    if (!items.length) listEl.appendChild(h('div.empty', { style: { padding: '30px' } }, h('p', 'No matching commands')));
  };
  const highlight = () => {
    listEl.querySelectorAll('.item').forEach((el, i) => el.classList.toggle('focus', i === focus));
    listEl.querySelectorAll('.item')[focus]?.scrollIntoView({ block: 'nearest' });
  };
  const runItem = (i) => { const c = items[i]; if (!c) return; close(); setTimeout(() => c.run(), 10); };

  input.addEventListener('input', () => { focus = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focus = (focus + 1) % Math.max(1, items.length); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focus = (focus - 1 + items.length) % Math.max(1, items.length); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); runItem(focus); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  const scrim = h('div.scrim', { onmousedown: (e) => { if (e.target === scrim) close(); } },
    h('div.palette',
      h('div.top', icon('search'), input, h('span.kbd', h('span', 'Esc'))),
      listEl,
      h('div.foot', h('span', '↑↓ navigate'), h('span', '↵ run'), h('span', 'Esc close'))));
  document.body.appendChild(scrim);
  render();
  input.focus();
}
