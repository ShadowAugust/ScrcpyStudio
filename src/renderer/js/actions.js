// Device actions shared by views, menus, the command palette and the tray.
import { api, state, bus, deviceName, profileFor, getProfile, settings, saveConfig, sessionsFor, selectedDevice } from './state.js';
import { buildArgs } from './command.js';
import { QUICK_MODES } from './options.js';
import { toast, withToast, confirmDialog, promptDialog } from './lib/ui.js';
import { h } from './lib/dom.js';

export const navigate = (view, arg) => bus.emit('navigate', { view, arg });

export function requireDevice(serial) {
  const d = serial ? state.devices.find(x => x.serial === serial) : selectedDevice();
  if (!d) { toast({ type: 'warn', title: 'No device selected', message: 'Connect a device and select it first.' }); return null; }
  if (d.state !== 'device') { toast({ type: 'warn', title: 'Device not ready', message: d.state === 'unauthorized' ? 'Accept the USB debugging prompt on the device.' : `Device is ${d.state}.` }); return null; }
  return d;
}

export function notify(title, body) {
  if (!settings().notifications || document.hasFocus()) return;
  try { new Notification(title, { body, icon: 'icon.png', silent: true }); } catch {}
}

// ------------------------------------------------------------------ launch
export async function launch(serial, { mode = 'mirror', profileId, overlay = {}, startApp, label } = {}) {
  const d = requireDevice(serial);
  if (!d) return null;
  const profile = profileId ? getProfile(profileId) : profileFor(d.serial);
  const qm = QUICK_MODES.find(m => m.id === mode) || QUICK_MODES[0];
  const values = { ...profile.options, ...(qm.overlay || {}), ...overlay };
  if (qm.otg) values.otg = true;
  if (qm.id === 'audio') delete values['no-audio'];
  if (startApp) { values['start-app'] = startApp; if (!values['new-display']) values['new-display'] = true; }
  if (values.record && !values['record-format']) values['record-format'] = settings().recordFormat;

  const name = deviceName(d);
  const title = settings().windowTitleFromAlias ? (startApp ? `${name} · ${label || startApp}` : name) : null;
  const { args, record } = buildArgs(values, { title, version: state.info?.tools?.scrcpyVersion });
  const r = await api.scrcpy.start({ serial: d.serial, args, record, mode: qm.id, profileName: profile.name, label: name });
  if (!r?.ok) {
    toast({ type: 'error', title: 'Could not start scrcpy', message: r?.error || 'Unknown error', actions: [{ label: 'Settings', onClick: () => navigate('settings') }] });
    return null;
  }
  toast({
    type: 'success',
    title: `${qm.id === 'mirror' ? 'Mirroring' : qm.label} · ${name}`,
    message: startApp ? `Launching ${label || startApp} on a virtual display` : `Profile: ${profile.name}`,
    duration: 2600,
  });
  return r.session;
}

export function stopSessions(serial) {
  for (const s of sessionsFor(serial)) api.scrcpy.stop(s.id);
}

// ------------------------------------------------------------------ screenshot
export async function screenshot(serial) {
  const d = requireDevice(serial);
  if (!d) return;
  const t = toast({ type: 'loading', title: 'Capturing screenshot…', duration: 0 });
  const r = await api.adb.screenshot(d.serial);
  t.close();
  if (!r?.ok) { toast({ type: 'error', title: 'Screenshot failed', message: r?.error }); return; }
  bus.emit('media-changed');
  toast({
    type: 'success', title: 'Screenshot saved', message: `${r.width}×${r.height}${settings().screenshotToClipboard ? ' · copied to clipboard' : ''}`,
    image: r.thumb, onImageClick: () => api.shell.openPath(r.path), duration: 6000,
    actions: [
      { label: 'Open', icon: 'external-link', onClick: () => api.shell.openPath(r.path) },
      { label: 'Copy', icon: 'copy', onClick: () => api.clipboard.image(r.path).then(() => toast({ type: 'success', title: 'Copied to clipboard', duration: 1800 })) },
      { label: 'Folder', icon: 'folder-open', onClick: () => api.shell.showItem(r.path) },
    ],
  });
}

// ------------------------------------------------------------------ device management
export async function renameDevice(serial) {
  const d = state.devices.find(x => x.serial === serial);
  const name = await promptDialog({ title: 'Rename device', label: 'Display name', value: deviceName(d), placeholder: d?.model || serial, hint: 'Only stored in Scrcpy Studio. Leave the same to keep.' });
  if (name == null) return;
  const aliases = { ...(state.config.deviceAliases || {}) };
  if (name.trim()) aliases[serial] = name.trim(); else delete aliases[serial];
  await saveConfig({ deviceAliases: aliases });
  bus.emit('devices', state.devices);
}

export async function reboot(serial, mode) {
  const d = requireDevice(serial);
  if (!d) return;
  const label = { recovery: 'recovery', bootloader: 'bootloader', sideload: 'sideload' }[mode] || 'system';
  if (settings().confirmDangerous && !(await confirmDialog({ title: `Reboot to ${label}?`, message: `${deviceName(d)} will restart${mode ? ` into ${label} mode` : ''}. Active sessions will end.`, confirm: 'Reboot', danger: true, icon: 'power' }))) return;
  const r = await api.adb.reboot(d.serial, mode);
  toast(r.ok ? { type: 'success', title: 'Rebooting…', message: deviceName(d) } : { type: 'error', title: 'Reboot failed', message: r.stderr || r.error });
}

export async function enableWireless(serial) {
  const d = requireDevice(serial);
  if (!d) return;
  await withToast(`Switching ${deviceName(d)} to Wi-Fi…`, () => api.adb.enableWireless(d.serial, 5555), {
    success: (r) => `Connected wirelessly · ${r.address}`,
    error: 'Could not switch to Wi-Fi',
  });
}

export async function disconnect(serial) {
  stopSessions(serial);
  const r = await api.adb.disconnect(serial);
  toast(r.ok ? { type: 'success', title: 'Disconnected', message: serial, duration: 2000 } : { type: 'error', title: 'Disconnect failed', message: r.message });
}

export async function installApks(serial, paths, opts = {}) {
  const d = requireDevice(serial);
  if (!d || !paths?.length) return;
  const t = toast({ type: 'loading', title: `Installing ${paths.length > 1 ? paths.length + ' apps' : 'app'}…`, message: paths[0].split(/[\\/]/).pop(), duration: 0 });
  const off = api.on.installProgress((p) => t.update({ message: `${p.index + 1}/${p.total} · ${p.file.split(/[\\/]/).pop()}` }));
  const results = await api.adb.install(d.serial, paths, opts);
  off();
  t.close();
  const ok = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);
  if (ok.length) toast({ type: 'success', title: `Installed ${ok.length} app${ok.length > 1 ? 's' : ''}`, message: ok.map(r => r.file.split(/[\\/]/).pop()).join(', ') });
  for (const b of bad) toast({ type: 'error', title: `Install failed: ${b.file.split(/[\\/]/).pop()}`, message: b.message });
  bus.emit('apps-changed', d.serial);
}

export async function pushFiles(serial, paths, remoteDir = '/sdcard/Download/') {
  const d = requireDevice(serial);
  if (!d || !paths?.length) return;
  const r = await withToast(`Sending ${paths.length} item${paths.length > 1 ? 's' : ''} to ${remoteDir}…`, () => api.adb.push(d.serial, paths, remoteDir), {
    success: (x) => `Sent to ${remoteDir}`, error: 'Transfer failed',
  });
  if (r) bus.emit('files-changed', { serial: d.serial, dir: remoteDir });
  return r;
}

export async function copySerial(serial) {
  await api.clipboard.text(serial);
  toast({ type: 'success', title: 'Serial copied', message: serial, duration: 1800 });
}

/** Menu items for a device (used by device cards, pill and tray). */
export function deviceMenu(d) {
  const ready = d.state === 'device';
  const live = sessionsFor(d.serial).length;
  return [
    { heading: deviceName(d) },
    ...QUICK_MODES.map(m => ({ label: m.label, icon: m.icon, disabled: !ready, onClick: () => launch(d.serial, { mode: m.id }) })),
    live ? { label: `Stop ${live} session${live > 1 ? 's' : ''}`, icon: 'circle-stop', danger: true, onClick: () => stopSessions(d.serial) } : null,
    '-',
    { label: 'Screenshot', icon: 'camera', disabled: !ready, onClick: () => screenshot(d.serial), hint: 'Ctrl+Shift+S' },
    { label: 'Remote control', icon: 'gamepad-2', disabled: !ready, onClick: () => { bus.emit('select-device', d.serial); navigate('control'); } },
    { label: 'Apps', icon: 'layout-grid', disabled: !ready, onClick: () => { bus.emit('select-device', d.serial); navigate('apps'); } },
    { label: 'Files', icon: 'folder', disabled: !ready, onClick: () => { bus.emit('select-device', d.serial); navigate('files'); } },
    '-',
    d.type === 'usb' ? { label: 'Switch to Wi-Fi', icon: 'wifi', disabled: !ready, onClick: () => enableWireless(d.serial) } : null,
    d.type === 'wifi' ? { label: 'Disconnect', icon: 'unlink', onClick: () => disconnect(d.serial) } : null,
    { label: 'Rename…', icon: 'pencil', onClick: () => renameDevice(d.serial) },
    { label: 'Copy serial', icon: 'copy', onClick: () => copySerial(d.serial) },
    '-',
    { label: 'Reboot', icon: 'rotate-cw', disabled: !ready, onClick: () => reboot(d.serial) },
    { label: 'Reboot to recovery', icon: 'wrench', disabled: !ready, onClick: () => reboot(d.serial, 'recovery') },
    { label: 'Reboot to bootloader', icon: 'cpu', disabled: !ready, onClick: () => reboot(d.serial, 'bootloader') },
  ];
}

export function deviceIconName(d) {
  if (d.type === 'wifi') return 'wifi';
  if (d.type === 'emulator') return 'monitor-smartphone';
  return 'usb';
}

export function isTablet(d) {
  return /tablet/.test(d.characteristics || '') || (d.physicalResolution && (() => { const [w, hh] = d.physicalResolution.split('x').map(Number); return w > hh; })());
}

export function batteryEl(b) {
  if (!b) return null;
  const color = b.charging ? 'var(--success)' : b.level <= 15 ? 'var(--danger)' : b.level <= 30 ? 'var(--warn)' : 'currentColor';
  return h('span.battery', { style: { color } },
    h('span.cell', h('span.fill', { style: { width: Math.max(6, b.level) + '%' } })),
    `${b.level}%${b.charging ? ' ⚡' : ''}`);
}
