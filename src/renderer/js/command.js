// Turns option values into a scrcpy argv and validates combinations.
import { OPTIONS, OPTION_MAP } from './options.js';
import { splitArgs, quoteArg } from './lib/dom.js';

export function versionAtLeast(have, need) {
  if (!need) return true;
  if (!have) return true; // unknown version: don't hide anything
  const a = have.split('.').map(n => parseInt(n, 10) || 0);
  const b = need.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/** Whether an option applies given the other values (scrcpy rejects some combos). */
export function isActive(opt, v) {
  if (opt.requires && !v[opt.requires]) return false;
  if (opt.when && !opt.when(v)) return false;
  return true;
}

export function isSet(opt, v) {
  if (v === undefined || v === null || v === '') return false;
  if (opt.type === 'bool') return v === true;
  return String(v) !== String(opt.default ?? '');
}

/**
 * @returns {{ args: string[], record: null | { format?: string } }}
 */
export function buildArgs(values, { title, version } = {}) {
  const v = { ...values };
  const args = [];
  let record = null;

  if (v.otg) {
    args.push('--otg');
    for (const k of ['keyboard', 'mouse', 'gamepad', 'window-title', 'fullscreen', 'always-on-top', 'window-borderless', 'shortcut-mod']) {
      const opt = OPTION_MAP[k];
      if (isSet(opt, v[k])) args.push(opt.type === 'bool' ? `--${k}` : `--${k}=${v[k]}`);
    }
    if (!v['window-title'] && title) args.push(`--window-title=${title}`);
    return { args, record };
  }

  for (const opt of OPTIONS) {
    if (opt.gui || opt.key === 'otg' || opt.key === 'new-display') continue;
    if (!versionAtLeast(version, opt.minVersion)) continue;
    if (!isActive(opt, v)) continue;
    const val = v[opt.key];
    if (!isSet(opt, val)) continue;
    if (opt.type === 'bool') args.push(`--${opt.key}`);
    else args.push(`--${opt.key}=${String(val).trim()}`);
  }

  if (v['new-display'] && isActive(OPTION_MAP['new-display'], v)) {
    const size = String(v['new-display-size'] || '').trim();
    const dpi = String(v['new-display-dpi'] || '').trim();
    const spec = `${size}${dpi ? '/' + dpi : ''}`;
    args.push(spec ? `--new-display=${spec}` : '--new-display');
  }

  if (!v['window-title'] && title && !v['no-window']) args.push(`--window-title=${title}`);

  if (v.record) record = { format: v['record-format'] || undefined };
  if (v['extra-args']) args.push(...splitArgs(v['extra-args']));
  return { args, record };
}

export function commandString(bin, serial, args, recordHint) {
  const parts = [bin || 'scrcpy'];
  if (serial) parts.push('-s', serial);
  parts.push(...args);
  if (recordHint) parts.push(`--record=<recordings>/${recordHint}`);
  return parts.map(quoteArg).join(' ');
}

/** Human readable warnings about option combinations. */
export function validate(v) {
  const w = [];
  if (v['audio-dup'] && v['audio-source'] !== 'playback') w.push('"Keep playing on device" is ignored unless the audio source is Playback.');
  if (v['video-source'] !== 'camera' && ['camera-id', 'camera-facing', 'camera-size', 'camera-ar', 'camera-fps', 'camera-zoom'].some(k => v[k]) ) w.push('Camera options are ignored unless Video source is Camera.');
  if (v['video-source'] === 'camera' && v['turn-screen-off']) w.push('Turning the screen off is not supported in camera mode.');
  if (v['no-video'] && v['no-audio']) w.push('Both video and audio are disabled — nothing will be streamed.');
  if (v['camera-id'] && v['camera-facing']) w.push('Camera ID and Camera facing are mutually exclusive.');
  if (v['flex-display'] && !v['new-display']) w.push('Flexible display requires a virtual display.');
  if (v.record && v['no-video'] && ['mp4', 'mkv'].includes(v['record-format'])) w.push('Video is disabled; choose an audio container for recording.');
  if (v['no-control'] && (v.keyboard === 'uhid' || v.mouse === 'uhid')) w.push('HID keyboard/mouse have no effect in view-only mode.');
  return w;
}
