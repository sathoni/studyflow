/**
 * The full-screen image viewer: tap a card visual and the whole slide opens,
 * zoomed in on the part the card is about. Pinch or double-tap to zoom, drag
 * to move, ✕ / Escape / swipe down at full view to close.
 *
 * Pointer events, so a mouse wheel and a trackpad work on the laptop too.
 */

import { h } from './dom.ts';
import { icon } from './icons.ts';
import type { Crop } from '../lib/model.ts';
import { normalizeCrop } from '../lib/images.ts';

export interface ViewerOptions {
  src: string;
  /** The full page's size in pixels (slides.w / slides.h). */
  w: number;
  h: number;
  crop?: Crop | null;
  caption?: string | null;
}

export function openViewer(options: ViewerOptions): () => void {
  const w = options.w > 0 ? options.w : 2000;
  const hgt = options.h > 0 ? options.h : 1125;

  const img = h('img', {
    class: 'viewer-img',
    src: options.src,
    alt: options.caption ?? 'Afbeelding van de dia',
    draggable: 'false',
    style: `width:${w}px;height:${hgt}px`,
  });
  const stage = h('div', { class: 'viewer-stage' }, img);
  const closeBtn = h('button', {
    class: 'viewer-close',
    type: 'button',
    'aria-label': 'Sluiten',
    html: icon('close', 24),
    on: { click: () => close() },
  });
  const layer = h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Afbeelding' },
    stage,
    closeBtn,
    options.caption ? h('p', { class: 'viewer-caption', text: options.caption }) : null,
    h('p', { class: 'viewer-help', text: 'Knijp of tik dubbel om te zoomen' }),
  );

  let s = 1;
  let tx = 0;
  let ty = 0;

  const size = () => ({ sw: stage.clientWidth || window.innerWidth, sh: stage.clientHeight || window.innerHeight });
  const pageScale = () => {
    const { sw, sh } = size();
    return Math.min(sw / w, sh / hgt);
  };

  function apply(animate = false): void {
    img.style.transition = animate ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }

  /** Keep the picture on screen: centred when smaller, edges never pulled inside when larger. */
  function clamp(): void {
    const { sw, sh } = size();
    const min = pageScale() * 0.9;
    const max = pageScale() * 10;
    s = Math.max(min, Math.min(max, s));
    const iw = w * s;
    const ih = hgt * s;
    tx = iw <= sw ? (sw - iw) / 2 : Math.min(0, Math.max(sw - iw, tx));
    ty = ih <= sh ? (sh - ih) / 2 : Math.min(0, Math.max(sh - ih, ty));
  }

  function fitCrop(): void {
    const { sw, sh } = size();
    const [x0, y0, x1, y1] = normalizeCrop(options.crop);
    const cw = (x1 - x0) * w;
    const ch = (y1 - y0) * hgt;
    s = Math.min((sw * 0.94) / cw, (sh * 0.78) / ch);
    tx = (sw - cw * s) / 2 - x0 * w * s;
    ty = (sh - ch * s) / 2 - y0 * hgt * s;
    clamp();
  }

  function fitPage(): void {
    s = pageScale();
    clamp();
  }

  function zoomAt(factor: number, cx: number, cy: number): void {
    const next = s * factor;
    tx = cx - ((cx - tx) * next) / s;
    ty = cy - ((cy - ty) * next) / s;
    s = next;
    clamp();
  }

  // Pointers: one drags, two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let lastTap = 0;
  let moved = 0;
  let pinchDist = 0;

  stage.addEventListener('pointerdown', (e: PointerEvent) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  stage.addEventListener('pointermove', (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const rect = stage.getBoundingClientRect();
    if (pointers.size === 1) {
      tx += e.clientX - prev.x;
      ty += e.clientY - prev.y;
      moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      clamp();
      apply();
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt(dist / pinchDist, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
    pinchDist = dist;
    moved += 10;
    apply();
  });

  const release = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (pointers.size > 0) return;
    if (moved < 8) {
      const now = Date.now();
      if (now - lastTap < 320) {
        // Double tap: zoom in at the finger, or back to the whole page.
        const rect = stage.getBoundingClientRect();
        if (s > pageScale() * 1.6) fitPage();
        else zoomAt(2.5, e.clientX - rect.left, e.clientY - rect.top);
        apply(true);
        lastTap = 0;
        return;
      }
      lastTap = now;
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  stage.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top);
      apply();
    },
    { passive: false },
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const onResize = () => {
    clamp();
    apply();
  };

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    layer.classList.remove('open');
    setTimeout(() => layer.remove(), 200);
  }

  document.body.appendChild(layer);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  requestAnimationFrame(() => {
    fitCrop();
    apply();
    layer.classList.add('open');
    closeBtn.focus({ preventScroll: true });
  });
  return close;
}
