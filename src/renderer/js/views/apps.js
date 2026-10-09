// App manager: list, launch, mirror in a virtual display, install/uninstall…
import { h, icon, clear, replace, debounce, hashColor } from '../lib/dom.js';
import { toast, showMenu, confirmDialog, segmented, emptyState, modal, withToast, tip } from '../lib/ui.js';
import { api, state, bus, selectedDevice, deviceName, saveConfig, settings } from '../state.js';
import { launch, installApks, navigate, requireDevice } from '../actions.js';

let listEl, countEl, searchInput, filter = 'user', query = '', packages = [], names = {}, loadedFor = null, loading = false;

const favs = () => new Set(state.config.favoriteApps?.[state.selected] || []);

function prettyName(pkg) {
  const last = pkg.split('.').filter(p => !['com', 'org', 'net', 'android', 'app', 'apps', 'google', 'mobile'].includes(p)).pop() || pkg.split('.').pop();
  return last.charAt(0).toUpperCase() + last.slice(1);
}
const appName = (p) => names[p.package] || prettyName(p.package);

async function load(force = false) {
  const d = selectedDevice();
  if (!d || d.state !== 'device') { packages = []; render(); return; }
  if (!force && loadedFor === d.serial && packages.length) { render(); return; }
  loading = true;
  loadedFor = d.serial;
  render();
  const r = await api.adb.packages(d.serial);
  loading = false;
  if (selectedDevice()?.serial !== d.serial) return;
  if (!r.ok) { toast({ type: 'error', title: 'Could not list apps', message: r.error }); packages = []; render(); return; }
  packages = r.packages;
  const cached = state.queryCache[d.serial]?.apps;
  names = cached ? Object.fromEntries(cached.map(a => [a.package, a.name])) : names;
  render();
  if (!cached) {
    // Real labels come from the scrcpy server (takes a few seconds).
    api.scrcpy.query(d.serial, 'apps').then((q) => {
      if (!q.items?.length || selectedDevice()?.serial !== d.serial) return;
      state.queryCache[d.serial] = { ...(state.queryCache[d.serial] || {}), apps: q.items };
      names = Object.fromEntries(q.items.map(a => [a.package, a.name]));
      render();
    });
  }
}

function filtered() {
  const f = favs();
  const q = query.toLowerCase();
  return packages.filter(p => {
    if (filter === 'user' && p.system) return false;
    if (filter === 'system' && !p.system) return false;
    if (filter === 'disabled' && !p.disabled) return false;
    if (filter === 'favorites' && !f.has(p.package)) return false;
    return !q || p.package.toLowerCase().includes(q) || appName(p).toLowerCase().includes(q);
  }).sort((a, b) => (f.has(b.package) - f.has(a.package)) || appName(a).localeCompare(appName(b)));
}

async function toggleFav(pkg) {
  const serial = state.selected;
  const set = favs();
  set.has(pkg) ? set.delete(pkg) : set.add(pkg);
  await saveConfig({ favoriteApps: { ...(state.config.favoriteApps || {}), [serial]: [...set] } });
  render();
}

async function action(p, act) {
  const d = requireDevice();
  if (!d) return;
  const name = appName(p);
  const danger = { uninstall: `Uninstall ${name}?`, 'uninstall-user': `Remove ${name} for the current user?`, clear: `Clear all data of ${name}?`, disable: `Disable ${name}?` }[act];
  if (danger && settings().confirmDangerous) {
    const msg = { uninstall: 'The app and its data will be removed from the device.', 'uninstall-user': 'System app will be hidden/removed for user 0. It can be restored with "cmd package install-existing".', clear: 'All app data, accounts and settings of this app will be deleted.', disable: 'The app will be hidden and stop running until re-enabled.' }[act];
    if (!(await confirmDialog({ title: danger, message: msg, confirm: act === 'clear' ? 'Clear data' : act === 'disable' ? 'Disable' : 'Uninstall', danger: true }))) return;
  }
  const extra = act === 'extract' ? { dir: settings().pullDir, apk: p.apk } : {};
  const labels = { launch: 'Launching', stop: 'Stopping', clear: 'Clearing data of', uninstall: 'Uninstalling', 'uninstall-user': 'Removing', disable: 'Disabling', enable: 'Enabling', extract: 'Extracting', info: 'Opening' };
  const r = await withToast(`${labels[act]} ${name}…`, () => api.adb.appAction(d.serial, p.package, act, extra), {
    success: act === 'extract' ? (x) => `APK saved to ${x.path}` : `${name}: done`,
    error: `Could not ${act.replace('-', ' ')} ${name}`,
  });
  if (r && act === 'extract') api.shell.showItem(r.path);
  if (r && ['uninstall', 'uninstall-user', 'disable', 'enable'].includes(act)) load(true);
}

async function details(p) {
  const d = requireDevice();
  if (!d) return;
  const info = await api.adb.appDetails(d.serial, p.package);
  const row = (k, v) => v ? [h('div', k), h('div', v)] : [];
  modal({
    title: appName(p), icon: 'package', size: 'wide',
    body: h('div.kv', { style: { marginTop: '4px' } },
      row('Package', p.package), row('Version', info.versionName && `${info.versionName} (${info.versionCode})`),
      row('Target SDK', info.targetSdk), row('Min SDK', info.minSdk), row('Installed', info.firstInstall), row('Updated', info.lastUpdate),
      row('Installer', info.installer), row('APK path', p.apk), row('Data dir', info.dataDir), row('Type', p.system ? 'System app' : 'User app'), row('State', p.disabled ? 'Disabled' : 'Enabled')),
    buttons: [
      { label: 'Extract APK', icon: 'download', onClick: () => action(p, 'extract') },
      { label: 'Open app info', icon: 'external-link', onClick: () => action(p, 'info') },
      { label: 'Close', primary: true },
    ],
  });
}

function appRow(p) {
  const f = favs().has(p.package);
  const name = appName(p);
  return h('div.app-row', {
    onclick: (e) => { if (!e.target.closest('button')) showMenu({ x: e.clientX, y: e.clientY }, menuFor(p)); },
    oncontextmenu: (e) => { e.preventDefault(); showMenu({ x: e.clientX, y: e.clientY }, menuFor(p)); },
    dataset: { tip: p.package },
  },
    h('div.tags', p.system ? tip(h('span.dot'), 'System app') : null, p.disabled ? tip(h('span.dot.warn'), 'Disabled') : null),
    tip(h(`button.btn.ghost.icon.sm.star.star-float${f ? '.on' : ''}`, { onclick: () => toggleFav(p.package) }, icon('star')), f ? 'Unfavorite' : 'Favorite'),
    h('div.avatar', { style: { background: p.disabled ? 'var(--surface-3)' : hashColor(p.package) } }, name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0) || '?'),
    h('div.meta', h('div.n', h('span.t', name)), h('div.p', p.package)),
    h('div.acts',
      tip(h('button.btn.ghost.icon.sm', { onclick: () => action(p, 'launch') }, icon('play')), 'Launch on device'),
      tip(h('button.btn.ghost.icon.sm', { onclick: () => launch(undefined, { startApp: p.package, label: name }) }, icon('monitor-play')), 'Open in its own window'),
      tip(h('button.btn.ghost.icon.sm', { onclick: () => action(p, 'stop') }, icon('circle-stop')), 'Force stop')));
}

function menuFor(p) {
  return [
    { heading: appName(p) },
    { label: 'Launch on device', icon: 'play', onClick: () => action(p, 'launch') },
    { label: 'Mirror in own window', icon: 'monitor-play', onClick: () => launch(undefined, { startApp: p.package, label: appName(p) }) },
    { label: 'Mirror on main screen', icon: 'cast', onClick: () => launch(undefined, { overlay: { 'start-app': p.package, 'new-display': false } }) },
    { label: 'Force stop', icon: 'circle-stop', onClick: () => action(p, 'stop') },
    '-',
    { label: 'Details', icon: 'info', onClick: () => details(p) },
    { label: 'App info on device', icon: 'external-link', onClick: () => action(p, 'info') },
    { label: 'Extract APK', icon: 'download', onClick: () => action(p, 'extract') },
    { label: 'Copy package name', icon: 'copy', onClick: () => api.clipboard.text(p.package).then(() => toast({ type: 'success', title: 'Copied', message: p.package, duration: 1500 })) },
    '-',
    { label: 'Clear data', icon: 'eraser', danger: true, onClick: () => action(p, 'clear') },
    p.disabled ? { label: 'Enable', icon: 'circle-check', onClick: () => action(p, 'enable') } : { label: 'Disable', icon: 'eye-off', danger: true, onClick: () => action(p, 'disable') },
    p.system ? { label: 'Uninstall for user', icon: 'trash-2', danger: true, onClick: () => action(p, 'uninstall-user') } : { label: 'Uninstall', icon: 'trash-2', danger: true, onClick: () => action(p, 'uninstall') },
  ];
}

function render() {
  if (!listEl) return;
  const d = selectedDevice();
  if (!d || d.state !== 'device') {
    countEl.textContent = 'No device selected';
    replace(listEl, h('div.card', { style: { gridColumn: '1 / -1' } }, emptyState({ icon: 'layout-grid', title: 'No device ready', text: 'Select a connected device to manage its apps.', actions: [h('button.btn.primary', { onclick: () => navigate('devices') }, 'Go to devices')] })));
    return;
  }
  if (loading) {
    countEl.textContent = `Loading apps from ${deviceName(d)}…`;
    replace(listEl, Array.from({ length: 12 }, () => h('div.skeleton', { style: { height: '60px', borderRadius: '12px' } })));
    return;
  }
  const list = filtered();
  const user = packages.filter(p => !p.system).length;
  countEl.textContent = `${list.length} shown · ${user} user · ${packages.length - user} system apps on ${deviceName(d)}`;
  if (!list.length) {
    replace(listEl, h('div', { style: { gridColumn: '1 / -1' } }, emptyState({ icon: 'search', title: 'No apps found', text: query ? `Nothing matches “${query}”.` : filter === 'favorites' ? 'Star apps to pin them here.' : 'No apps in this category.' })));
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach(p => frag.appendChild(appRow(p)));
  replace(listEl, frag);
}

async function pickAndInstall() {
  const files = await api.dialog.openFile({ multi: true, title: 'Choose APK files', filters: [{ name: 'Android package', extensions: ['apk'] }] });
  if (files) { await installApks(undefined, files); load(true); }
}

export default {
  id: 'apps', title: 'Apps', icon: 'layout-grid',
  create(root) {
    listEl = h('div.app-list');
    countEl = h('div.sub');
    searchInput = h('input.input', { placeholder: 'Search by name or package…', spellcheck: false, oninput: debounce(() => { query = searchInput.value.trim(); render(); }, 120) });
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Apps'), countEl),
        h('div.actions',
          h('button.btn', { onclick: () => load(true) }, icon('refresh-cw'), 'Refresh'),
          h('button.btn.primary', { onclick: pickAndInstall }, icon('package'), 'Install APK'))),
      h('div.toolbar',
        h('div.input-group', icon('search'), searchInput),
        segmented([['user', 'User', 'smartphone'], ['system', 'System', 'shield-check'], ['all', 'All', 'layers'], ['favorites', 'Favorites', 'star'], ['disabled', 'Disabled', 'eye-off']], filter, (v) => { filter = v; render(); }),
        h('span.grow'),
        tip(h('span.qi', icon('info')), 'Drop APK files anywhere to install')),
      listEl);
    bus.on('selected', () => { packages = []; names = {}; loadedFor = null; if (state.view === 'apps') load(); });
    bus.on('apps-changed', (serial) => { if (serial === state.selected && state.view === 'apps') load(true); });
  },
  show() { load(); setTimeout(() => searchInput.focus(), 50); },
};
