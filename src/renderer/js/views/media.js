// Gallery of screenshots and recordings saved on this computer.
import { h, icon, clear, replace, fmtBytes, timeAgo, fmtDate } from '../lib/dom.js';
import { toast, confirmDialog, segmented, emptyState, showMenu, tip } from '../lib/ui.js';
import { api, state, bus, settings, selectedDevice } from '../state.js';
import { screenshot, launch } from '../actions.js';

let grid, sub, tab = 'image', items = [];

async function load() {
  const dir = tab === 'image' ? settings().screenshotDir : settings().recordDir;
  items = await api.fs.listMedia(dir, tab);
  render();
}

function render() {
  if (!grid) return;
  const dir = tab === 'image' ? settings().screenshotDir : settings().recordDir;
  const total = items.reduce((a, b) => a + b.size, 0);
  sub.textContent = `${items.length} ${tab === 'image' ? 'screenshots' : 'recordings'} · ${fmtBytes(total)} · ${dir}`;
  if (!items.length) {
    replace(grid, h('div.card', { style: { gridColumn: '1 / -1' } }, emptyState(tab === 'image'
      ? { icon: 'images', title: 'No screenshots yet', text: 'Capture the device screen with Ctrl+Shift+S or the camera button.', actions: [h('button.btn.primary', { onclick: () => screenshot().then(load) }, icon('camera'), 'Take screenshot')] }
      : { icon: 'film', title: 'No recordings yet', text: 'Start a recording from a device card or with Ctrl+Shift+R.', actions: [h('button.btn.primary', { onclick: () => launch(undefined, { mode: 'record' }) }, icon('disc'), 'Start recording')] })));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(tile(it));
  replace(grid, frag);
}

function tile(it) {
  const isImg = tab === 'image';
  const audioOnly = /^(m4a|mka|opus|aac|flac|wav)$/.test(it.ext);
  const thumb = isImg
    ? h('img', { src: it.url, loading: 'lazy', alt: '' })
    : audioOnly ? icon('file-audio', '', 40) : h('video', { src: it.url + '#t=0.5', preload: 'metadata', muted: true });
  return h('div.media-item', {
    onclick: () => (isImg || !audioOnly ? lightbox(it) : api.shell.openPath(it.path)),
    oncontextmenu: (e) => { e.preventDefault(); showMenu({ x: e.clientX, y: e.clientY }, menu(it)); },
  },
  h('div.thumb', thumb, !isImg ? h('div.play', icon('play')) : null, h('span.chip.ext', it.ext.toUpperCase())),
  h('div.cap', h('div.n', it.name), h('div.s', `${fmtBytes(it.size)} · ${timeAgo(it.mtime)}`)),
  h('div.over',
    isImg ? tip(h('button.btn.icon.sm', { onclick: (e) => { e.stopPropagation(); copy(it); } }, icon('copy')), 'Copy image') : null,
    tip(h('button.btn.icon.sm', { onclick: (e) => { e.stopPropagation(); api.shell.showItem(it.path); } }, icon('folder-open')), 'Show in folder'),
    tip(h('button.btn.icon.sm', { onclick: (e) => { e.stopPropagation(); remove(it); } }, icon('trash-2')), 'Move to trash')));
}

function menu(it) {
  return [
    { label: 'Open', icon: 'external-link', onClick: () => api.shell.openPath(it.path) },
    tab === 'image' ? { label: 'Copy image', icon: 'copy', onClick: () => copy(it) } : null,
    { label: 'Copy path', icon: 'clipboard', onClick: () => api.clipboard.text(it.path) },
    { label: 'Show in folder', icon: 'folder-open', onClick: () => api.shell.showItem(it.path) },
    '-',
    { label: 'Move to trash', icon: 'trash-2', danger: true, onClick: () => remove(it) },
  ];
}

async function copy(it) {
  const ok = await api.clipboard.image(it.path);
  toast(ok ? { type: 'success', title: 'Image copied to clipboard', duration: 1600 } : { type: 'error', title: 'Could not copy image' });
}

async function remove(it) {
  if (settings().confirmDangerous && !(await confirmDialog({ title: 'Move to trash?', message: it.name, confirm: 'Move to trash', danger: true }))) return;
  const r = await api.shell.trash(it.path);
  if (!r.ok) return toast({ type: 'error', title: 'Could not delete', message: r.message });
  items = items.filter(x => x !== it);
  render();
}

function lightbox(start) {
  let idx = items.indexOf(start);
  const stage = h('div.stage');
  const title = h('div.grow.ellipsis', { style: { fontWeight: 600 } });
  const show = () => {
    const it = items[idx];
    title.textContent = `${it.name}  ·  ${fmtBytes(it.size)}  ·  ${fmtDate(it.mtime)}`;
    replace(stage, tab === 'image' ? h('img', { src: it.url }) : h('video', { src: it.url, controls: true, autoplay: true }));
  };
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowRight' && idx < items.length - 1) { idx++; show(); }
    if (e.key === 'ArrowLeft' && idx > 0) { idx--; show(); }
  };
  const el = h('div.lightbox', { onclick: (e) => { if (e.target === el || e.target === stage) close(); } },
    h('div.bar',
      h('button.btn.icon.sm', { onclick: () => { if (idx > 0) { idx--; show(); } } }, icon('chevron-left')),
      h('button.btn.icon.sm', { onclick: () => { if (idx < items.length - 1) { idx++; show(); } } }, icon('chevron-right')),
      title,
      tab === 'image' ? h('button.btn.sm', { onclick: () => copy(items[idx]) }, icon('copy'), 'Copy') : null,
      h('button.btn.sm', { onclick: () => api.shell.openPath(items[idx].path) }, icon('external-link'), 'Open'),
      h('button.btn.sm', { onclick: () => api.shell.showItem(items[idx].path) }, icon('folder-open'), 'Folder'),
      h('button.btn.icon.sm', { onclick: close }, icon('x'))),
    stage);
  document.body.appendChild(el);
  document.addEventListener('keydown', onKey, true);
  show();
}

export default {
  id: 'media', title: 'Media', icon: 'images',
  create(root) {
    grid = h('div.media-grid');
    sub = h('div.sub');
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Media'), sub),
        h('div.actions',
          segmented([['image', 'Screenshots', 'image'], ['video', 'Recordings', 'film']], tab, (v) => { tab = v; load(); }),
          h('button.btn', { onclick: () => { const dir = tab === 'image' ? settings().screenshotDir : settings().recordDir; api.fs.ensureDir(dir).then(() => api.shell.openPath(dir)); } }, icon('folder-open'), 'Open folder'),
          h('button.btn.primary', { onclick: () => (tab === 'image' ? screenshot().then(load) : launch(undefined, { mode: 'record' })) }, icon(tab === 'image' ? 'camera' : 'disc'), 'Capture'))),
      grid);
    bus.on('media-changed', () => { if (state.view === 'media') load(); });
  },
  show() { load(); },
};
