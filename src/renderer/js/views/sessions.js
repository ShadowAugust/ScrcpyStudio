// Running / finished scrcpy sessions with live logs.
import { h, icon, clear, replace, fmtDuration, fmtDate } from '../lib/dom.js';
import { toast, emptyState, tip } from '../lib/ui.js';
import { api, state, bus } from '../state.js';
import { launch, navigate } from '../actions.js';
import { QUICK_MODES } from '../options.js';

let listEl, logBody, logTitle, logActions, selectedId = null, autoScroll = true, timer = null, headSub;

const statusMeta = {
  starting: ['warn', 'Starting'],
  running: ['live', 'Running'],
  stopped: ['', 'Stopped'],
  failed: ['bad', 'Failed'],
};

function sessionCard(s) {
  const [dotCls, label] = statusMeta[s.status] || ['', s.status];
  const qm = QUICK_MODES.find(m => m.id === s.mode);
  const alive = !s.endedAt;
  return h(`div.card.session-card${s.id === selectedId ? '.selected' : ''}`, { onclick: () => select(s.id), dataset: { id: s.id } },
    h('div.r1', h(`span.dot${dotCls ? '.' + dotCls : ''}`), h('span.n.ellipsis', s.label), h('span.time', { dataset: { started: s.startedAt, ended: s.endedAt || '' } }, fmtDuration((s.endedAt || Date.now()) - s.startedAt))),
    h('div.r2',
      h('span.chip', icon(qm?.icon || (s.mode === 'vcam' ? 'webcam' : s.mode === 'camera' ? 'aperture' : s.mode === 'speaker' ? 'volume-2' : 'cast')), qm?.label || ({ vcam: 'Virtual webcam', camera: 'Camera', speaker: 'Phone speakers' }[s.mode] || s.mode)),
      s.profileName ? h('span.chip', icon('sliders-horizontal'), s.profileName) : null,
      h(`span.chip${s.status === 'failed' ? '.danger' : s.status === 'running' ? '.success' : ''}`, label),
      s.info?.texture ? h('span.chip', icon('scan'), s.info.texture) : null,
      s.recordPath ? h('span.chip.danger', icon('disc'), 'REC') : null),
    s.error && s.status === 'failed' ? h('div.err', s.error) : null,
    h('div.r3',
      alive
        ? h('button.btn.sm.danger', { onclick: (e) => { e.stopPropagation(); api.scrcpy.stop(s.id); } }, icon('square'), 'Stop')
        : h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); relaunch(s); } }, icon('rotate-cw'), 'Relaunch'),
      alive ? tip(h('button.btn.sm.ghost.icon', { onclick: (e) => { e.stopPropagation(); api.scrcpy.stop(s.id, true); } }, icon('x')), 'Force kill') : null,
      s.recordPath ? h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); alive ? api.shell.showItem(s.recordPath) : api.shell.openPath(s.recordPath); } }, icon(alive ? 'folder-open' : 'play'), alive ? 'Folder' : 'Play') : null,
      h('span.grow'),
      !alive ? tip(h('button.btn.sm.ghost.icon', { onclick: async (e) => { e.stopPropagation(); await api.scrcpy.remove(s.id); state.sessions = state.sessions.filter(x => x.id !== s.id); if (selectedId === s.id) selectedId = null; render(); } }, icon('trash-2')), 'Remove') : null));
}

async function relaunch(s) {
  const r = await api.scrcpy.start({ serial: s.serial, args: s.args.slice(2).filter(a => !a.startsWith('--record=')), record: s.recordPath ? { format: s.recordPath.split('.').pop() } : null, mode: s.mode, profileName: s.profileName, label: s.label });
  if (!r.ok) toast({ type: 'error', title: 'Relaunch failed', message: r.error });
  else select(r.session.id);
}

function render() {
  if (!listEl) return;
  const live = state.sessions.filter(s => !s.endedAt).length;
  headSub.textContent = state.sessions.length ? `${live} running · ${state.sessions.length - live} finished` : 'Every scrcpy window you launch appears here';
  if (!state.sessions.length) {
    replace(listEl, h('div.card', emptyState({ icon: 'activity', title: 'No sessions yet', text: 'Launch a mirror from the Devices page or press Ctrl+M.', actions: [h('button.btn.primary', { onclick: () => launch() }, icon('cast'), 'Mirror now')] })));
    selectedId = null;
  } else {
    if (!selectedId || !state.sessions.find(s => s.id === selectedId)) selectedId = state.sessions[0].id;
    replace(listEl, state.sessions.map(sessionCard));
  }
  renderLogHead();
}

function renderLogHead() {
  const s = state.sessions.find(x => x.id === selectedId);
  logTitle.textContent = s ? `Log · ${s.label}` : 'Log';
  replace(logActions,
    s ? tip(h('button.btn.ghost.icon.sm', { onclick: () => api.clipboard.text(s.command.join(' ')).then(() => toast({ type: 'success', title: 'Command copied', duration: 1500 })) }, icon('terminal')), 'Copy command') : null,
    s ? tip(h('button.btn.ghost.icon.sm', { onclick: copyLog }, icon('copy')), 'Copy log') : null,
    s ? tip(h('button.btn.ghost.icon.sm', { onclick: saveLog }, icon('save')), 'Save log') : null,
    h(`button.btn.sm${autoScroll ? '' : '.ghost'}`, { onclick: () => { autoScroll = !autoScroll; renderLogHead(); } }, icon('arrow-down-to-line'), 'Follow'));
}

async function select(id) {
  selectedId = id;
  listEl.querySelectorAll('.session-card').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  renderLogHead();
  const logs = await api.scrcpy.logs(id);
  clear(logBody);
  const s = state.sessions.find(x => x.id === id);
  if (s) logBody.appendChild(h('div.log-line.debug', `$ ${s.command.join(' ')}`));
  logs.forEach(addLine);
  if (!logs.length) logBody.appendChild(h('div.log-line.debug', 'Waiting for output…'));
  logBody.scrollTop = logBody.scrollHeight;
}

function addLine(e) {
  const t = new Date(e.t);
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  logBody.appendChild(h(`div.log-line.${e.level}`, h('span.ts', ts), e.line));
  while (logBody.childElementCount > 2000) logBody.firstChild.remove();
}

async function copyLog() {
  const logs = await api.scrcpy.logs(selectedId);
  await api.clipboard.text(logs.map(l => l.line).join('\n'));
  toast({ type: 'success', title: 'Log copied', duration: 1500 });
}

async function saveLog() {
  const logs = await api.scrcpy.logs(selectedId);
  const file = await api.dialog.saveFile({ defaultPath: `scrcpy-${selectedId}.log`, filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
  if (file) { await api.fs.writeText(file, logs.map(l => `${new Date(l.t).toISOString()} ${l.line}`).join('\n')); toast({ type: 'success', title: 'Log saved', message: file }); }
}

function tick() {
  listEl?.querySelectorAll('.time').forEach(el => {
    if (el.dataset.ended) return;
    el.textContent = fmtDuration(Date.now() - Number(el.dataset.started));
  });
}

export default {
  id: 'sessions', title: 'Sessions', icon: 'activity', flex: true,
  create(root) {
    listEl = h('div.session-list');
    logBody = h('div.log-body');
    logTitle = h('span', 'Log');
    logActions = h('div.actions');
    headSub = h('div.sub');
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Sessions'), headSub),
        h('div.actions',
          h('button.btn', { onclick: async () => { await api.scrcpy.clearEnded(); state.sessions = state.sessions.filter(s => !s.endedAt); render(); } }, icon('trash-2'), 'Clear finished'),
          h('button.btn.danger', { onclick: () => api.scrcpy.stopAll() }, icon('circle-stop'), 'Stop all'))),
      h('div.sessions-layout.fill',
        listEl,
        h('div.card.log-view', h('div.card-head', h('h3', icon('scroll-text'), logTitle), logActions), logBody)));
    bus.on('sessions', () => { const had = listEl.childElementCount; render(); if (!had && selectedId) select(selectedId); });
    bus.on('session-log', (ev) => {
      if (ev.id !== selectedId) return;
      if (logBody.firstChild?.textContent === 'Waiting for output…') logBody.firstChild.remove();
      addLine(ev.entry);
      if (autoScroll) logBody.scrollTop = logBody.scrollHeight;
    });
    render();
  },
  show(id) {
    render();
    if (id || selectedId) select(id || selectedId);
    clearInterval(timer);
    timer = setInterval(tick, 1000);
  },
  hide() { clearInterval(timer); },
};
