// Live logcat viewer with level/text/package filters.
import { h, icon, clear, replace, debounce, escapeRegExp } from '../lib/dom.js';
import { toast, selectEl, tip, emptyState } from '../lib/ui.js';
import { api, state, bus, selectedDevice, deviceName } from '../state.js';
import { requireDevice, navigate } from '../actions.js';

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const MAX = 20000;
const RE = /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s(.*)$/;

let body, countEl, startBtn, levelSel, searchInput, pkgInput;
let buffer = [], streamId = null, streamSerial = null, paused = false, follow = true, minLevel = 'V', search = '', regex = false, pids = null, partial = '', pending = [], rafQueued = false;
let offData, offExit;

function parse(line) {
  const m = line.match(RE);
  if (!m) return { raw: line, lv: 'I', msg: line, tag: '', pid: '', ts: '' };
  return { ts: m[1], pid: m[2], tid: m[3], lv: m[4], tag: m[5], msg: m[6] };
}

function matcher() {
  if (!search) return null;
  try { return new RegExp(regex ? search : escapeRegExp(search), 'i'); } catch { return null; }
}

function passes(e, re) {
  if (LEVELS.indexOf(e.lv) < LEVELS.indexOf(minLevel)) return false;
  if (pids && e.pid && !pids.has(e.pid)) return false;
  if (re && !re.test(`${e.tag} ${e.msg}`)) return false;
  return true;
}

function lineEl(e, re) {
  const msg = re ? highlight(e.msg, re) : e.msg;
  return h(`div.lc.${e.lv}`, h('span.ts', e.ts ? e.ts.slice(6) : ''), h('span.lv', e.lv), h('span.tag', { title: e.tag }, e.tag), h('span', msg));
}

function highlight(text, re) {
  const g = new RegExp(re.source, 'gi');
  const frag = document.createDocumentFragment();
  let last = 0, m, guard = 0;
  while ((m = g.exec(text)) && guard++ < 50) {
    if (!m[0]) { g.lastIndex++; continue; }
    frag.append(text.slice(last, m.index), h('mark', m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function rerender() {
  const re = matcher();
  const frag = document.createDocumentFragment();
  const list = buffer.filter(e => passes(e, re));
  for (const e of list.slice(-4000)) frag.appendChild(lineEl(e, re));
  replace(body, frag);
  if (follow) body.scrollTop = body.scrollHeight;
  updateCount(list.length);
}

function updateCount(shown) {
  countEl.textContent = `${buffer.length.toLocaleString()} lines${shown != null && shown !== buffer.length ? ` · ${shown.toLocaleString()} shown` : ''}${streamId ? (paused ? ' · paused' : ' · live') : ''}`;
}

function flush() {
  rafQueued = false;
  if (!pending.length) return;
  const re = matcher();
  const frag = document.createDocumentFragment();
  for (const e of pending) if (passes(e, re)) frag.appendChild(lineEl(e, re));
  pending = [];
  body.appendChild(frag);
  while (body.childElementCount > 4000) body.firstChild.remove();
  if (follow) body.scrollTop = body.scrollHeight;
  updateCount();
}

function onData({ id, data }) {
  if (id !== streamId) return;
  const text = partial + data;
  const lines = text.split(/\r?\n/);
  partial = lines.pop();
  for (const l of lines) {
    if (!l || l.startsWith('--------- beginning of')) continue;
    const e = parse(l);
    buffer.push(e);
    if (!paused) pending.push(e);
  }
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  if (!rafQueued && !paused) { rafQueued = true; requestAnimationFrame(flush); }
}

async function start(clearDevice = false) {
  const d = requireDevice();
  if (!d) return;
  stop();
  buffer = []; pending = []; partial = '';
  clear(body);
  const r = await api.adb.logcat(d.serial, { tail: 1000, clear: clearDevice });
  if (!r.ok) return toast({ type: 'error', title: 'Could not start logcat', message: r.error });
  streamId = r.id;
  streamSerial = d.serial;
  paused = false;
  renderButtons();
}

function stop() {
  if (streamId) api.adb.streamStop(streamId);
  streamId = null;
  renderButtons();
}

function renderButtons() {
  replace(startBtn, streamId
    ? [icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause']
    : [icon('play'), 'Start']);
  startBtn.onclick = () => {
    if (!streamId) return start();
    paused = !paused;
    if (!paused) rerender();
    renderButtons();
  };
  updateCount();
}

async function applyPackage() {
  const pkg = pkgInput.value.trim();
  if (!pkg) { pids = null; rerender(); return; }
  const d = requireDevice();
  if (!d) return;
  const r = await api.adb.shell(d.serial, `pidof ${pkg.replace(/[^\w.]/g, '')}`);
  const list = r.stdout.trim().split(/\s+/).filter(Boolean);
  if (!list.length) { toast({ type: 'warn', title: 'App is not running', message: `${pkg} has no process. Start the app and try again.` }); pids = new Set(['-1']); }
  else pids = new Set(list);
  rerender();
}

async function save() {
  const file = await api.dialog.saveFile({ defaultPath: `logcat-${Date.now()}.txt`, filters: [{ name: 'Text', extensions: ['txt', 'log'] }] });
  if (!file) return;
  const re = matcher();
  await api.fs.writeText(file, buffer.filter(e => passes(e, re)).map(e => e.raw || `${e.ts} ${e.pid} ${e.tid} ${e.lv} ${e.tag}: ${e.msg}`).join('\n'));
  toast({ type: 'success', title: 'Log saved', message: file });
}

export default {
  id: 'logcat', title: 'Logcat', icon: 'scroll-text', flex: true,
  create(root) {
    body = h('div.logcat-body');
    countEl = h('span.faint', { style: { fontSize: '12px' } });
    startBtn = h('button.btn.primary.sm');
    levelSel = selectEl([['V', 'Verbose'], ['D', 'Debug'], ['I', 'Info'], ['W', 'Warning'], ['E', 'Error'], ['F', 'Fatal']], minLevel, (v) => { minLevel = v; rerender(); }, 'sm');
    levelSel.style.width = '120px';
    searchInput = h('input.input.sm', { placeholder: 'Search tag or message…', spellcheck: false, oninput: debounce(() => { search = searchInput.value; rerender(); }, 180) });
    pkgInput = h('input.input.sm.mono', { placeholder: 'package filter', spellcheck: false, onkeydown: (e) => e.key === 'Enter' && applyPackage() });
    const followBtn = h('button.btn.sm', { onclick: () => { follow = !follow; followBtn.classList.toggle('ghost', !follow); if (follow) body.scrollTop = body.scrollHeight; } }, icon('arrow-down-to-line'), 'Follow');
    const regexBtn = tip(h('button.btn.sm.ghost', { onclick: () => { regex = !regex; regexBtn.classList.toggle('ghost', !regex); rerender(); } }, '.*'), 'Regular expression');

    body.addEventListener('scroll', () => {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      if (follow !== atBottom) { follow = atBottom; followBtn.classList.toggle('ghost', !follow); }
    });

    root.append(
      h('div.page-head',
        h('div', h('h1', 'Logcat'), h('div.sub')),
        h('div.actions',
          h('button.btn', { onclick: save }, icon('save'), 'Save'),
          h('button.btn', { onclick: () => start(true) }, icon('trash-2'), 'Clear device log'))),
      h('div.card.logcat.fill',
        h('div.card-head', { style: { gap: '8px', padding: '10px 12px', flexWrap: 'wrap' } },
          startBtn,
          tip(h('button.btn.sm.ghost.icon', { onclick: () => { stop(); } }, icon('square')), 'Stop'),
          tip(h('button.btn.sm.ghost.icon', { onclick: () => { buffer = []; clear(body); updateCount(); } }, icon('eraser')), 'Clear view'),
          levelSel,
          h('div.input-group', { style: { width: '260px' } }, icon('search'), searchInput),
          regexBtn,
          h('div.input-group', { style: { width: '200px' } }, icon('package'), pkgInput),
          tip(h('button.btn.sm.ghost.icon', { onclick: applyPackage }, icon('filter')), 'Filter by running app'),
          h('span.grow'), countEl, followBtn),
        body));
    offData = api.on.streamData(onData);
    offExit = api.on.streamExit(({ id }) => { if (id === streamId) { streamId = null; renderButtons(); } });
    bus.on('selected', (d) => { if (streamId && d?.serial !== streamSerial) { stop(); if (state.view === 'logcat') start(); } });
    renderButtons();
  },
  show() {
    const d = selectedDevice();
    if (!streamId && d?.state === 'device') start();
    else if (!d) replace(body, emptyState({ icon: 'scroll-text', title: 'No device ready', text: 'Select a connected device to stream its logs.', actions: [h('button.btn.primary', { onclick: () => navigate('devices') }, 'Go to devices')] }));
  },
};
