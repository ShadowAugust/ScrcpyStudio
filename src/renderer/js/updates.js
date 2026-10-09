// App updates (GitHub Releases): startup suggestion toast, manual check, and the
// Settings → Updates card.
import { h, icon, replace } from './lib/dom.js';
import { toast, switchEl } from './lib/ui.js';
import { api, settings, saveSettings } from './state.js';
import { navigate } from './actions.js';

let st = null;          // last status from the main process
let live = null;        // the toast currently showing update progress
let cardEl = null;
let suggested = null;   // version already suggested this session

const MODE_HINT = {
  nsis: 'Downloads in the background, then installs and restarts.',
  portable: 'Downloads the new portable exe and swaps it in place on restart.',
  manual: 'This copy is not installed, so updates open the download page.',
};

const fmtSize = (n) => (n ? `${(n / 1048576).toFixed(0)} MB` : '');

function notesPreview(md) {
  const lines = String(md || '').split(/\r?\n/).map(l => l.replace(/^#+\s*|\*\*/g, '').trim()).filter(Boolean);
  return lines.slice(0, 4).join(' · ').slice(0, 220);
}

export async function startUpdate() {
  if (!st?.latest) return;
  if (st.mode === 'manual') { api.shell.openExternal(st.latest.url); return; }
  const r = await api.update.download();
  if (r.status === 'available' && r.error) toast({ type: 'error', title: 'Update failed', message: r.error });
}

export function restartToUpdate() { api.update.install(); }

export async function checkNow() {
  const t = toast({ type: 'loading', title: 'Checking for updates…', duration: 0 });
  const r = await api.update.check();
  t.close();
  if (r.status === 'none') toast({ type: 'success', title: 'You are up to date', message: `Scrcpy Studio ${r.current} is the latest version.` });
  else if (r.status === 'error') toast({ type: 'error', title: 'Could not check for updates', message: r.error });
  else if (r.status === 'available') suggest(r, true);
}

function suggest(s, force = false) {
  if (!force && suggested === s.latest.version) return;
  suggested = s.latest.version;
  live?.close();
  live = toast({
    type: 'info', duration: 0,
    title: `Update available: v${s.latest.version}`,
    message: notesPreview(s.latest.notes) || `You have v${s.current}.`,
    actions: [
      { label: s.mode === 'manual' ? 'Download' : 'Update now', icon: 'download', onClick: startUpdate },
      { label: 'What’s new', icon: 'external-link', onClick: () => api.shell.openExternal(s.latest.url), close: false },
      { label: 'Skip this version', onClick: () => api.update.skip() },
    ],
  });
}

function onStatus(s) {
  const prev = st?.status;
  st = s;
  if (s.status === 'available' && prev !== 'available' && !s.manual) suggest(s);
  if (s.status === 'downloading') {
    const pct = Math.round((s.progress || 0) * 100);
    if (prev !== 'downloading') { live?.close(); live = toast({ type: 'loading', title: `Downloading v${s.latest.version}…`, message: `${pct}%`, duration: 0 }); }
    else live?.update({ message: `${pct}%` });
  }
  if (s.status === 'ready' && prev !== 'ready') {
    live?.close();
    live = toast({
      type: 'success', duration: 0, title: `v${s.latest.version} is ready`, message: 'Restart Scrcpy Studio to finish updating.',
      actions: [{ label: 'Restart now', icon: 'rotate-cw', onClick: restartToUpdate }, { label: 'Later', onClick: () => {} }],
    });
  }
  if (s.status === 'available' && s.error) toast({ type: 'error', title: 'Update failed', message: s.error });
  renderCard();
}

// ------------------------------------------------------------------ settings card
export function updateCard() {
  cardEl = h('div.card.settings-card');
  renderCard();
  return cardEl;
}

function renderCard() {
  if (!cardEl?.isConnected && cardEl) { /* rendered later */ }
  if (!cardEl) return;
  const s = st || { status: 'idle', current: '' };
  const line = (title, control) => h('div.setting-line', h('div.l', h('div.t', title)), h('div.c', control));
  const statusText = {
    idle: 'Not checked yet',
    checking: 'Checking…',
    none: s.checkedAt ? `Up to date · checked ${new Date(s.checkedAt).toLocaleTimeString()}` : 'Up to date',
    available: `Version ${s.latest?.version} is available`,
    downloading: `Downloading v${s.latest?.version}… ${Math.round((s.progress || 0) * 100)}%`,
    ready: `v${s.latest?.version} downloaded — restart to install`,
    error: `Could not check: ${s.error || 'unknown error'}`,
  }[s.status] || s.status;
  const asset = s.latest?.assets?.find(a => (s.mode === 'portable' ? /portable/i : /setup/i).test(a.name));
  const action = s.status === 'available' ? h('button.btn.sm.primary', { onclick: startUpdate }, icon('download'), s.mode === 'manual' ? 'Download' : `Update${asset ? ` (${fmtSize(asset.size)})` : ''}`)
    : s.status === 'ready' ? h('button.btn.sm.primary', { onclick: restartToUpdate }, icon('rotate-cw'), 'Restart & update')
    : h('button.btn.sm', { disabled: s.status === 'checking' || s.status === 'downloading', onclick: checkNow }, icon('refresh-cw'), 'Check now');
  replace(cardEl,
    h('div.card-head', h('h3', icon('download-cloud'), 'Updates'), h('div.actions',
      s.repo ? h('button.btn.sm', { onclick: () => api.shell.openExternal(`https://github.com/${s.repo}/releases`) }, icon('external-link'), 'Releases') : null)),
    h('div.card-body',
      line(h('span', `Version ${s.current}`, h('span.faint', { style: { fontWeight: 400, marginLeft: '8px', fontSize: '12px' } }, statusText)), action),
      s.status === 'downloading' ? h('div.upd-progress', h('i', { style: { width: `${Math.round((s.progress || 0) * 100)}%` } })) : null,
      line('Check for updates at startup', switchEl(settings().autoUpdateCheck !== false, (v) => saveSettings({ autoUpdateCheck: v }))),
      h('div.faint', { style: { fontSize: '12px', padding: '4px 0 12px' } }, MODE_HINT[s.mode] || '')));
}

export async function initUpdates() {
  if (!api.update) return;
  st = await api.update.status();
  api.on.updateStatus?.(onStatus);
  api.on.updateShow?.((p) => {
    navigate('settings');
    if (st?.status === 'available') suggest(st, true);
    else if (p?.manual && st?.status === 'none') toast({ type: 'success', title: 'You are up to date', message: `Scrcpy Studio ${st.current} is the latest version.` });
  });
  if (st.status === 'available') suggest(st);
}
