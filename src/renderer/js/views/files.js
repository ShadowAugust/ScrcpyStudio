// Remote file manager over adb (browse, upload, download, rename, delete).
import { h, icon, clear, replace, fmtBytes, fmtDate, debounce } from '../lib/dom.js';
import { toast, showMenu, confirmDialog, promptDialog, emptyState, withToast, tip } from '../lib/ui.js';
import { api, state, bus, selectedDevice, settings } from '../state.js';
import { navigate, requireDevice, pushFiles } from '../actions.js';

const PLACES = [
  ['Internal storage', '/sdcard', 'smartphone'],
  ['Download', '/sdcard/Download', 'download'],
  ['Camera', '/sdcard/DCIM', 'camera'],
  ['Screenshots', '/sdcard/Pictures/Screenshots', 'scan'],
  ['Pictures', '/sdcard/Pictures', 'image'],
  ['Movies', '/sdcard/Movies', 'film'],
  ['Music', '/sdcard/Music', 'music'],
  ['Documents', '/sdcard/Documents', 'file-text'],
  ['Android data', '/sdcard/Android', 'folder'],
  ['Temp (adb)', '/data/local/tmp', 'hard-drive'],
  ['Root', '/', 'hard-drive'],
];

let placesEl, crumbsEl, tableEl, statusEl, filterInput;
let cwd = '/sdcard', entries = [], selection = new Set(), anchor = null, sort = { key: 'name', dir: 1 }, showHidden = false, filterText = '', history = [], loading = false, loadedFor = null;

const join = (dir, name) => (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
const parent = (dir) => dir === '/' ? '/' : dir.replace(/\/[^/]+\/?$/, '') || '/';

const EXT_ICON = [
  [/\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i, 'file-image'],
  [/\.(mp4|mkv|webm|avi|mov|3gp)$/i, 'file-video'],
  [/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i, 'file-audio'],
  [/\.(zip|rar|7z|tar|gz|xz|apk|aab|obb)$/i, 'file-archive'],
  [/\.(txt|md|log|json|xml|csv|ini|conf|prop)$/i, 'file-text'],
  [/\.(js|ts|py|sh|java|kt|c|cpp|html|css)$/i, 'file-code'],
];
const fileIcon = (e) => e.dir ? 'folder' : (EXT_ICON.find(([re]) => re.test(e.name))?.[1] || 'file');

async function open(dir, push = true) {
  const d = selectedDevice();
  if (!d || d.state !== 'device') return render();
  if (push && dir !== cwd) history.push(cwd);
  loading = true;
  renderStatus();
  const r = await api.adb.listDir(d.serial, dir);
  loading = false;
  loadedFor = d.serial;
  if (!r.ok) {
    toast({ type: 'error', title: 'Cannot open folder', message: `${dir}: ${r.error}` });
    if (push) history.pop();
    renderStatus();
    return;
  }
  cwd = dir;
  entries = r.entries;
  selection.clear();
  anchor = null;
  render();
}

function visible() {
  const q = filterText.toLowerCase();
  return entries
    .filter(e => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.dir - a.dir) || (sort.key === 'size' ? (a.size - b.size) * sort.dir : sort.key === 'mtime' ? (a.mtime - b.mtime) * sort.dir : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * sort.dir));
}

function renderCrumbs() {
  const parts = cwd.split('/').filter(Boolean);
  const btns = [h('button', { onclick: () => open('/') }, icon('hard-drive'))];
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    const target = acc;
    btns.push(icon('chevron-right'), h('button', { onclick: () => open(target) }, p === 'sdcard' ? 'Internal storage' : p));
  }
  replace(crumbsEl, btns);
  crumbsEl.scrollLeft = crumbsEl.scrollWidth;
  placesEl.querySelectorAll('.place').forEach(el => el.classList.toggle('active', el.dataset.path === cwd));
}

function renderStatus() {
  const sel = entries.filter(e => selection.has(e.name));
  const size = sel.reduce((a, e) => a + (e.dir ? 0 : e.size), 0);
  replace(statusEl,
    loading ? h('span', icon('loader-circle', 'spin', 13), ' Loading…') : h('span', `${visible().length} items`),
    sel.length ? h('span', `${sel.length} selected${size ? ' · ' + fmtBytes(size) : ''}`) : null,
    h('span.grow'),
    h('span.mono', cwd));
}

function render() {
  if (!tableEl) return;
  const d = selectedDevice();
  if (!d || d.state !== 'device') {
    replace(tableEl, emptyState({ icon: 'folder', title: 'No device ready', text: 'Select a connected device to browse its files.', actions: [h('button.btn.primary', { onclick: () => navigate('devices') }, 'Go to devices')] }));
    clear(statusEl);
    return;
  }
  renderCrumbs();
  const list = visible();
  const th = (key, label, cls = '') => h(`th${cls ? '.' + cls : ''}`, { onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : 1 }; render(); } }, label, sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '');
  const rows = list.map((e, idx) => h(`tr.file${selection.has(e.name) ? '.sel' : ''}`, {
    onclick: (ev) => clickRow(ev, e, idx, list),
    ondblclick: () => activate(e),
    oncontextmenu: (ev) => { ev.preventDefault(); if (!selection.has(e.name)) { selection = new Set([e.name]); render(); } showMenu({ x: ev.clientX, y: ev.clientY }, rowMenu(e)); },
  },
  h(`td${e.dir ? '.dir' : ''}`, h('div.fname', icon(fileIcon(e)), h('span.t', e.name))),
  h('td.num', e.dir ? '—' : fmtBytes(e.size)),
  h('td.date', fmtDate(e.mtime)),
  h('td.mono.faint', { style: { fontSize: '11px' } }, e.mode)));

  replace(tableEl, list.length
    ? h('table', h('thead', h('tr', th('name', 'Name'), th('size', 'Size', 'num'), th('mtime', 'Modified'), h('th', 'Mode'))), h('tbody', rows))
    : emptyState({ icon: 'folder-open', title: filterText ? 'No matches' : 'Empty folder', text: filterText ? `Nothing matches “${filterText}”.` : 'Drop files here to upload them.' }));
  renderStatus();
}

function clickRow(ev, e, idx, list) {
  if (ev.shiftKey && anchor != null) {
    const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
    selection = new Set(list.slice(a, b + 1).map(x => x.name));
  } else if (ev.ctrlKey || ev.metaKey) {
    selection.has(e.name) ? selection.delete(e.name) : selection.add(e.name);
    anchor = idx;
  } else {
    selection = new Set([e.name]);
    anchor = idx;
  }
  tableEl.querySelectorAll('tr.file').forEach((tr, i) => tr.classList.toggle('sel', selection.has(list[i].name)));
  renderStatus();
}

async function activate(e) {
  if (e.dir) return open(join(cwd, e.name));
  const d = requireDevice();
  if (!d) return;
  await withToast(`Opening ${e.name}…`, () => api.adb.openRemote(d.serial, join(cwd, e.name)), { success: `Opened ${e.name}`, error: 'Could not open file' });
}

function selectedPaths() {
  return entries.filter(e => selection.has(e.name)).map(e => join(cwd, e.name));
}

function rowMenu(e) {
  const multi = selection.size > 1;
  return [
    !multi ? { label: e.dir ? 'Open folder' : 'Open on PC', icon: e.dir ? 'folder-open' : 'external-link', onClick: () => activate(e) } : null,
    { label: `Download${multi ? ` ${selection.size} items` : ''}`, icon: 'download', onClick: () => download(false) },
    { label: 'Download to…', icon: 'folder-output', onClick: () => download(true) },
    !multi ? { label: 'Rename…', icon: 'pencil', onClick: () => rename(e) } : null,
    !multi ? { label: 'Copy path', icon: 'copy', onClick: () => api.clipboard.text(join(cwd, e.name)).then(() => toast({ type: 'success', title: 'Path copied', duration: 1500 })) } : null,
    !multi && /\.apk$/i.test(e.name) ? { label: 'Install APK', icon: 'package', onClick: () => installRemote(e) } : null,
    '-',
    { label: `Delete${multi ? ` ${selection.size} items` : ''}`, icon: 'trash-2', danger: true, onClick: remove },
  ];
}

async function installRemote(e) {
  const d = requireDevice();
  if (!d) return;
  await withToast(`Installing ${e.name}…`, async () => {
    const r = await api.adb.shell(d.serial, `pm install -r '${join(cwd, e.name).replace(/'/g, `'\\''`)}'`);
    return { ok: /Success/.test(r.stdout), message: (r.stdout + r.stderr).trim() };
  }, { success: `Installed ${e.name}`, error: 'Install failed' });
}

async function download(ask) {
  const d = requireDevice();
  if (!d || !selection.size) return;
  let dir = settings().pullDir;
  if (ask) { dir = await api.dialog.openFolder({ defaultPath: dir, title: 'Download to' }); if (!dir) return; }
  const paths = selectedPaths();
  const r = await withToast(`Downloading ${paths.length} item${paths.length > 1 ? 's' : ''}…`, () => api.adb.pull(d.serial, paths, dir), { success: 'Download complete', error: 'Download failed' });
  if (r) toast({ title: 'Saved to', message: dir, actions: [{ label: 'Open folder', icon: 'folder-open', onClick: () => api.shell.openPath(dir) }] });
}

async function upload(paths) {
  if (!paths) paths = await api.dialog.openFile({ multi: true, title: 'Choose files to upload' });
  if (!paths?.length) return;
  const r = await pushFiles(undefined, paths, cwd);
  if (r) open(cwd, false);
}

async function newFolder() {
  const d = requireDevice();
  if (!d) return;
  const name = await promptDialog({ title: 'New folder', label: `Inside ${cwd}`, placeholder: 'Folder name', confirm: 'Create', icon: 'folder-plus' });
  if (!name) return;
  const r = await api.adb.fileOp(d.serial, 'mkdir', join(cwd, name));
  if (!r.ok) return toast({ type: 'error', title: 'Could not create folder', message: r.message });
  open(cwd, false);
}

async function rename(e) {
  const d = requireDevice();
  if (!d) return;
  const name = await promptDialog({ title: 'Rename', value: e.name, confirm: 'Rename' });
  if (!name || name === e.name) return;
  const r = await api.adb.fileOp(d.serial, 'rename', join(cwd, e.name), join(cwd, name));
  if (!r.ok) return toast({ type: 'error', title: 'Rename failed', message: r.message });
  open(cwd, false);
}

async function remove() {
  const d = requireDevice();
  if (!d || !selection.size) return;
  const paths = selectedPaths();
  if (!(await confirmDialog({ title: `Delete ${paths.length} item${paths.length > 1 ? 's' : ''}?`, message: `This permanently deletes from the device:\n${paths.slice(0, 5).map(p => p.split('/').pop()).join(', ')}${paths.length > 5 ? '…' : ''}`, confirm: 'Delete', danger: true }))) return;
  const r = await api.adb.fileOp(d.serial, 'delete', paths);
  if (!r.ok) toast({ type: 'error', title: 'Delete failed', message: r.message });
  else toast({ type: 'success', title: 'Deleted', message: `${paths.length} item${paths.length > 1 ? 's' : ''}`, duration: 1800 });
  open(cwd, false);
}

function onKey(e) {
  if (state.view !== 'files' || /INPUT|TEXTAREA/.test(e.target.tagName) || document.querySelector('.scrim')) return;
  if (e.key === 'Delete') remove();
  else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); open(parent(cwd)); }
  else if (e.key === 'F2') { const x = entries.find(en => selection.has(en.name)); if (x) rename(x); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selection = new Set(visible().map(x => x.name)); render(); }
  else if (e.key === 'Enter') { const x = entries.find(en => selection.has(en.name)); if (x) activate(x); }
}

export default {
  id: 'files', title: 'Files', icon: 'folder', flex: true,
  create(root) {
    placesEl = h('div.card.places', PLACES.map(([label, path, ic]) => h('div.place', { dataset: { path }, onclick: () => open(path) }, icon(ic), label)));
    crumbsEl = h('div.crumbs');
    tableEl = h('div.file-table');
    statusEl = h('div.status-bar');
    filterInput = h('input.input.sm', { placeholder: 'Filter…', spellcheck: false, oninput: debounce(() => { filterText = filterInput.value.trim(); render(); }, 100) });
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Files'), h('div.sub')),
        h('div.actions',
          h('button.btn', { onclick: newFolder }, icon('folder-plus'), 'New folder'),
          h('button.btn.primary', { onclick: () => upload() }, icon('upload'), 'Upload'))),
      h('div.files-layout.fill',
        placesEl,
        h('div.card.file-pane',
          h('div.card-head', { style: { gap: '6px', padding: '10px 12px' } },
            tip(h('button.btn.ghost.icon.sm', { onclick: () => { const prev = history.pop(); if (prev) open(prev, false); } }, icon('arrow-left')), 'Back'),
            tip(h('button.btn.ghost.icon.sm', { onclick: () => open(parent(cwd)) }, icon('arrow-up')), 'Up (Backspace)'),
            tip(h('button.btn.ghost.icon.sm', { onclick: () => open(cwd, false) }, icon('refresh-cw')), 'Refresh'),
            crumbsEl,
            h('div.input-group', { style: { width: '160px' } }, icon('filter'), filterInput),
            tip(h('button.btn.ghost.icon.sm', { onclick: (e) => { showHidden = !showHidden; e.currentTarget.classList.toggle('primary', showHidden); render(); } }, icon('eye')), 'Show hidden files'),
            tip(h('button.btn.ghost.icon.sm', { onclick: () => download(false) }, icon('download')), 'Download selected'),
            tip(h('button.btn.ghost.icon.sm.danger', { onclick: remove }, icon('trash-2')), 'Delete selected')),
          tableEl, statusEl)));
    document.addEventListener('keydown', onKey);
    bus.on('files-drop', (paths) => upload(paths));
    bus.on('selected', () => { entries = []; loadedFor = null; history = []; if (state.view === 'files') open('/sdcard', false); });
  },
  show() {
    const d = selectedDevice();
    if (d?.serial !== loadedFor) open(cwd || '/sdcard', false); else render();
  },
};
