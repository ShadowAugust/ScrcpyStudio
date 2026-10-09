// Device information dashboard with live stats and all system properties.
import { h, icon, clear, replace, fmtBytes, fmtUptime, debounce } from '../lib/dom.js';
import { toast, emptyState, tip } from '../lib/ui.js';
import { api, state, bus, selectedDevice, deviceName } from '../state.js';
import { navigate } from '../actions.js';

let body, info = null, timer = null, propFilter = '', loadingFor = null;

function stat(ic, label, value, unit, meter, sub, higherIsBetter = false) {
  const pct = meter != null ? Math.max(0, Math.min(100, meter)) : null;
  const level = pct == null ? '' : higherIsBetter ? (pct < 15 ? '.bad' : pct < 30 ? '.warn' : '.good') : (pct > 90 ? '.bad' : pct > 75 ? '.warn' : '');
  return h('div.card.stat',
    h('div.h', h('div.ic', icon(ic)), label),
    h('div.v', value ?? '—', unit ? h('small', unit) : null),
    pct != null ? h(`div.meter${level}`, h('div', { style: { width: pct + '%' } })) : null,
    sub ? h('div.faint', { style: { fontSize: '12px' } }, sub) : null);
}

function render() {
  const d = selectedDevice();
  if (!d || d.state !== 'device') {
    replace(body, h('div.card', emptyState({ icon: 'info', title: 'No device ready', text: 'Select a connected device to see its details.', actions: [h('button.btn.primary', { onclick: () => navigate('devices') }, 'Go to devices')] })));
    return;
  }
  if (!info) {
    replace(body, h('div.stat-grid', Array.from({ length: 6 }, () => h('div.skeleton', { style: { height: '120px', borderRadius: '16px' } }))));
    return;
  }
  const p = info.props;
  const b = info.battery;
  const mem = info.memory;
  const st = info.storage;
  const memUsed = mem.total && mem.available != null ? mem.total - mem.available : null;
  const healthNames = { 1: 'Unknown', 2: 'Good', 3: 'Overheat', 4: 'Dead', 5: 'Over voltage', 6: 'Failure', 7: 'Cold' };

  const kv = [
    ['Name', deviceName(d)],
    ['Manufacturer', p['ro.product.manufacturer']],
    ['Model', `${p['ro.product.model'] || ''}${p['ro.product.device'] ? ` (${p['ro.product.device']})` : ''}`],
    ['Android', `${p['ro.build.version.release']} · API ${p['ro.build.version.sdk']}`],
    ['Security patch', p['ro.build.version.security_patch']],
    ['Build', p['ro.build.display.id']],
    ['Fingerprint', p['ro.build.fingerprint']],
    ['Kernel', info.kernel],
    ['SoC / platform', [p['ro.soc.manufacturer'], p['ro.soc.model'] || p['ro.board.platform'] || p['ro.hardware']].filter(Boolean).join(' ')],
    ['CPU ABI', p['ro.product.cpu.abilist'] || p['ro.product.cpu.abi']],
    ['Serial', p['ro.serialno'] || d.serial],
    ['adb serial', d.serial],
    ['Connection', d.type === 'wifi' ? 'Wi-Fi (TCP/IP)' : d.type === 'usb' ? 'USB' : d.type],
    ['Wi-Fi IP', info.ip],
    ['Locale', p['persist.sys.locale'] || p['ro.product.locale']],
    ['Timezone', p['persist.sys.timezone']],
    ['Bootloader', p['ro.bootloader']],
    ['Baseband', p['gsm.version.baseband']],
    ['Encryption', p['ro.crypto.state'] || p['ro.crypto.type']],
    ['Treble', p['ro.treble.enabled']],
  ].filter(([, v]) => v);

  const propsList = h('div.kv.props-table');
  const renderProps = () => {
    const q = propFilter.toLowerCase();
    const rows = Object.entries(p).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q)).sort(([a], [bb]) => a.localeCompare(bb));
    replace(propsList, rows.slice(0, 1500).flatMap(([k, v]) => [h('div.mono', { style: { fontSize: '11.5px' } }, k), h('div', v || '""')]));
  };
  const propInput = h('input.input.sm', { placeholder: 'Filter properties…', value: propFilter, spellcheck: false, oninput: debounce(() => { propFilter = propInput.value.trim(); renderProps(); }, 120) });
  renderProps();

  replace(body,
    h('div.stat-grid',
      stat(b?.charging ? 'battery-charging' : 'battery-full', 'Battery', b?.level, '%', b?.level, b ? `${b.charging ? 'Charging' : 'Discharging'}${b.temperature ? ` · ${b.temperature.toFixed(1)}°C` : ''}${b.health ? ` · ${healthNames[b.health] || ''}` : ''}` : null, true),
      stat('memory-stick', 'Memory', memUsed != null ? fmtBytes(memUsed * 1024) : null, mem.total ? `/ ${fmtBytes(mem.total * 1024)}` : '', memUsed != null ? (memUsed / mem.total) * 100 : null, mem.available != null ? `${fmtBytes(mem.available * 1024)} available` : null),
      stat('hard-drive', 'Storage', st?.used != null ? fmtBytes(st.used * 1024) : null, st?.total ? `/ ${fmtBytes(st.total * 1024)}` : '', st?.total ? (st.used / st.total) * 100 : null, st?.free != null ? `${fmtBytes(st.free * 1024)} free` : null),
      stat('cpu', 'Processor', info.cpu.cores, 'cores', null, info.cpu.maxFreqKHz ? `Up to ${(info.cpu.maxFreqKHz / 1e6).toFixed(2)} GHz` : p['ro.board.platform']),
      stat('monitor', 'Display', info.wm.physical ? info.wm.physical.replace('x', '×') : null, '', null, `${info.wm.density || '?'} dpi${info.wm.override ? ` · override ${info.wm.override}` : ''}`),
      stat('clock', 'Uptime', fmtUptime(info.uptime), '', null, b?.voltage ? `Battery ${b.voltage.toFixed(2)} V · ${b.technology || ''}` : null)),
    h('div.grid.cols-2', { style: { alignItems: 'start' } },
      h('div.card',
        h('div.card-head', h('h3', icon('smartphone'), 'Overview'), h('div.actions', tip(h('button.btn.ghost.icon.sm', { onclick: () => api.clipboard.text(kv.map(([k, v]) => `${k}: ${v}`).join('\n')).then(() => toast({ type: 'success', title: 'Copied', duration: 1400 })) }, icon('copy')), 'Copy overview'))),
        h('div.card-body', h('div.kv', kv.flatMap(([k, v]) => [h('div', k), h('div', v)])))),
      h('div.card',
        h('div.card-head', h('h3', icon('list'), 'System properties'), h('div.actions', h('div.input-group', { style: { width: '200px' } }, icon('search'), propInput))),
        h('div.card-body', propsList))));
}

async function load(quiet) {
  const d = selectedDevice();
  if (!d || d.state !== 'device') { info = null; render(); return; }
  const serial = d.serial;
  if (!quiet) { info = null; render(); }
  loadingFor = serial;
  const r = await api.adb.details(serial);
  if (selectedDevice()?.serial !== serial) return;
  if (!r.ok) { toast({ type: 'error', title: 'Could not read device info', message: r.error }); return; }
  // Avoid re-rendering the property filter mid-typing on background refresh.
  const typing = document.activeElement?.closest?.('[data-view="info"]');
  info = r;
  if (!quiet || !typing) render();
}

export default {
  id: 'info', title: 'Device info', icon: 'info',
  create(root) {
    body = h('div');
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Device info'), h('div.sub')),
        h('div.actions', h('button.btn', { onclick: () => load() }, icon('refresh-cw'), 'Refresh'))),
      body);
    bus.on('selected', () => { info = null; if (state.view === 'info') load(); });
  },
  show() {
    if (!info || loadingFor !== state.selected) load(); else render();
    clearInterval(timer);
    timer = setInterval(() => load(true), 15000);
  },
  hide() { clearInterval(timer); },
};
