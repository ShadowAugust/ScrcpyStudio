// Interactive adb shell with history and a quick command library.
import { h, icon, clear, replace } from '../lib/dom.js';
import { toast, promptDialog, showMenu, tip } from '../lib/ui.js';
import { api, state, bus, selectedDevice, deviceName, saveConfig } from '../state.js';
import { requireDevice } from '../actions.js';

const DEFAULT_QUICK = [
  { title: 'Battery status', cmd: 'dumpsys battery' },
  { title: 'Current activity', cmd: "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'" },
  { title: 'Top processes', cmd: 'top -b -n 1 | head -n 25' },
  { title: 'Memory info', cmd: 'cat /proc/meminfo | head -n 8' },
  { title: 'Storage usage', cmd: 'df -h /data /sdcard 2>/dev/null' },
  { title: 'Network (Wi-Fi)', cmd: 'ip addr show wlan0' },
  { title: 'Screen size & density', cmd: 'wm size; wm density' },
  { title: 'Uptime & load', cmd: 'uptime' },
  { title: 'Android version', cmd: 'getprop ro.build.version.release; getprop ro.build.display.id' },
  { title: 'CPU info', cmd: "cat /proc/cpuinfo | grep -E 'Hardware|processor|model name' | head -n 12" },
  { title: 'Running services', cmd: 'dumpsys activity services | grep ServiceRecord | head -n 30' },
  { title: 'Installed user apps', cmd: 'pm list packages -3' },
  { title: 'Thermal status', cmd: 'dumpsys thermalservice | head -n 20' },
  { title: 'Display refresh rate', cmd: "dumpsys display | grep -E 'mRefreshRate|fps=' | head -n 5" },
  { title: 'Open URL in browser', cmd: 'am start -a android.intent.action.VIEW -d https://github.com/Genymobile/scrcpy' },
];

let out, input, promptEl, running = null, histIdx = -1, quickEl, offData, offExit;

const history = () => state.config.shellHistory || [];
const quick = () => state.config.quickCommands || DEFAULT_QUICK;

function print(text, cls) {
  const el = h(`div${cls ? '.' + cls : ''}`, text);
  out.appendChild(el);
  while (out.childElementCount > 3000) out.firstChild.remove();
  out.scrollTop = out.scrollHeight;
  return el;
}

async function run(cmd) {
  cmd = cmd.trim();
  if (!cmd) return;
  if (cmd === 'clear' || cmd === 'cls') { clear(out); return; }
  const d = requireDevice();
  if (!d) return;
  if (running) { toast({ type: 'warn', title: 'A command is still running', message: 'Press Ctrl+C to stop it.' }); return; }
  const hist = [cmd, ...history().filter(c => c !== cmd)].slice(0, 100);
  saveConfig({ shellHistory: hist });
  histIdx = -1;
  print(`${deviceName(d)} $ ${cmd}`, 'cmd');
  const r = await api.adb.shellStream(d.serial, cmd);
  if (!r.ok) { print(r.error, 'err'); return; }
  running = { id: r.id, el: print('') };
  renderPrompt();
}

function stop() {
  if (!running) return;
  api.adb.streamStop(running.id);
  print('^C', 'sys');
}

function renderPrompt() {
  const d = selectedDevice();
  promptEl.textContent = running ? '… running' : `${d ? deviceName(d) : 'no device'}:/ $`;
}

function renderQuick() {
  replace(quickEl, quick().map((q, i) => h('div.quick-cmd', {
    onclick: () => { input.value = q.cmd; run(q.cmd); input.value = ''; },
    oncontextmenu: (e) => {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Insert without running', icon: 'text-cursor-input', onClick: () => { input.value = q.cmd; input.focus(); } },
        { label: 'Remove', icon: 'trash-2', danger: true, onClick: () => { const list = quick().filter((_, j) => j !== i); saveConfig({ quickCommands: list }).then(renderQuick); } },
      ]);
    },
  }, h('div.t', q.title), h('div.c', q.cmd))));
}

async function addQuick() {
  const cmd = await promptDialog({ title: 'Add quick command', label: 'Shell command', value: input.value, placeholder: 'dumpsys battery', mono: true, icon: 'plus' });
  if (!cmd) return;
  const title = await promptDialog({ title: 'Name it', label: 'Title', placeholder: 'Battery', value: cmd.split(' ')[0] });
  if (!title) return;
  await saveConfig({ quickCommands: [...quick(), { title, cmd }] });
  renderQuick();
}

export default {
  id: 'shell', title: 'Shell', icon: 'square-terminal', flex: true,
  create(root) {
    out = h('div.term-body');
    promptEl = h('span.prompt');
    input = h('input', { placeholder: 'Type a shell command and press Enter  (↑ history · Ctrl+C stop · Ctrl+L clear)', spellcheck: false });
    quickEl = h('div.quick-list');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { run(input.value); input.value = ''; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); const hs = history(); if (histIdx < hs.length - 1) { histIdx++; input.value = hs[histIdx]; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (histIdx > 0) { histIdx--; input.value = history()[histIdx]; } else { histIdx = -1; input.value = ''; } }
      else if (e.ctrlKey && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd && running) { e.preventDefault(); stop(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); clear(out); }
    });
    root.append(
      h('div.page-head',
        h('div', h('h1', 'Shell'), h('div.sub')),
        h('div.actions',
          h('button.btn', { onclick: () => clear(out) }, icon('trash-2'), 'Clear'),
          h('button.btn', { onclick: () => api.clipboard.text(out.innerText).then(() => toast({ type: 'success', title: 'Output copied', duration: 1500 })) }, icon('copy'), 'Copy output'))),
      h('div.shell-layout.fill',
        h('div.card.term', out, h('div.term-input', promptEl, input,
          tip(h('button.btn.ghost.icon.sm', { onclick: stop }, icon('square')), 'Stop (Ctrl+C)'))),
        h('div.card', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
          h('div.card-head', h('h3', icon('bolt'), 'Quick commands'), h('div.actions', tip(h('button.btn.ghost.icon.sm', { onclick: addQuick }, icon('plus')), 'Add command'))),
          h('div', { style: { padding: '6px', overflowY: 'auto', flex: 1 } }, quickEl))));
    print('Scrcpy Studio shell — commands run via "adb shell". Right-click a quick command for options.', 'sys');
    offData = api.on.streamData(({ id, data }) => {
      if (running?.id !== id) return;
      running.el.textContent += data;
      out.scrollTop = out.scrollHeight;
    });
    offExit = api.on.streamExit(({ id, code }) => {
      if (running?.id !== id) return;
      if (!running.el.textContent) running.el.remove();
      if (code) print(`exit code ${code}`, 'err');
      running = null;
      renderPrompt();
    });
    bus.on('selected', renderPrompt);
    renderQuick();
    renderPrompt();
  },
  show() { renderPrompt(); setTimeout(() => input.focus(), 50); },
};
