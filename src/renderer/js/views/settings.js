// Application settings: appearance, tools, folders, behaviour, data.
import { h, icon, replace } from '../lib/dom.js';
import { toast, switchEl, segmented, selectEl, confirmDialog, withToast, tip, infoTip } from '../lib/ui.js';
import { api, state, bus, settings, saveSettings, saveConfig } from '../state.js';
import { updateCard } from '../updates.js';

const ACCENTS = ['#7c5cff', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7'];

let body;

const line = (title, desc, control) => h('div.setting-line', h('div.l', h('div.t', title, infoTip(desc))), h('div.c', control));

function pathControl(key, { folder = false, placeholder = '' } = {}) {
  const input = h('input.input.sm.mono', { value: settings()[key] || '', placeholder, spellcheck: false, onchange: () => save(key, input.value.trim()) });
  return h('div.path-input', input,
    tip(h('button.btn.sm.icon', { onclick: async () => {
      const r = folder ? await api.dialog.openFolder({ defaultPath: input.value }) : (await api.dialog.openFile({ filters: api.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : undefined }))?.[0];
      if (r) { input.value = r; save(key, r); }
    } }, icon(folder ? 'folder-open' : 'file')), 'Browse'),
    folder ? tip(h('button.btn.sm.icon', { onclick: () => api.fs.ensureDir(input.value).then(() => api.shell.openPath(input.value)) }, icon('external-link')), 'Open') : null);
}

async function save(key, value) {
  await saveSettings({ [key]: value });
  if (key === 'scrcpyPath' || key === 'adbPath') redetect();
}

async function redetect() {
  const info = await withToast('Detecting scrcpy and adb…', () => api.app.resolveTools(), {
    success: (i) => i.scrcpy && i.adb ? `Found scrcpy ${i.scrcpyVersion || ''} and adb ${i.adbVersion || ''}` : 'Detection finished — something is missing',
  });
  if (info) { bus.emit('tools', info); render(); }
}

function render() {
  const s = settings();
  const t = state.info.tools;
  const toolRow = (name, path, ver) => h('div.row', { style: { gap: '8px' } },
    h(`span.dot.${path ? 'ok' : 'bad'}`), h('b', name), h('span.chip', ver ? `v${ver}` : 'not found'), h('span.mono.faint.ellipsis', { style: { fontSize: '11.5px', flex: 1 } }, path || '—'));

  replace(body,
    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('palette'), 'Appearance')),
      h('div.card-body',
        line('Theme', 'Follow your system or force a theme', segmented([['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'monitor']], s.theme, (v) => saveSettings({ theme: v }))),
        line('Accent color', 'Used for highlights and buttons', h('div.row', { style: { gap: '10px' } },
          h('div.swatches', ACCENTS.map(c => h(`div.swatch${s.accent === c ? '.active' : ''}`, { style: { background: c }, onclick: () => { saveSettings({ accent: c }).then(render); } }))),
          h('input.color', { type: 'color', value: s.accent, oninput: (e) => saveSettings({ accent: e.target.value }) }))),
        line('Reduce motion', 'Disable animations and transitions', switchEl(s.reduceMotion, (v) => saveSettings({ reduceMotion: v }))))),

    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('wrench'), 'scrcpy & adb'), h('div.actions',
        h('button.btn.sm', { onclick: redetect }, icon('radar'), 'Re-detect'),
        h('button.btn.sm', { onclick: () => api.shell.openExternal('https://github.com/Genymobile/scrcpy/releases/latest') }, icon('external-link'), 'Get scrcpy'))),
      h('div.card-body',
        h('div.col', { style: { padding: '12px 0', gap: '8px' } }, toolRow('scrcpy', t.scrcpy, t.scrcpyVersion), toolRow('adb', t.adb, t.adbVersion)),
        line('scrcpy executable', 'Leave empty to auto-detect (PATH, winget, scoop, chocolatey…)', pathControl('scrcpyPath', { placeholder: 'auto' })),
        line('adb executable', 'Empty = the adb bundled next to scrcpy, or the one on PATH', pathControl('adbPath', { placeholder: 'auto' })),
        line('adb server', 'Fixes most "offline" or stuck device issues', h('div.row', { style: { gap: '6px' } },
          h('button.btn.sm', { onclick: () => withToast('Restarting adb server…', () => api.adb.restartServer(), { success: 'adb server restarted' }) }, icon('refresh-cw'), 'Restart'),
          h('button.btn.sm', { onclick: () => api.adb.refresh() }, icon('rotate-cw'), 'Rescan devices'))),
        line('Device polling', 'How often the device list refreshes', selectEl([['1000', '1 second'], ['2000', '2 seconds'], ['4000', '4 seconds'], ['8000', '8 seconds']], String(s.pollInterval), (v) => saveSettings({ pollInterval: Number(v) }), 'sm')))),

    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('folder'), 'Files & folders')),
      h('div.card-body',
        line('Screenshots', 'Where captured screenshots are saved', pathControl('screenshotDir', { folder: true })),
        line('Recordings', 'Where screen recordings are saved', pathControl('recordDir', { folder: true })),
        line('Downloads', 'Default folder for files pulled from the device', pathControl('pullDir', { folder: true })),
        line('Recording format', 'MKV survives crashes; MP4 is the most compatible', segmented([['mp4', 'MP4'], ['mkv', 'MKV']], s.recordFormat, (v) => saveSettings({ recordFormat: v }))),
        line('Copy screenshots to clipboard', 'Automatically after each capture', switchEl(s.screenshotToClipboard, (v) => saveSettings({ screenshotToClipboard: v }))))),

    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('sliders-horizontal'), 'Behavior')),
      h('div.card-body',
        line('Name scrcpy windows after the device', 'Adds --window-title with the device name', switchEl(s.windowTitleFromAlias, (v) => saveSettings({ windowTitleFromAlias: v }))),
        line('Reconnect wireless devices on start', 'Tries your recent Wi-Fi devices when the app opens', switchEl(s.autoReconnect, (v) => saveSettings({ autoReconnect: v }))),
        line('Close to tray', 'Keep running in the system tray when the window is closed', switchEl(s.closeToTray, (v) => saveSettings({ closeToTray: v }))),
        line('Stop sessions on exit', 'Close all scrcpy windows when quitting', switchEl(s.stopSessionsOnExit, (v) => saveSettings({ stopSessionsOnExit: v }))),
        line('Confirm dangerous actions', 'Ask before reboot, uninstall, delete…', switchEl(s.confirmDangerous, (v) => saveSettings({ confirmDangerous: v }))),
        line('Desktop notifications', 'When devices connect or recordings finish (while unfocused)', switchEl(s.notifications, (v) => saveSettings({ notifications: v }))))),

    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('keyboard'), 'Keyboard shortcuts')),
      h('div.card-body', h('div.kv', { style: { gridTemplateColumns: '1fr auto', padding: '6px 0' } },
        ...[['Command palette', 'Ctrl K'], ['Mirror selected device', 'Ctrl M'], ['Record selected device', 'Ctrl Shift R'], ['Screenshot', 'Ctrl Shift S'], ['Navigate pages', 'Ctrl 1…9'], ['Settings', 'Ctrl ,'], ['Refresh devices', 'F5']].flatMap(([a, k]) =>
          [h('div', { style: { color: 'var(--text)', fontSize: '13px' } }, a), h('div', { style: { textAlign: 'right' } }, h('span.kbd', ...k.split(' ').map(x => h('span', x))))])),
      h('div.hint', { style: { paddingBottom: '12px' } }, 'Inside a scrcpy window: Alt+F fullscreen · Alt+H home · Alt+B back · Alt+S app switch · Alt+O screen off · Alt+R rotate · Alt+Shift+V paste text · drag & drop APKs to install.'))),

    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('save'), 'Data')),
      h('div.card-body',
        line('Export settings', 'Profiles, device names, wireless history and preferences', h('button.btn.sm', { onclick: exportData }, icon('download'), 'Export…')),
        line('Import settings', 'Replaces your current configuration', h('button.btn.sm', { onclick: importData }, icon('upload'), 'Import…')),
        line('Reset everything', 'Restore defaults. Your media files are kept.', h('button.btn.sm.danger', { onclick: resetData }, icon('trash-2'), 'Reset')))),

    updateCard(),
    h('div.card.settings-card',
      h('div.card-head', h('h3', icon('info'), 'About')),
      h('div.card-body', { style: { padding: '16px 18px' } },
        h('div.row', { style: { gap: '14px' } },
          h('img', { src: 'icon.png', style: { width: '52px', height: '52px', borderRadius: '14px' } }),
          h('div.grow',
            h('div', { style: { fontWeight: 700, fontSize: '15px' } }, `Scrcpy Studio ${state.info.version}`),
            h('div.faint', { style: { fontSize: '12px' } }, `Electron ${state.info.electron} · Chromium ${state.info.chrome} · ${state.info.platform} ${state.info.arch}`),
            h('div.faint', { style: { fontSize: '12px' } }, 'A GUI for scrcpy by Genymobile (Apache 2.0). Icons by Lucide.')),
          h('button.btn.sm', { onclick: () => api.shell.openExternal('https://github.com/Genymobile/scrcpy') }, icon('external-link'), 'scrcpy on GitHub'),
          h('button.btn.sm', { onclick: () => api.shell.openPath(state.info.userData) }, icon('folder-open'), 'Config folder')))));
}

async function exportData() {
  const file = await api.dialog.saveFile({ defaultPath: 'scrcpy-studio-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!file) return;
  const { window: _w, ...data } = state.config;
  await api.fs.writeText(file, JSON.stringify(data, null, 2));
  toast({ type: 'success', title: 'Settings exported', message: file });
}

async function importData() {
  const files = await api.dialog.openFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!files) return;
  try {
    const data = JSON.parse(await api.fs.readText(files[0]));
    if (typeof data !== 'object' || !data.settings) throw new Error('Not a Scrcpy Studio settings file');
    if (!(await confirmDialog({ title: 'Import settings?', message: 'Your current configuration will be replaced.', confirm: 'Import' }))) return;
    state.config = await api.store.replace(data);
    bus.emit('config', state.config);
    render();
    toast({ type: 'success', title: 'Settings imported' });
  } catch (e) { toast({ type: 'error', title: 'Import failed', message: e.message }); }
}

async function resetData() {
  if (!(await confirmDialog({ title: 'Reset all settings?', message: 'Profiles, device names and preferences will be deleted.', confirm: 'Reset', danger: true }))) return;
  state.config = await api.store.reset();
  bus.emit('config', state.config);
  render();
  toast({ type: 'success', title: 'Settings reset' });
}

export default {
  id: 'settings', title: 'Settings', icon: 'settings',
  create(root) {
    body = h('div.settings-layout');
    root.append(h('div.page-head', h('div', h('h1', 'Settings'), h('div.sub'))), body);
    bus.on('config', () => { if (state.view === 'settings' && !document.activeElement?.matches('input')) render(); });
  },
  show() { render(); },
};
