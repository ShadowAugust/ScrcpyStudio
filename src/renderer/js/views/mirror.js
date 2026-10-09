// Mirroring profiles: a full scrcpy option editor with live command preview.
import { h, icon, clear, replace, debounce, quoteArg } from '../lib/dom.js';
import { toast, showMenu, promptDialog, confirmDialog, switchEl, selectEl, tip, infoTip } from '../lib/ui.js';
import { api, state, bus, allProfiles, getProfile, saveConfig, selectedDevice, deviceName, settings } from '../state.js';
import { SECTIONS, OPTIONS, QUICK_MODES } from '../options.js';
import { buildArgs, isSet, isActive, validate, versionAtLeast } from '../command.js';
import { launch, requireDevice } from '../actions.js';

let root, listEl, headEl, tabsEl, scrollEl, previewEl, launchBtn, modeBtn;
let editingId = null;
let values = {};
let section = 'all';
let query = '';
let mode = 'mirror';

const version = () => state.info?.tools?.scrcpyVersion;
const current = () => getProfile(editingId);

function newId() { return 'p-' + Math.random().toString(36).slice(2, 9); }

// ------------------------------------------------------------------ profile list
function renderList() {
  const def = state.config.activeProfileId;
  replace(listEl,
    allProfiles().map(p => h(`div.profile-item${p.id === editingId ? '.active' : ''}`, {
      onclick: () => selectProfile(p.id),
      oncontextmenu: (e) => { e.preventDefault(); showMenu({ x: e.clientX, y: e.clientY }, profileMenu(p)); },
    },
    h('div.ic', icon(p.icon || 'sliders-horizontal')),
    h('div.grow', { style: { minWidth: 0 } },
      h('div.n', h('span.ellipsis', p.name), p.id === def ? h('span.badge', 'Default') : null, p.builtin ? null : h('span.chip', { style: { height: '18px', fontSize: '10px', padding: '0 6px' } }, 'Custom')),
      h('div.d', p.description || summarize(p.options))))));
}

function summarize(opts) {
  const n = Object.keys(opts || {}).length;
  return n ? `${n} customized option${n > 1 ? 's' : ''}` : 'scrcpy defaults';
}

function profileMenu(p) {
  return [
    { label: 'Set as default', icon: 'star', onClick: () => setDefault(p.id) },
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicate(p) },
    !p.builtin ? { label: 'Rename…', icon: 'pencil', onClick: () => rename(p) } : null,
    { label: 'Export…', icon: 'download', onClick: () => exportProfile(p) },
    !p.builtin ? '-' : null,
    !p.builtin ? { label: 'Delete', icon: 'trash-2', danger: true, onClick: () => remove(p) } : null,
  ];
}

function selectProfile(id) {
  editingId = id;
  values = { ...(current().options || {}) };
  renderAll();
}

async function setDefault(id) {
  await saveConfig({ activeProfileId: id });
  toast({ type: 'success', title: 'Default profile updated', message: getProfile(id).name, duration: 2000 });
  renderList(); renderHead();
}

async function duplicate(p, silent) {
  const copy = { id: newId(), name: `${p.name} copy`, icon: p.icon || 'sliders-horizontal', description: p.description || '', options: { ...(p.id === editingId ? values : p.options) } };
  await saveConfig({ profiles: [...(state.config.profiles || []), copy] });
  if (!silent) toast({ type: 'success', title: 'Profile duplicated', message: copy.name, duration: 2000 });
  editingId = copy.id;
  values = { ...copy.options };
  renderAll();
  return copy;
}

async function rename(p) {
  const name = await promptDialog({ title: 'Rename profile', label: 'Name', value: p.name });
  if (!name) return;
  const description = await promptDialog({ title: 'Profile description', label: 'Short description (optional)', value: p.description || '', confirm: 'Save' });
  await saveConfig({ profiles: state.config.profiles.map(x => x.id === p.id ? { ...x, name, description: description ?? x.description } : x) });
  renderAll();
}

async function remove(p) {
  if (!(await confirmDialog({ title: `Delete "${p.name}"?`, message: 'This profile will be permanently removed.', confirm: 'Delete', danger: true }))) return;
  const patch = { profiles: state.config.profiles.filter(x => x.id !== p.id) };
  if (state.config.activeProfileId === p.id) patch.activeProfileId = 'builtin-balanced';
  await saveConfig(patch);
  if (editingId === p.id) selectProfile(patch.activeProfileId || state.config.activeProfileId);
  else renderList();
}

async function exportProfile(p) {
  const file = await api.dialog.saveFile({ defaultPath: `${p.name.replace(/[^\w-]+/g, '_')}.scrcpy-profile.json`, filters: [{ name: 'Profile', extensions: ['json'] }] });
  if (!file) return;
  const data = { name: p.name, description: p.description, icon: p.icon, options: p.id === editingId ? values : p.options, app: 'scrcpy-studio' };
  await api.fs.writeText(file, JSON.stringify(data, null, 2));
  toast({ type: 'success', title: 'Profile exported', message: file });
}

async function importProfiles() {
  const files = await api.dialog.openFile({ multi: true, filters: [{ name: 'Profile', extensions: ['json'] }] });
  if (!files) return;
  const added = [];
  for (const f of files) {
    try {
      const data = JSON.parse(await api.fs.readText(f));
      for (const p of [].concat(data)) {
        if (!p || typeof p.options !== 'object') continue;
        added.push({ id: newId(), name: String(p.name || 'Imported'), description: String(p.description || ''), icon: p.icon || 'sliders-horizontal', options: p.options });
      }
    } catch (e) { toast({ type: 'error', title: 'Import failed', message: `${f}: ${e.message}` }); }
  }
  if (!added.length) return;
  await saveConfig({ profiles: [...(state.config.profiles || []), ...added] });
  toast({ type: 'success', title: `Imported ${added.length} profile${added.length > 1 ? 's' : ''}` });
  selectProfile(added[0].id);
}

async function createProfile() {
  const name = await promptDialog({ title: 'New profile', label: 'Name', placeholder: 'My setup', confirm: 'Create', icon: 'plus' });
  if (!name) return;
  const p = { id: newId(), name, description: '', icon: 'sliders-horizontal', options: {} };
  await saveConfig({ profiles: [...(state.config.profiles || []), p] });
  selectProfile(p.id);
}

// ------------------------------------------------------------------ editing
const persist = debounce(async () => {
  const p = current();
  if (p.builtin) return;
  await saveConfig({ profiles: state.config.profiles.map(x => x.id === p.id ? { ...x, options: { ...values } } : x) });
  renderList();
}, 350);

async function setValue(key, val) {
  const opt = OPTIONS.find(o => o.key === key);
  if (val === '' || val == null || (opt.type === 'bool' && !val)) delete values[key];
  else values[key] = val;
  if (current().builtin) {
    const base = current();
    const copy = { id: newId(), name: `${base.name} (custom)`, icon: base.icon, description: base.description, options: { ...values } };
    await saveConfig({ profiles: [...(state.config.profiles || []), copy] });
    editingId = copy.id;
    toast({ title: 'Saved as a new profile', message: `Built-in profiles are read-only, so your changes live in "${copy.name}".`, duration: 4000 });
    renderAll();
    return;
  }
  persist();
  refreshMeta();
}

function suggestionsFor(opt) {
  const cache = state.queryCache[state.selected] || {};
  let list = [...(opt.suggestions || []).map(s => [s, ''])];
  if (opt.dynamic === 'videoEncoders') list = (cache.encoders || []).filter(e => e.kind === 'video' && (!values['video-codec'] || e.codec === values['video-codec'] || (!values['video-codec'] && e.codec === 'h264'))).map(e => [e.encoder, `${e.codec}${e.hw ? ' · hw' : e.sw ? ' · sw' : ''}`]);
  if (opt.dynamic === 'audioEncoders') list = (cache.encoders || []).filter(e => e.kind === 'audio' && (!values['audio-codec'] || e.codec === values['audio-codec'])).map(e => [e.encoder, e.codec]);
  if (opt.dynamic === 'displays') list = (cache.displays || []).map(d => [d.id, d.size || '']);
  if (opt.dynamic === 'cameras') list = (cache.cameras || []).map(c => [c.id, `${c.facing}${c.size ? ' · ' + c.size : ''}`]);
  if (opt.dynamic === 'cameraSizes') {
    const cams = cache.cameras || [];
    const sizes = new Set();
    for (const c of cams) if (!values['camera-id'] || c.id === values['camera-id']) c.sizes.forEach(s => sizes.add(s));
    if (sizes.size) list = [...sizes].map(s => [s, '']);
  }
  if (opt.dynamic === 'apps') list = (cache.apps || []).map(a => [a.package, a.name]);
  return list;
}

function control(opt) {
  const v = values[opt.key];
  switch (opt.type) {
    case 'bool':
      return switchEl(v === true, (on) => setValue(opt.key, on));
    case 'select':
      return selectEl(opt.choices, v ?? opt.default ?? '', (x) => setValue(opt.key, x === String(opt.default ?? '') ? '' : x), 'sm');
    case 'color': {
      const input = h('input.color', { type: 'color', value: v || '#222222', oninput: () => setValue(opt.key, input.value) });
      return h('div.row', { style: { gap: '6px' } }, input, h('span.mono.faint', { style: { fontSize: '12px', minWidth: '64px' } }, v || 'default'));
    }
    case 'number':
    case 'combo':
    case 'text': {
      const listId = `dl-${opt.key}`;
      const sugg = opt.type === 'combo' ? suggestionsFor(opt) : [];
      const input = h(`input.input.sm${opt.mono ? '.mono' : ''}`, {
        type: opt.type === 'number' ? 'number' : 'text',
        value: v ?? '', placeholder: opt.placeholder || '', min: opt.min, max: opt.max, step: opt.step,
        spellcheck: false,
        onchange: () => setValue(opt.key, opt.type === 'number' && input.value !== '' ? Number(input.value) : input.value.trim()),
      });
      if (sugg.length) input.setAttribute('list', listId);
      return h('div.input-group', { style: { width: '100%' } }, input,
        opt.unit ? h('span.suffix', opt.unit) : null,
        sugg.length ? h('datalist', { id: listId }, sugg.map(([val, label]) => h('option', { value: val, label }))) : null);
    }
  }
  return h('span');
}

function row(opt) {
  const changed = isSet(opt, values[opt.key]);
  const unsupported = !versionAtLeast(version(), opt.minVersion);
  const inactive = !isActive(opt, values);
  const flag = opt.gui ? null : `--${opt.key}`;
  return h(`div.opt-row${opt.type === 'bool' ? '.bool' : ''}${changed ? '.changed' : ''}${unsupported || inactive ? '.disabled' : ''}`, { dataset: { key: opt.key } },
    h('div.l',
      h('div.t', opt.label, infoTip([opt.desc, flag].filter(Boolean).join('\n')), unsupported ? h('span.chip.warn', { style: { height: '18px', fontSize: '10px' } }, `${opt.minVersion}+`) : null),
      inactive ? h('div.d.warn', `Only applies with ${opt.whenHint || OPTIONS.find(o => o.key === opt.requires)?.label || opt.requires}`) : null),
    h('div.c',
      changed && opt.type !== 'bool' ? tip(h('button.btn.ghost.icon.sm.reset', { onclick: () => { setValue(opt.key, ''); renderOptions(); } }, icon('undo-2')), 'Reset to default') : null,
      control(opt)));
}

function renderOptions() {
  const q = query.toLowerCase();
  const match = (o) => !q || `${o.label} ${o.key} ${o.desc || ''}`.toLowerCase().includes(q);
  const warnings = validate(values);
  clear(scrollEl);
  if (warnings.length) {
    scrollEl.appendChild(h('div.banner', icon('triangle-alert'), h('div.grow', warnings.map(w => h('div', { style: { fontSize: '12.5px' } }, w)))));
  }
  let any = false;
  for (const s of SECTIONS) {
    if (section !== 'all' && section !== s.id && !q) continue;
    const opts = OPTIONS.filter(o => o.section === s.id && match(o) && (o.key !== 'v4l2-sink' || api.platform === 'linux'));
    if (!opts.length) continue;
    any = true;
    scrollEl.appendChild(h('div.opt-section',
      h('h4', icon(s.icon), s.label,
        s.id === 'video' || s.id === 'camera' || s.id === 'device' || s.id === 'audio'
          ? h('button.btn.ghost.sm', { style: { marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }, onclick: detect }, icon('radar'), 'Detect from device') : null),
      h('div.opt-list', opts.map(row))));
  }
  if (!any) scrollEl.appendChild(h('div.empty', h('p', `No options match “${query}”.`)));
}

function renderTabs() {
  const counts = {};
  for (const o of OPTIONS) if (isSet(o, values[o.key])) counts[o.section] = (counts[o.section] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  replace(tabsEl,
    h(`button${section === 'all' ? '.active' : ''}`, { onclick: () => { section = 'all'; renderTabs(); renderOptions(); scrollEl.scrollTop = 0; } }, icon('layers'), 'All', total ? h('span.badge', total) : null),
    SECTIONS.map(s => h(`button${section === s.id ? '.active' : ''}`, { onclick: () => { section = s.id; renderTabs(); renderOptions(); scrollEl.scrollTop = 0; } },
      icon(s.icon), s.label, counts[s.id] ? h('span.badge', counts[s.id]) : null)));
}

function renderHead() {
  const p = current();
  const isDefault = state.config.activeProfileId === p.id;
  const search = h('input.input.sm', { placeholder: 'Search options…', value: query, spellcheck: false, oninput: debounce(() => { query = search.value.trim(); renderOptions(); }, 120) });
  replace(headEl,
    h('div.title-row',
      h('div.row', { style: { gap: '10px' } }, h('h1', p.name), p.builtin ? tip(h('span.chip', icon('lock'), 'Built-in'), 'Editing an option creates your own copy') : null),
      h('div.actions',
        h('div.input-group', { style: { width: '220px' } }, icon('search'), search),
        isDefault ? h('span.chip.accent', icon('star'), 'Default') : h('button.btn.sm', { onclick: () => setDefault(p.id) }, icon('star'), 'Set default'),
        h('button.btn.sm.icon', { dataset: { tip: 'Profile actions' }, onclick: (e) => showMenu(e.currentTarget, profileMenu(p), { align: 'right' }) }, icon('ellipsis-vertical')))),
    tabsEl);
}

function refreshPreview() {
  const d = selectedDevice();
  const qm = QUICK_MODES.find(m => m.id === mode);
  const v = { ...values, ...(qm.overlay || {}) };
  if (qm.otg) v.otg = true;
  const title = d && settings().windowTitleFromAlias ? deviceName(d) : null;
  const { args, record } = buildArgs(v, { title, version: version() });
  const parts = [h('span.bin', 'scrcpy')];
  if (d) parts.push(' ', h('span.flag', '-s'), ' ', h('span.val', d.serial));
  for (const a of args) {
    const m = a.match(/^(--[\w-]+)(=(.*))?$/);
    parts.push(' ');
    if (m) parts.push(h('span.flag', m[1]), m[2] ? h('span', '=', h('span.val', quoteArg(m[3]))) : null);
    else parts.push(quoteArg(a));
  }
  if (record) parts.push(' ', h('span.flag', '--record'), '=', h('span.val', `<recordings>/…${record.format ? '.' + record.format : ''}`));
  replace(previewEl.querySelector('.txt'), parts);
  previewEl.dataset.cmd = previewEl.querySelector('.txt').textContent;
  launchBtn.disabled = !d || d.state !== 'device';
  replace(launchBtn, icon(qm.icon), d ? `${qm.id === 'mirror' ? 'Launch' : qm.label} · ${deviceName(d)}` : 'No device');
  replace(modeBtn, icon(qm.icon), qm.label, icon('chevron-down'));
}

function refreshMeta() {
  renderTabs();
  refreshPreview();
  scrollEl.querySelectorAll('.opt-row').forEach(el => {
    const opt = OPTIONS.find(o => o.key === el.dataset.key);
    el.classList.toggle('changed', isSet(opt, values[opt.key]));
    el.classList.toggle('disabled', !isActive(opt, values) || !versionAtLeast(version(), opt.minVersion));
  });
  const w = validate(values);
  const banner = scrollEl.querySelector('.banner:not(.info)');
  if (w.length || banner) renderOptions();
}

function renderAll() {
  renderList();
  renderHead();
  renderTabs();
  renderOptions();
  refreshPreview();
}

async function detect() {
  const d = requireDevice();
  if (!d) return;
  const t = toast({ type: 'loading', title: `Detecting capabilities of ${deviceName(d)}…`, message: 'Encoders, displays, cameras and apps', duration: 0 });
  const [enc, disp, cams, apps] = await Promise.all([
    api.scrcpy.query(d.serial, 'encoders'), api.scrcpy.query(d.serial, 'displays'),
    api.scrcpy.query(d.serial, 'camera-sizes'), api.scrcpy.query(d.serial, 'apps'),
  ]);
  state.queryCache[d.serial] = { encoders: enc.items || [], displays: disp.items || [], cameras: cams.items || [], apps: apps.items || [] };
  const c = state.queryCache[d.serial];
  t.update({ type: 'success', title: 'Device capabilities detected', message: `${c.encoders.length} encoders · ${c.displays.length} displays · ${c.cameras.length} cameras · ${c.apps.length} apps` });
  renderOptions();
}

export default {
  id: 'mirror', title: 'Mirroring', icon: 'sliders-horizontal', flush: true,
  create(r) {
    root = r;
    listEl = h('div.list');
    headEl = h('div.editor-head');
    tabsEl = h('div.tabs');
    scrollEl = h('div.editor-scroll');
    previewEl = h('div.cmd-preview', icon('terminal'), h('div.txt'),
      tip(h('button.btn.ghost.icon.sm', { onclick: () => { api.clipboard.text(previewEl.dataset.cmd); toast({ type: 'success', title: 'Command copied', duration: 1600 }); } }, icon('copy')), 'Copy command'));
    modeBtn = h('button.btn', { onclick: (e) => showMenu(e.currentTarget, [{ heading: 'Launch mode' }, ...QUICK_MODES.map(m => ({ label: m.label, icon: m.icon, checked: m.id === mode, hint: '', onClick: () => { mode = m.id; refreshPreview(); } }))]) });
    launchBtn = h('button.btn.primary', { onclick: () => launch(undefined, { profileId: editingId, mode }) });

    root.appendChild(h('div.mirror-layout',
      h('div.profiles-col',
        h('div.head', h('h2', 'Profiles'), h('button.btn.ghost.icon.sm', { style: { marginLeft: 'auto' }, dataset: { tip: 'New profile' }, onclick: createProfile }, icon('plus'))),
        listEl,
        h('div.foot',
          h('button.btn.sm', { onclick: importProfiles }, icon('upload'), 'Import'),
          h('button.btn.sm', { onclick: () => exportProfile(current()) }, icon('download'), 'Export'))),
      h('div.editor-col', headEl, scrollEl, h('div.launch-bar', previewEl, modeBtn, launchBtn))));

    selectProfile(state.config.activeProfileId);
    bus.on('selected', refreshPreview);
    bus.on('devices', refreshPreview);
  },
  show() {
    if (!allProfiles().find(p => p.id === editingId)) selectProfile(state.config.activeProfileId);
    else { renderList(); refreshPreview(); }
  },
};
