// Reusable UI components: toasts, modals, menus, tooltips, form controls.
import { h, icon, clear } from './dom.js';

// ------------------------------------------------------------------ toasts
let toastRoot;
export function toast(opts) {
  if (typeof opts === 'string') opts = { title: opts };
  const { title, message, type = 'info', duration = type === 'error' ? 7000 : 4200, actions = [], image, onImageClick } = opts;
  toastRoot ||= document.body.appendChild(h('div.toasts'));
  const ic = { success: 'circle-check', error: 'circle-x', warn: 'triangle-alert', info: 'info', loading: 'loader-circle' }[type] || 'info';
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(`div.toast.${type}`,
    h('div.ic', icon(ic, type === 'loading' ? 'spin' : '')),
    h('div.body',
      h('div.title', title),
      message ? h('div.msg', message) : null,
      image ? h('img.thumb', { src: image, onclick: () => onImageClick?.() }) : null,
      actions.length ? h('div.acts', actions.map(a => h('button.btn.sm', { onclick: () => { a.onClick(); if (a.close !== false) close(); } }, a.icon ? icon(a.icon) : null, a.label))) : null),
    h('button.btn.ghost.icon.sm.x', { onclick: close }, icon('x')),
    duration ? h('div.bar', { style: { animationDuration: duration + 'ms' } }) : null);
  el.addEventListener('mouseenter', () => { clearTimeout(timer); const b = el.querySelector('.bar'); if (b) b.style.animationPlayState = 'paused'; });
  el.addEventListener('mouseleave', () => { if (duration) timer = setTimeout(close, 1800); const b = el.querySelector('.bar'); if (b) b.style.animationPlayState = 'running'; });
  toastRoot.appendChild(el);
  while (toastRoot.children.length > 5) toastRoot.firstChild.remove();
  if (duration) timer = setTimeout(close, duration);
  return {
    close,
    update(o) {
      if (o.title) el.querySelector('.title').textContent = o.title;
      if (o.message != null) {
        let m = el.querySelector('.msg');
        if (!m) { m = h('div.msg'); el.querySelector('.title').after(m); }
        m.textContent = o.message;
      }
      if (o.type) {
        el.className = `toast ${o.type}`;
        const i = { success: 'circle-check', error: 'circle-x', warn: 'triangle-alert', info: 'info' }[o.type];
        if (i) clear(el.querySelector('.ic')).appendChild(icon(i));
        if (!el.querySelector('.bar')) el.appendChild(h('div.bar', { style: { animationDuration: '4000ms' } }));
        timer = setTimeout(close, o.type === 'error' ? 7000 : 4000);
      }
    },
  };
}

/** Wraps an async task with a loading toast that turns into success/error. */
export async function withToast(title, fn, { success, error } = {}) {
  const t = toast({ title, type: 'loading', duration: 0 });
  try {
    const r = await fn();
    if (r && r.ok === false) throw new Error(r.message || r.error || 'Failed');
    t.update({ type: 'success', title: typeof success === 'function' ? success(r) : success || title.replace(/…$/, '') + ' — done', message: '' });
    return r;
  } catch (e) {
    t.update({ type: 'error', title: error || 'Something went wrong', message: e.message || String(e) });
    return null;
  }
}

// ------------------------------------------------------------------ modals
export function modal({ title, icon: ic = 'info', danger = false, body, buttons = [], size = '', onClose, dismissable = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose?.(v);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); finish(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const primary = buttons.find(b => b.primary);
        if (primary && !primary.noEnter) { e.preventDefault(); click(primary); }
      }
    };
    const click = async (b) => {
      if (b.onClick) {
        const r = await b.onClick();
        if (r === false) return;
        finish(r === undefined ? b.value : r);
      } else finish(b.value);
    };
    const bodyEl = typeof body === 'function' ? body(finish) : body;
    const scrim = h('div.scrim', {
      onmousedown: (e) => { if (e.target === scrim && dismissable) finish(null); },
    }, h(`div.modal${size ? '.' + size : ''}`,
      h('div.modal-head',
        h(`div.ic${danger ? '.danger' : ''}`, icon(ic)),
        h('h2', title),
        dismissable ? h('button.btn.ghost.icon.sm.close', { onclick: () => finish(null) }, icon('x')) : null),
      h('div.modal-body', typeof bodyEl === 'string' ? h('p', { style: { margin: 0 } }, bodyEl) : bodyEl),
      buttons.length ? h('div.modal-foot', buttons.map(b =>
        h(`button.btn${b.primary ? (danger ? '.danger-solid' : '.primary') : ''}${b.ghost ? '.ghost' : ''}`, { onclick: () => click(b) }, b.icon ? icon(b.icon) : null, b.label))) : null));
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => scrim.querySelector('input:not([type=checkbox]), textarea, select')?.focus(), 30);
  });
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false, icon: ic }) {
  return modal({
    title, danger, icon: ic || (danger ? 'triangle-alert' : 'circle-help'), body: message,
    buttons: [{ label: 'Cancel', value: false, ghost: true }, { label: confirm, value: true, primary: true }],
  }).then(Boolean);
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'Save', icon: ic = 'pencil', hint, mono }) {
  let input;
  return modal({
    title, icon: ic,
    body: h('div.field', label ? h('label', label) : null,
      input = h(`input.input${mono ? '.mono' : ''}`, { value, placeholder, spellcheck: false }),
      hint ? h('div.hint', hint) : null),
    buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: confirm, primary: true, onClick: () => input.value.trim() || false }],
  });
}

// ------------------------------------------------------------------ menus
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }

/**
 * items: [{ label, icon, onClick, danger, checked, disabled, hint } | '-' | { heading }]
 * `anchor` may be an element or a {x, y} point (context menus).
 */
export function showMenu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const el = h('div.menu', { role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') { el.appendChild(h('div.menu-sep')); continue; }
    if (it.heading) { el.appendChild(h('div.menu-label', it.heading)); continue; }
    el.appendChild(h(`button.menu-item${it.danger ? '.danger' : ''}${it.checked ? '.checked' : ''}`, {
      disabled: !!it.disabled,
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); },
    }, it.icon ? icon(it.icon) : h('span', { style: { width: '16px' } }), h('span.grow.ellipsis', it.label), it.hint ? h('span.hint.faint', it.hint) : null));
  }
  document.body.appendChild(el);
  openMenu = el;
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let x = align === 'right' ? r.right - mw : r.left;
  let y = r.bottom + 6;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  x = Math.min(Math.max(8, x), innerWidth - mw - 8);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  setTimeout(() => {
    const off = (e) => { if (!el.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
  });
  return el;
}

// ------------------------------------------------------------------ tooltips
export function initTooltips() {
  let tip = null, timer = null, current = null;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; current = null; };
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t === current) return;
    hide();
    if (!t) return;
    current = t;
    timer = setTimeout(() => {
      if (!document.body.contains(t)) return;
      tip = document.body.appendChild(h('div.tooltip', t.dataset.tip));
      const r = t.getBoundingClientRect();
      const w = tip.offsetWidth, th = tip.offsetHeight;
      if (t.dataset.tipPos === 'right') {
        tip.style.left = r.right + 12 + 'px';
        tip.style.top = Math.max(8, r.top + r.height / 2 - th / 2) + 'px';
        return;
      }
      let top = r.bottom + 8;
      if (top + th + 8 > innerHeight) top = r.top - th - 8;
      tip.style.left = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)) + 'px';
      tip.style.top = top + 'px';
    }, t.dataset.tipPos === 'right' ? 120 : 380);
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
}

// ------------------------------------------------------------------ controls
export function switchEl(checked, onChange, { disabled } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled: !!disabled, onchange: () => onChange(input.checked) });
  const el = h('label.switch', input, h('span.track'));
  el.set = (v) => { input.checked = !!v; };
  el.input = input;
  return el;
}

export function segmented(options, value, onChange) {
  const el = h('div.segmented');
  const render = (v) => {
    clear(el);
    for (const o of options) {
      const [val, label, ic] = Array.isArray(o) ? o : [o, o];
      el.appendChild(h(`button${val === v ? '.active' : ''}`, { onclick: () => { render(val); onChange(val); } }, ic ? icon(ic) : null, label));
    }
  };
  render(value);
  el.set = render;
  return el;
}

export function selectEl(options, value, onChange, cls = '') {
  const el = h(`select.select${cls ? '.' + cls : ''}`, { onchange: () => onChange(el.value) },
    options.map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, l);
    }));
  return el;
}

export function rangeEl({ min, max, step = 1, value, onInput, onChange }) {
  const el = h('input.range', { type: 'range', min, max, step, value });
  const paint = () => el.style.setProperty('--p', ((el.value - min) / (max - min)) * 100 + '%');
  el.addEventListener('input', () => { paint(); onInput?.(Number(el.value)); });
  el.addEventListener('change', () => onChange?.(Number(el.value)));
  paint();
  el.setValue = (v) => { el.value = v; paint(); };
  return el;
}

export function emptyState({ icon: ic, title, text, actions = [] }) {
  return h('div.empty',
    h('div.art', icon(ic)),
    h('h3', title),
    text ? h('p', text) : null,
    actions.length ? h('div.row', actions) : null);
}

export function tip(el, text) { el.dataset.tip = text; return el; }

/** Small (i) bubble that shows a description on hover instead of inline text. */
export function infoTip(text) {
  if (!text) return null;
  const el = h('span.qi', icon('info'));
  el.dataset.tip = text;
  return el;
}

/** Progress ring (0..100) with an optional centered label. */
export function ring(pct, label, size = 38, stroke = 4) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, pct || 0));
  const el = h('div.ring', { style: { width: size + 'px', height: size + 'px' } });
  el.innerHTML = `<svg viewBox="0 0 ${size} ${size}"><circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/><circle class="val" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v / 100)}"/></svg>`;
  if (label != null) el.appendChild(h('em', label));
  return el;
}

/** Collapsible sub-menu section. */
export function fold(title, ic, body, open = false) {
  return h('details.fold', { open }, h('summary', ic ? icon(ic) : null, title), h('div.fold-body', body));
}
