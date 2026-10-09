// Horizontal "ruler" dial, in the spirit of pro camera apps.
// values: [{ v, label?, major? }] — drag, wheel or arrow keys to change.
import { h } from './dom.js';


export function createDial({ values = [], index = 0, onChange, onCommit } = {}) {
  const track = h('div.track');
  const el = h('div.dial', { tabIndex: 0 }, track, h('div.needle'));
  let vals = values;
  let idx = index;
  let disabled = false;
  let drag = null;
  let TICK = 16;
  // Spread short scales across the available width (14–34px per step).
  const fit = () => { const w = el.clientWidth || 600; TICK = Math.max(14, Math.min(34, Math.floor(w / Math.max(1, vals.length * 1.15)))); };

  const render = () => {
    fit();
    track.textContent = '';
    const frag = document.createDocumentFragment();
    vals.forEach((x, i) => {
      frag.appendChild(h(`div.tick${x.major ? '.major' : ''}${i === idx ? '.sel' : ''}`, { style: { width: TICK + 'px' } }, x.major && x.label ? h('span.lbl', x.label) : null));
    });
    track.appendChild(frag);
    position();
  };
  const position = () => {
    track.style.transform = `translateX(${-(idx * TICK + TICK / 2)}px)`;
    track.querySelectorAll('.tick.sel').forEach(t => t.classList.remove('sel'));
    track.children[idx]?.classList.add('sel');
  };
  const set = (i, commit) => {
    i = Math.max(0, Math.min(vals.length - 1, Math.round(i)));
    const changed = i !== idx;
    idx = i;
    position();
    if (changed) onChange?.(vals[idx], idx);
    if (commit) onCommit?.(vals[idx], idx);
  };

  el.addEventListener('pointerdown', (e) => {
    if (disabled && !el.dataset.grabAuto) return;
    el.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, start: idx, moved: false };
    track.classList.add('dragging');
    el.dispatchEvent(new CustomEvent('dialgrab'));
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 2) drag.moved = true;
    set(drag.start - dx / TICK);
  });
  const end = (e) => {
    if (!drag) return;
    track.classList.remove('dragging');
    // A plain click jumps to the clicked tick.
    if (!drag.moved) {
      const r = el.getBoundingClientRect();
      set(idx + (e.clientX - (r.left + r.width / 2)) / TICK);
    }
    drag = null;
    onCommit?.(vals[idx], idx);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    el.dispatchEvent(new CustomEvent('dialgrab'));
    set(idx + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1), true);
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); el.dispatchEvent(new CustomEvent('dialgrab')); set(idx + step, true); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); el.dispatchEvent(new CustomEvent('dialgrab')); set(idx - step, true); }
  });

  render();
  new ResizeObserver(() => { const before = TICK; fit(); if (before !== TICK) render(); }).observe(el);
  return Object.assign(el, {
    setValues(v, i = 0) { vals = v; idx = Math.max(0, Math.min(v.length - 1, i)); render(); },
    setIndex(i) { idx = Math.max(0, Math.min(vals.length - 1, i)); position(); },
    /** Show the value closest to `target` (used to follow live auto values). */
    follow(target, key = (x) => x.v) {
      if (drag || target == null || !vals.length) return;
      let best = 0, bestD = Infinity;
      vals.forEach((x, i) => { const d = Math.abs(Math.log(Math.max(1e-9, key(x))) - Math.log(Math.max(1e-9, target))); if (d < bestD) { bestD = d; best = i; } });
      if (best !== idx) { idx = best; position(); }
    },
    followLinear(target) {
      if (drag || target == null || !vals.length) return;
      let best = 0, bestD = Infinity;
      vals.forEach((x, i) => { const d = Math.abs(x.v - target); if (d < bestD) { bestD = d; best = i; } });
      if (best !== idx) { idx = best; position(); }
    },
    setDisabled(d) { disabled = d; el.classList.toggle('disabled', d); },
    value: () => vals[idx],
  });
}
