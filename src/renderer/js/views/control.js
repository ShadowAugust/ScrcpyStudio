// Remote control: hardware keys, text input, quick settings and display tweaks.
import { h, icon, clear, replace } from '../lib/dom.js';
import { toast, switchEl, selectEl, rangeEl, segmented, emptyState, confirmDialog, tip, infoTip } from '../lib/ui.js';
import { api, state, bus, selectedDevice, deviceName, settings } from '../state.js';
import { screenshot, reboot, launch, navigate } from '../actions.js';

let root, body, current = null, cfg = null, busy = new Set();

const key = (code, long) => async () => {
  const d = selectedDevice();
  if (!d) return;
  const r = await api.adb.keyevent(d.serial, code, long);
  if (!r.ok) toast({ type: 'error', title: 'Key event failed', message: r.stderr || r.error });
};

const rbtn = (ic, label, code, cls = '', long) => h(`button.rbtn${cls ? '.' + cls : ''}`, { onclick: typeof code === 'function' ? code : key(code, long), dataset: { tip: typeof code === 'string' ? code : label } }, icon(ic), label);

function remoteCard(d) {
  const textInput = h('input.input', { placeholder: 'Type text to send…', spellcheck: false });
  const sendText = async () => {
    if (!textInput.value) return;
    const r = await api.adb.text(d.serial, textInput.value);
    if (r.ok) { textInput.value = ''; toast({ type: 'success', title: 'Text sent', duration: 1400 }); }
    else toast({ type: 'error', title: 'Could not send text', message: r.stderr || r.error });
  };
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });

  return h('div.card.remote',
    h('div.speaker'),
    h('div.section-title', icon('gamepad-2', '', 14), 'Navigation'),
    h('div.pad',
      rbtn('arrow-left', 'Back', 'KEYCODE_BACK'),
      rbtn('house', 'Home', 'KEYCODE_HOME', 'primary'),
      rbtn('layers', 'Recents', 'KEYCODE_APP_SWITCH'),
      rbtn('bell', 'Notifications', async () => { await api.adb.shell(d.serial, 'cmd statusbar expand-notifications'); }),
      rbtn('power', 'Power', 'KEYCODE_POWER', 'danger'),
      rbtn('sliders-horizontal', 'Quick settings', async () => { await api.adb.shell(d.serial, 'cmd statusbar expand-settings'); }),
      rbtn('volume-1', 'Vol −', 'KEYCODE_VOLUME_DOWN'),
      rbtn('volume-x', 'Mute', 'KEYCODE_VOLUME_MUTE'),
      rbtn('volume-2', 'Vol +', 'KEYCODE_VOLUME_UP')),
    h('div.section-title', { style: { marginTop: '4px' } }, icon('music', '', 14), 'Media & screen'),
    h('div.mini',
      rbtn('skip-back', 'Prev', 'KEYCODE_MEDIA_PREVIOUS'),
      rbtn('play', 'Play', 'KEYCODE_MEDIA_PLAY_PAUSE'),
      rbtn('skip-forward', 'Next', 'KEYCODE_MEDIA_NEXT'),
      rbtn('camera', 'Shot', () => screenshot(d.serial)),
      rbtn('sun', 'Wake', 'KEYCODE_WAKEUP'),
      rbtn('moon', 'Sleep', 'KEYCODE_SLEEP'),
      rbtn('rotate-cw', 'Rotate', async () => {
        const r = await api.adb.shell(d.serial, 'settings get system user_rotation');
        const next = ((parseInt(r.stdout, 10) || 0) + 1) % 4;
        await api.adb.shell(d.serial, `settings put system accelerometer_rotation 0; settings put system user_rotation ${next}`);
        load();
      }),
      rbtn('search', 'Assist', 'KEYCODE_ASSIST'),
      rbtn('lock', 'Lock', 'KEYCODE_SLEEP'),
      rbtn('menu', 'Menu', 'KEYCODE_MENU'),
      rbtn('flashlight', 'Camera', 'KEYCODE_CAMERA'),
      rbtn('circle-x', 'Close', async () => { await api.adb.shell(d.serial, 'cmd statusbar collapse'); })),
    h('div.section-title', { style: { marginTop: '4px' } }, icon('type', '', 14), 'Keyboard'),
    h('div.row', textInput, tip(h('button.btn.icon', { onclick: sendText }, icon('send')), 'Send text')),
    h('div.row.wrap', { style: { gap: '6px' } },
      ...[['Enter', 'KEYCODE_ENTER'], ['Tab', 'KEYCODE_TAB'], ['Del', 'KEYCODE_DEL'], ['Esc', 'KEYCODE_ESCAPE'], ['↑', 'KEYCODE_DPAD_UP'], ['↓', 'KEYCODE_DPAD_DOWN'], ['←', 'KEYCODE_DPAD_LEFT'], ['→', 'KEYCODE_DPAD_RIGHT']].map(([l, c]) =>
        h('button.chip', { onclick: key(c) }, l)),
      h('button.chip', { onclick: async () => {
        const t = await api.clipboard.readText();
        if (!t) return toast({ type: 'warn', title: 'Clipboard is empty' });
        const r = await api.adb.text(d.serial, t);
        toast(r.ok ? { type: 'success', title: 'Clipboard typed on device', duration: 1500 } : { type: 'error', title: 'Failed', message: r.stderr });
      } }, icon('clipboard'), 'Paste PC clipboard')));
}

function tile(k, label, ic, sub, opts = {}) {
  const on = !!cfg?.[k];
  const el = h(`button.qs-tile${on ? '.on' : ''}${busy.has(k) ? '.busy' : ''}`, {
    onclick: async () => {
      if (opts.confirm && !on && !(await confirmDialog(opts.confirm))) return;
      if (opts.confirmOff && on && !(await confirmDialog(opts.confirmOff))) return;
      await apply(k, !on);
    },
  }, h('div.ic', icon(ic)), h('div', h('div.t', label), h('div.s', on ? (sub?.[0] || 'On') : (sub?.[1] || 'Off'))));
  return el;
}

async function apply(k, value, quiet) {
  const d = selectedDevice();
  if (!d) return;
  busy.add(k);
  if (cfg) cfg[k] = value;
  renderBody();
  const r = await api.adb.applySetting(d.serial, k, value);
  busy.delete(k);
  if (!r.ok) toast({ type: 'error', title: 'Setting failed', message: r.message || 'The device rejected this change (it may need root or a newer Android version).' });
  else if (!quiet) toast({ type: 'success', title: 'Updated', message: labelFor(k, value), duration: 1400 });
  setTimeout(load, 600);
}

function labelFor(k, v) {
  const names = { wifi: 'Wi-Fi', bluetooth: 'Bluetooth', mobileData: 'Mobile data', airplane: 'Airplane mode', darkMode: 'Dark mode', autoRotate: 'Auto-rotate', showTouches: 'Show touches', pointerLocation: 'Pointer location', stayOn: 'Stay awake', autoBrightness: 'Auto brightness' };
  if (names[k]) return `${names[k]} ${v ? 'on' : 'off'}`;
  return `${k} → ${v}`;
}

function quickCard(d) {
  const wifiDanger = d.type === 'wifi' ? { title: 'Turn off Wi-Fi?', message: 'You are connected over Wi-Fi — turning it off will disconnect this device.', confirm: 'Turn off', danger: true } : null;
  return h('div.card',
    h('div.card-head', h('h3', icon('toggle-right'), 'Quick settings'), h('div.actions', tip(h('button.btn.ghost.icon.sm', { onclick: load }, icon('refresh-cw')), 'Reload'))),
    h('div.card-body', cfg ? h('div.qs-grid',
      tile('wifi', 'Wi-Fi', 'wifi', null, { confirmOff: wifiDanger }),
      tile('bluetooth', 'Bluetooth', 'bluetooth'),
      tile('mobileData', 'Mobile data', 'signal'),
      tile('airplane', 'Airplane', 'plane', null, { confirm: d.type === 'wifi' ? { title: 'Enable airplane mode?', message: 'This may drop your Wi-Fi connection to the device.', confirm: 'Enable', danger: true } : null }),
      tile('darkMode', 'Dark mode', 'moon-star'),
      tile('autoRotate', 'Auto-rotate', 'rotate-cw'),
      tile('stayOn', 'Stay awake', 'sun', ['While charging', 'Off']),
      tile('showTouches', 'Show touches', 'pointer'),
      tile('pointerLocation', 'Pointer location', 'mouse-pointer-2'),
      tile('autoBrightness', 'Auto brightness', 'sun-dim'))
      : h('div.qs-grid', Array.from({ length: 10 }, () => h('div.skeleton', { style: { height: '60px', borderRadius: '12px' } })))));
}

function displayCard(d) {
  if (!cfg) return h('div.card', h('div.card-head', h('h3', icon('monitor'), 'Display')), h('div.card-body', h('div.skeleton', { style: { height: '200px' } })));
  const bVal = h('span.val', cfg.brightness ?? '—');
  const bright = rangeEl({ min: 1, max: 255, value: cfg.brightness ?? 128, onInput: (v) => { bVal.textContent = v; }, onChange: (v) => apply('brightness', v, true) });
  const sizeInput = h('input.input.sm.mono', { value: cfg.wmSize !== cfg.wmPhysical ? cfg.wmSize || '' : '', placeholder: cfg.wmPhysical || '1080x2400', style: { width: '130px' } });
  const dpiInput = h('input.input.sm.mono', { value: cfg.wmDensity !== cfg.wmPhysicalDensity ? cfg.wmDensity || '' : '', placeholder: String(cfg.wmPhysicalDensity || 420), style: { width: '90px' } });
  const animVal = [0, 0.5, 1, 1.5, 2].reduce((a, b) => Math.abs(b - cfg.animWindow) < Math.abs(a - cfg.animWindow) ? b : a, 1);

  return h('div.card',
    h('div.card-head', h('h3', icon('monitor'), 'Display & system')),
    h('div.card-body', { style: { paddingTop: '4px', paddingBottom: '4px' } },
      h('div.setting-line', h('div.l', h('div.t', 'Brightness', infoTip('Sets manual brightness mode'))), h('div.c', { style: { width: '260px' } }, bright, bVal)),
      h('div.setting-line', h('div.l', h('div.t', 'Screen timeout', infoTip('Time before the screen turns off'))),
        h('div.c', selectEl([[15000, '15 seconds'], [30000, '30 seconds'], [60000, '1 minute'], [120000, '2 minutes'], [300000, '5 minutes'], [600000, '10 minutes'], [1800000, '30 minutes'], [2147483647, 'Never']].map(([v, l]) => [String(v), l]),
          String(cfg.screenTimeout), (v) => apply('screenTimeout', Number(v)), 'sm'))),
      h('div.setting-line', h('div.l', h('div.t', 'Font size', infoTip('System font scale'))),
        h('div.c', selectEl([['0.85', 'Small'], ['1', 'Default'], ['1.15', 'Large'], ['1.3', 'Larger'], ['1.5', 'Huge'], ['2', 'Max']], String(cfg.fontScale), (v) => apply('fontScale', v), 'sm'))),
      h('div.setting-line', h('div.l', h('div.t', 'Animation speed', infoTip('Window, transition & animator scales — 0 makes the device feel instant'))),
        h('div.c', segmented([[0, 'Off'], [0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']], animVal, (v) => apply('animations', v)))),
      h('div.setting-line', h('div.l', h('div.t', 'Resolution override', infoTip(`Physical: ${cfg.wmPhysical || '?'} — changes the rendering resolution (wm size)`))),
        h('div.c', sizeInput,
          h('button.btn.sm', { onclick: () => apply('wmSize', sizeInput.value.trim()) }, 'Apply'),
          tip(h('button.btn.sm.ghost.icon', { onclick: () => apply('wmSize', '') }, icon('undo-2')), 'Reset'))),
      h('div.setting-line', h('div.l', h('div.t', 'Density override', infoTip(`Physical: ${cfg.wmPhysicalDensity || '?'} dpi — lower = more content on screen`))),
        h('div.c', dpiInput,
          h('button.btn.sm', { onclick: () => apply('wmDensity', dpiInput.value.trim()) }, 'Apply'),
          tip(h('button.btn.sm.ghost.icon', { onclick: () => apply('wmDensity', '') }, icon('undo-2')), 'Reset')))));
}

function shortcutsCard(d) {
  const open = (action, label) => h('button.chip', { onclick: async () => {
    const r = await api.adb.shell(d.serial, `am start -a ${action}`);
    toast(/Error|Exception/.test(r.stdout + r.stderr) ? { type: 'error', title: `Could not open ${label}`, message: (r.stdout + r.stderr).trim() } : { type: 'success', title: `Opened ${label}`, duration: 1400 });
  } }, label);
  return h('div.card',
    h('div.card-head', h('h3', icon('external-link'), 'Open on device')),
    h('div.card-body', h('div.row.wrap', { style: { gap: '6px' } },
      open('android.settings.SETTINGS', 'Settings'),
      open('android.settings.APPLICATION_DEVELOPMENT_SETTINGS', 'Developer options'),
      open('android.settings.WIFI_SETTINGS', 'Wi-Fi'),
      open('android.settings.BLUETOOTH_SETTINGS', 'Bluetooth'),
      open('android.settings.DISPLAY_SETTINGS', 'Display'),
      open('android.settings.SOUND_SETTINGS', 'Sound'),
      open('android.intent.action.POWER_USAGE_SUMMARY', 'Battery'),
      open('android.settings.APPLICATION_SETTINGS', 'Apps'),
      open('android.settings.INTERNAL_STORAGE_SETTINGS', 'Storage'),
      open('android.settings.HARD_KEYBOARD_SETTINGS', 'Physical keyboard'),
      open('android.settings.ACCESSIBILITY_SETTINGS', 'Accessibility'),
      open('android.settings.DATE_SETTINGS', 'Date & time'),
      open('android.settings.DEVICE_INFO_SETTINGS', 'About phone'),
      open('android.media.action.STILL_IMAGE_CAMERA', 'Camera app'))),
    h('div.card-body', { style: { borderTop: '1px solid var(--border)' } },
      h('div.section-title', icon('power', '', 14), 'Power'),
      h('div.row.wrap', { style: { gap: '8px' } },
        h('button.btn.sm', { onclick: () => reboot(d.serial) }, icon('rotate-cw'), 'Reboot'),
        h('button.btn.sm', { onclick: () => reboot(d.serial, 'recovery') }, icon('wrench'), 'Recovery'),
        h('button.btn.sm', { onclick: () => reboot(d.serial, 'bootloader') }, icon('cpu'), 'Bootloader'),
        h('button.btn.sm', { onclick: key('KEYCODE_SLEEP') }, icon('moon'), 'Screen off'),
        h('button.btn.sm', { onclick: key('KEYCODE_WAKEUP') }, icon('sun'), 'Screen on'),
        h('button.btn.sm', { onclick: key('KEYCODE_POWER', true) }, icon('circle-power'), 'Power menu'))));
}

let remoteFor = null, rightCol = null;
function renderBody() {
  const d = selectedDevice();
  if (!d || d.state !== 'device') {
    remoteFor = null;
    replace(body, h('div.card', emptyState({ icon: 'gamepad-2', title: 'No device ready', text: 'Select a connected, authorized device to control it.', actions: [h('button.btn.primary', { onclick: () => navigate('devices') }, 'Go to devices')] })));
    return;
  }
  // The remote card is kept across refreshes so typed text isn't lost.
  if (remoteFor !== d.serial) {
    remoteFor = d.serial;
    rightCol = h('div.col', { style: { gap: '16px' } });
    replace(body, h('div.control-layout', remoteCard(d), rightCol));
  }
  replace(rightCol, quickCard(d), displayCard(d), shortcutsCard(d));
}

async function load() {
  const d = selectedDevice();
  if (!d || d.state !== 'device') { cfg = null; renderBody(); return; }
  const serial = d.serial;
  const r = await api.adb.readSettings(serial);
  if (selectedDevice()?.serial !== serial) return;
  cfg = r;
  renderBody();
}

export default {
  id: 'control', title: 'Control', icon: 'gamepad-2',
  create(r) {
    root = r;
    body = h('div');
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Remote control'), h('div.sub')),
        h('div.actions',
          h('button.btn', { onclick: () => launch() }, icon('cast'), 'Mirror'),
          h('button.btn', { onclick: () => screenshot() }, icon('camera'), 'Screenshot'))),
      body);
    bus.on('selected', () => { cfg = null; if (state.view === 'control') load(); });
  },
  show() {
    const d = selectedDevice();
    if (current !== d?.serial) { cfg = null; current = d?.serial; }
    renderBody();
    load();
  },
};
