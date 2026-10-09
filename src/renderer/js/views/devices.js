// Home: a hero for the selected device (live screen, big actions), a strip of
// other devices, and an "Add device" sheet with every wireless option.
import { h, icon, clear, replace, timeAgo } from '../lib/dom.js';
import { toast, showMenu, promptDialog, emptyState, withToast, modal, ring, tip } from '../lib/ui.js';
import { api, state, bus, deviceName, deviceSubtitle, selectDevice, sessionsFor, allProfiles, profileFor, saveConfig, readyDevices, selectedDevice } from '../state.js';
import { launch, screenshot, deviceMenu, renameDevice, deviceIconName, isTablet, navigate, stopSessions } from '../actions.js';

let heroEl, stripEl, bannerSlot, wirelessBody, wirelessTabs, currentTab = 'connect', qrOff = null, refreshHistory = null;
let screenTimer = null, screenFor = null, screenUrl = null, screenBusy = false;

// ------------------------------------------------------------------ live screen thumbnail
async function refreshScreen() {
  const d = selectedDevice();
  if (!d || d.state !== 'device' || screenBusy || document.hidden) return;
  screenBusy = true;
  const r = await api.adb.screenPreview(d.serial);
  screenBusy = false;
  if (r?.ok && selectedDevice()?.serial === d.serial) {
    screenUrl = r.url;
    screenFor = d.serial;
    const img = heroEl?.querySelector('.screen img');
    if (img) img.src = r.url;
    else renderHero();
  }
}

function startScreen() {
  stopScreen();
  refreshScreen();
  screenTimer = setInterval(refreshScreen, selectedDevice()?.type === 'wifi' ? 6000 : 3500);
}
function stopScreen() { clearInterval(screenTimer); screenTimer = null; }

// ------------------------------------------------------------------ hero
function orb(ic, label, onclick, cls = '', disabled = false, tipText) {
  return h(`button.orb${cls ? '.' + cls : ''}`, { onclick, disabled, dataset: tipText ? { tip: tipText } : {} }, h('span.o', icon(ic)), label);
}

function renderHero() {
  if (!heroEl) return;
  const d = selectedDevice();
  if (!d) {
    replace(heroEl, h('div.card', emptyState({
      icon: 'smartphone', title: 'Connect your phone',
      text: 'USB with debugging on, or pair over Wi-Fi.',
      actions: [h('button.btn.primary', { onclick: () => openWireless('qr') }, icon('qr-code'), 'Pair with QR'), h('button.btn', { onclick: () => openWireless('connect') }, icon('wifi'), 'Connect by IP')],
    }), h('div', { style: { display: 'flex', justifyContent: 'center', padding: '0 24px 32px' } },
      h('div.steps',
        h('div.step', h('div.n', '1'), h('b', 'Developer options'), h('span.muted', 'About phone → tap Build number 7×')),
        h('div.step', h('div.n', '2'), h('b', 'USB debugging'), h('span.muted', 'Developer options → USB / Wireless debugging')),
        h('div.step', h('div.n', '3'), h('b', 'Allow'), h('span.muted', 'Accept the prompt on the phone'))))));
    return;
  }
  const ready = d.state === 'device';
  const live = sessionsFor(d.serial);
  const profile = profileFor(d.serial);
  const tablet = isTablet(d);
  const b = d.battery;

  const screen = h('div.screen',
    ready && screenUrl && screenFor === d.serial ? h('img', { src: screenUrl, alt: '' })
      : h('div.ph', icon(ready ? 'loader-circle' : d.state === 'unauthorized' ? 'fingerprint' : 'circle-alert', ready ? 'spin' : ''), ready ? '' : d.state));
  const frame = h(`div.phone-frame${tablet ? '.tablet' : ''}`, { onclick: () => ready && launch(d.serial), style: { cursor: ready ? 'pointer' : 'default' }, dataset: { tip: ready ? 'Click to mirror' : '' } },
    tablet ? null : h('div.punch'), screen,
    live.length ? h('span.chip.success.live-badge', h('span.dot.live'), 'Live') : null);

  const stats = ready ? [
    b ? h('div.stat-pill', ring(b.level, `${b.level}`), h('div', h('b', b.charging ? 'Charging' : 'Battery'), h('span', b.temperature ? `${b.temperature.toFixed(0)}°C` : 'level'))) : null,
    h('div.stat-pill', h('div.ic', icon('smartphone')), h('div', h('b', `Android ${d.androidVersion || '?'}`), h('span', `API ${d.sdk || '?'}`))),
    d.resolution ? h('div.stat-pill', h('div.ic', icon('scan')), h('div', h('b', d.resolution.replace('x', '×')), h('span', `${d.density || '?'} dpi`))) : null,
    h('div.stat-pill', h('div.ic', icon(deviceIconName(d))), h('div', h('b', d.type === 'wifi' ? 'Wi-Fi' : d.type === 'emulator' ? 'Emulator' : 'USB'), h('span', 'connection'))),
  ] : [];

  const warn = d.state === 'unauthorized'
    ? h('div.banner', { style: { margin: 0 } }, icon('fingerprint'), h('div.grow', h('b', 'Allow USB debugging'), h('span', 'Unlock the phone and accept the prompt (tick “Always allow”).')))
    : d.state === 'offline' ? h('div.banner', { style: { margin: 0 } }, icon('triangle-alert'), h('div.grow', h('b', 'Device offline'), h('span', 'Reconnect the cable or restart adb in Settings.'))) : null;

  replace(heroEl, h('div.card.hero',
    frame,
    h('div.hero-body',
      h('div.hero-name', h('h2', deviceName(d)), tip(h('button.btn.ghost.icon.sm.edit', { onclick: () => renameDevice(d.serial) }, icon('pencil')), 'Rename'),
        h('span.grow'),
        tip(h('button.btn.icon', { onclick: (e) => showMenu(e.currentTarget, deviceMenu(d), { align: 'right' }) }, icon('ellipsis-vertical')), 'More')),
      h('div.hero-model', deviceSubtitle(d), h('span.mono.faint', { style: { fontSize: '11.5px' } }, d.serial)),
      warn,
      stats.length ? h('div.hero-stats', stats) : null,
      h('div.orbs',
        orb('cast', 'Mirror', () => launch(d.serial), 'main', !ready, `Profile: ${profile.name}`),
        h('button.orb', { disabled: !ready, onclick: (e) => profilePicker(e.currentTarget, d), dataset: { tip: 'Mirror with a profile' } }, h('span.o', icon('sliders-horizontal')), 'Profiles'),
        orb('aperture', 'Camera', () => navigate('camera'), 'hotorb', !ready, 'Camera Studio'),
        orb('webcam', 'Phone Link', () => api.link?.open(), '', false, 'Webcam, mic & speakers for Windows'),
        orb('disc', 'Record', () => launch(d.serial, { mode: 'record' }), '', !ready),
        orb('moon', 'Screen off', () => launch(d.serial, { mode: 'screen-off' }), '', !ready),
        orb('monitor', 'Desktop', () => launch(d.serial, { mode: 'desktop' }), '', !ready, 'Virtual display'),
        orb('headphones', 'Audio', () => launch(d.serial, { mode: 'audio' }), '', !ready, 'Audio only'),
        orb('camera', 'Screenshot', () => screenshot(d.serial), '', !ready),
        live.length ? orb('square', 'Stop', () => stopSessions(d.serial), '', false, `Stop ${live.length} session(s)`) : null))));
}

function profilePicker(anchor, d) {
  const profile = profileFor(d.serial);
  showMenu(anchor, [
    { heading: 'Mirror with' },
    ...allProfiles().map(p => ({ label: p.name, icon: p.icon || 'sliders-horizontal', checked: p.id === profile.id, onClick: () => launch(d.serial, { profileId: p.id }) })),
    '-',
    { label: 'Set default for this device…', icon: 'star', onClick: () => showMenu(anchor, [
      { heading: 'Default profile' },
      ...allProfiles().map(p => ({ label: p.name, checked: state.config.deviceProfiles?.[d.serial] === p.id, onClick: async () => {
        await saveConfig({ deviceProfiles: { ...(state.config.deviceProfiles || {}), [d.serial]: p.id } });
        toast({ type: 'success', title: 'Default profile set', message: `${deviceName(d)} → ${p.name}`, duration: 1800 });
      } })),
    ]) },
    { label: 'Edit profiles', icon: 'pencil', onClick: () => navigate('mirror') },
  ]);
}

// ------------------------------------------------------------------ strip
function mini(d) {
  const ready = d.state === 'device';
  const live = sessionsFor(d.serial).length;
  return h(`div.card.mini-device${d.serial === state.selected ? '.selected' : ''}`, {
    onclick: () => selectDevice(d.serial),
    oncontextmenu: (e) => { e.preventDefault(); showMenu({ x: e.clientX, y: e.clientY }, deviceMenu(d)); },
  },
  h(`div.glyph${isTablet(d) ? '.tablet' : ''}${ready ? '' : '.bad'}`, h('div.conn', icon(deviceIconName(d)))),
  h('div.grow', { style: { minWidth: 0 } },
    h('div.n.ellipsis', deviceName(d)),
    ready ? h('div.s', [d.androidVersion ? `Android ${d.androidVersion}` : null, d.battery ? `${d.battery.level}%` : null].filter(Boolean).join(' · ') || 'Ready')
      : h('div.warn-line', icon('circle-alert', '', 13), d.state)),
  live ? h('span.dot.live') : null,
  h('button.btn.ghost.icon.sm.more', { onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, deviceMenu(d), { align: 'right' }); } }, icon('ellipsis-vertical')));
}

function render() {
  if (!heroEl) return;
  clear(bannerSlot);
  const t = state.info?.tools || {};
  if (!t.scrcpy || !t.adb) {
    bannerSlot.appendChild(h('div.banner.danger', icon('triangle-alert'),
      h('div.grow', h('b', `${!t.scrcpy ? 'scrcpy' : 'adb'} not found`), h('span', 'winget install Genymobile.scrcpy — or set the path in Settings.')),
      h('button.btn.sm', { onclick: () => api.shell.openExternal('https://github.com/Genymobile/scrcpy/releases/latest') }, icon('external-link'), 'Download'),
      h('button.btn.sm.primary', { onclick: () => navigate('settings') }, 'Configure')));
  } else if (state.devicesError) {
    bannerSlot.appendChild(h('div.banner', icon('triangle-alert'), h('div.grow', h('b', 'adb error'), h('span', state.devicesError))));
  }
  renderHero();
  const sorted = [...state.devices].sort((a, b) => (b.state === 'device') - (a.state === 'device'));
  replace(stripEl,
    sorted.map(mini),
    h('div.card.mini-device.add-tile', { onclick: () => openWireless('connect') }, h('span.plus', icon('plus')), 'Add device'));
}

// ------------------------------------------------------------------ wireless
function setTab(t) {
  currentTab = t;
  if (t !== 'qr' && qrOff) { qrOff(); qrOff = null; api.pair.qrCancel(); }
  refreshHistory = null;
  if (!wirelessBody) return;
  wirelessTabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.t === t));
  const panes = { connect: connectPane, pair: pairPane, qr: qrPane, discover: discoverPane };
  replace(wirelessBody, panes[t]());
}

function connectPane() {
  const input = h('input.input.mono', { placeholder: '192.168.1.42:5555', spellcheck: false });
  const btn = h('button.btn.primary', { onclick: go }, icon('link'), 'Connect');
  async function go() {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    btn.disabled = true;
    const r = await api.adb.connect(v);
    btn.disabled = false;
    toast(r.ok ? { type: 'success', title: 'Connected', message: r.address } : { type: 'error', title: 'Connection failed', message: r.message });
    if (r.ok) { input.value = ''; state.config = await api.store.get(); refreshHistory?.(); }
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const histEl = h('div');
  refreshHistory = () => {
    const hist = state.config.wirelessHistory || [];
    const connected = new Set(state.devices.map(d => d.serial));
    const again = () => setTimeout(() => refreshHistory?.(), 300);
    replace(histEl, hist.length ? h('div', { style: { marginTop: '8px' } },
      h('div.section-title', icon('history', '', 14), 'Recent'),
      hist.map(x => h('div.history-item',
        h('div.ic', icon(connected.has(x.address) ? 'wifi' : 'wifi-off')),
        h('div.grow', { style: { minWidth: 0 } },
          h('div.mono.ellipsis', { style: { fontSize: '12.5px', fontWeight: 600 } }, x.name || x.address),
          h('div.faint', { style: { fontSize: '11.5px' } }, x.name ? `${x.address} · ` : '', connected.has(x.address) ? 'connected' : timeAgo(x.lastUsed))),
        h('div.acts',
          connected.has(x.address)
            ? h('button.btn.ghost.icon.sm', { dataset: { tip: 'Disconnect' }, onclick: async () => { await api.adb.disconnect(x.address); again(); } }, icon('unlink'))
            : h('button.btn.ghost.icon.sm', { dataset: { tip: 'Connect' }, onclick: async () => {
              const r = await withToast(`Connecting to ${x.address}…`, () => api.adb.connect(x.address), { success: `Connected to ${x.address}`, error: 'Connection failed' });
              if (r) { state.config = await api.store.get(); again(); }
            } }, icon('link')),
          h('button.btn.ghost.icon.sm', { dataset: { tip: 'Rename' }, onclick: async () => {
            const n = await promptDialog({ title: 'Name this address', value: x.name || '', placeholder: 'Living room tablet' });
            if (n == null) return;
            await saveConfig({ wirelessHistory: hist.map(y => y.address === x.address ? { ...y, name: n } : y) });
            refreshHistory();
          } }, icon('pencil')),
          h('button.btn.ghost.icon.sm', { dataset: { tip: 'Forget' }, onclick: async () => { await saveConfig({ wirelessHistory: hist.filter(y => y.address !== x.address) }); refreshHistory(); } }, icon('x')))))) : null);
  };
  refreshHistory();
  return h('div.col',
    h('div.field', h('label', 'IP address and port'), h('div.row', input, btn)),
    histEl);
}

function pairPane() {
  const addr = h('input.input.mono', { placeholder: '192.168.1.42:37123', spellcheck: false });
  const code = h('input.input.mono', { placeholder: '123456', maxLength: 6, inputMode: 'numeric', style: { letterSpacing: '4px' } });
  const btn = h('button.btn.primary.block', { onclick: go }, icon('link'), 'Pair device');
  async function go() {
    if (!addr.value.trim() || !code.value.trim()) return toast({ type: 'warn', title: 'Enter the pairing address and code' });
    btn.disabled = true;
    const r = await api.adb.pair(addr.value.trim(), code.value.trim());
    if (!r.ok) { btn.disabled = false; return toast({ type: 'error', title: 'Pairing failed', message: r.message }); }
    toast({ type: 'success', title: 'Paired successfully', message: 'Looking for the device…' });
    const host = addr.value.trim().split(':')[0];
    for (let i = 0; i < 5; i++) {
      const { services } = await api.adb.mdns();
      const svc = services.find(s => !s.pairing && s.address.startsWith(host + ':'));
      if (svc) { const c = await api.adb.connect(svc.address); if (c.ok) { toast({ type: 'success', title: 'Connected', message: svc.address }); btn.disabled = false; return; } }
      await new Promise(r2 => setTimeout(r2, 1200));
    }
    btn.disabled = false;
    toast({ type: 'info', title: 'Now connect', message: 'Enter the IP address & port shown on the Wireless debugging screen (not the pairing port).' });
    setTab('connect');
    setTimeout(() => { const i = wirelessBody.querySelector('input'); if (i) { i.value = host + ':'; i.focus(); } }, 30);
  }
  return h('div.col',
    h('ol.howto', h('li', 'Wireless debugging'), h('li', 'Pair with pairing code'), h('li', 'Enter IP, port & code')),
    h('div.field', h('label', 'Pairing IP address and port'), addr),
    h('div.field', h('label', 'Pairing code'), code),
    btn);
}

function qrPane() {
  const wrap = h('div.qr-wrap', h('div.skeleton', { style: { width: '100%', height: '100%' } }));
  const status = h('div.qr-status', icon('loader-circle', 'spin', 15), 'Generating code…');
  const setStatus = (ic, text, spin) => replace(status, icon(ic, spin ? 'spin' : '', 15), text);
  async function start() {
    replace(wrap, h('div.skeleton', { style: { width: '100%', height: '100%' } }));
    const r = await api.pair.qrStart();
    if (!r?.ok) return setStatus('circle-x', 'Could not generate a QR code');
    replace(wrap, h('img', { src: r.qr, alt: 'Pairing QR code' }));
    setStatus('loader-circle', r.mdnsOk ? 'Waiting for the device to scan…' : 'Waiting… (mDNS may be unavailable on this PC)', true);
  }
  if (qrOff) qrOff();
  qrOff = api.on.pairStatus((s) => {
    const map = { pairing: ['loader-circle', true], paired: ['circle-check', true], connected: ['circle-check', false], error: ['circle-x', false], timeout: ['clock', false] };
    const [ic, spin] = map[s.state] || ['info', false];
    setStatus(ic, s.message, spin && s.state !== 'connected');
    if (s.state === 'connected') toast({ type: 'success', title: 'Wireless device connected', message: s.address || s.message });
    if (s.state === 'error') toast({ type: 'error', title: 'QR pairing failed', message: s.message });
  });
  setTimeout(start, 50);
  return h('div.col', { style: { alignItems: 'stretch' } },
    h('ol.howto', h('li', 'Wireless debugging'), h('li', 'Pair with QR code'), h('li', 'Scan')),
    wrap, status,
    h('button.btn.sm', { style: { alignSelf: 'center', marginTop: '6px' }, onclick: start }, icon('refresh-cw'), 'New code'));
}

function discoverPane() {
  const list = h('div.col', { style: { gap: '4px' } });
  const btn = h('button.btn.block', { onclick: scan }, icon('radar'), 'Scan network');
  async function scan() {
    btn.disabled = true;
    replace(list, h('div.qr-status', { style: { padding: '14px' } }, icon('loader-circle', 'spin', 15), 'Scanning for devices via mDNS…'));
    const r = await api.adb.mdns();
    btn.disabled = false;
    if (!r.services.length) {
      replace(list, h('div.hint', { style: { padding: '10px 4px', textAlign: 'center' } }, r.error ? `mDNS unavailable: ${r.error}` : 'No devices advertising Wireless debugging were found. Make sure Wireless debugging is on.'));
      return;
    }
    replace(list, r.services.map(s => h('div.history-item',
      h('div.ic', icon(s.pairing ? 'fingerprint' : 'wifi')),
      h('div.grow', { style: { minWidth: 0 } }, h('div.ellipsis', { style: { fontWeight: 600, fontSize: '12.5px' } }, s.name), h('div.mono.faint', { style: { fontSize: '11px' } }, `${s.address} · ${s.pairing ? 'pairing' : 'connect'}`)),
      s.pairing
        ? h('button.btn.sm', { onclick: async () => {
          const code = await promptDialog({ title: 'Enter pairing code', label: `Code shown on the device for ${s.address}`, placeholder: '123456', confirm: 'Pair', icon: 'fingerprint', mono: true });
          if (!code) return;
          const pr = await api.adb.pair(s.address, code);
          toast(pr.ok ? { type: 'success', title: 'Paired', message: pr.message } : { type: 'error', title: 'Pairing failed', message: pr.message });
          if (pr.ok) setTimeout(scan, 1500);
        } }, 'Pair')
        : h('button.btn.sm.primary', { onclick: async () => {
          const cr = await api.adb.connect(s.address);
          toast(cr.ok ? { type: 'success', title: 'Connected', message: s.address } : { type: 'error', title: 'Connection failed', message: cr.message });
        } }, 'Connect'))));
  }
  setTimeout(scan, 50);
  return h('div.col', btn, list);
}


// ------------------------------------------------------------------ add-device sheet
export function openWireless(tab = 'connect') {
  wirelessBody = h('div.pane');
  wirelessTabs = h('div.tabs',
    [['connect', 'Connect', 'link'], ['qr', 'QR code', 'qr-code'], ['pair', 'Pair code', 'hash'], ['discover', 'Discover', 'radar']].map(([t, l, ic]) =>
      h('button', { dataset: { t }, onclick: () => setTab(t) }, icon(ic), l)));
  modal({
    title: 'Add a device', icon: 'wifi', size: 'wide',
    body: h('div.wireless', wirelessTabs, wirelessBody),
    onClose: () => { if (qrOff) { qrOff(); qrOff = null; api.pair.qrCancel(); } refreshHistory = null; wirelessBody = null; },
  });
  setTab(tab);
}

export default {
  id: 'devices', title: 'Home', icon: 'house',
  create(root) {
    bannerSlot = h('div');
    heroEl = h('div');
    stripEl = h('div.device-strip');
    root.append(h('div.home',
      bannerSlot,
      heroEl,
      h('div.strip-title', 'Devices', h('span.badge', { style: { textTransform: 'none' } }, String(readyDevices().length)), h('span.grow'),
        tip(h('button.btn.ghost.icon.sm', { onclick: async (e) => { const b = e.currentTarget; b.disabled = true; await api.adb.refresh(); b.disabled = false; } }, icon('refresh-cw')), 'Rescan  ·  F5')),
      stripEl));
    bus.on('devices', () => {
      render();
      root.querySelector('.strip-title .badge').textContent = String(readyDevices().length);
      if (refreshHistory) api.store.get().then(c => { state.config = c; refreshHistory?.(); });
    });
    bus.on('sessions', render);
    bus.on('selected', () => { screenUrl = null; render(); if (state.view === 'devices') startScreen(); });
    bus.on('config', render);
    bus.on('wireless-tab', (t) => openWireless(t));
    render();
  },
  show() { render(); startScreen(); },
  hide() { stopScreen(); },
};
