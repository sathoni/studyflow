/**
 * The small pieces every screen is made of: course tiles, progress bars, the
 * ring, Doos badges, rich text with the bold key term, headers.
 *
 * Plain functions that return DOM nodes (dom.ts), styled by app.css.
 */

import { h } from './dom.ts';
import { icon } from './icons.ts';
import { boldSegments } from '../lib/text.ts';
import type { Course } from '../lib/model.ts';
import type { Box } from '../lib/leitner.ts';
import { boxLabel } from '../lib/leitner.ts';

/** '#2F6FEB' → 'rgba(47, 111, 235, 0.14)'. Falls back to the primary blue. */
export function soft(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  const n = m ? parseInt(m[1], 16) : 0x2f6bff;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The course colour as CSS variables, for a tile, a chip or a square. */
export function courseVars(course: Pick<Course, 'color'> | undefined): string {
  const color = course?.color || '#2F6BFF';
  return `--cc:${color};--cc-soft:${soft(color, 0.14)};--cc-softer:${soft(color, 0.08)};--cc-dark:${soft(color, 0.24)}`;
}

/** The coloured square with the course icon (Home, Vakken, course header). */
export function courseTile(course: Course | undefined, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const px = size === 'lg' ? 30 : size === 'sm' ? 18 : 22;
  return h('span', {
    class: `tile tile-${size}`,
    style: courseVars(course),
    'aria-hidden': 'true',
    html: icon(course?.icon ?? 'book', px) || icon('book', px),
  });
}

/** A thin rounded progress bar; `share` 0..1. */
export function progressBar(share: number | null, extra = ''): HTMLElement {
  const pct = Math.round(Math.max(0, Math.min(1, share ?? 0)) * 100);
  return h(
    'span',
    { class: `bar ${extra}`.trim(), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
    h('i', { style: `width:${pct}%` }),
  );
}

/** '68%' (or '–' without cards). */
export function pctLabel(share: number | null): string {
  return share === null ? '–' : `${Math.round(share * 100)}%`;
}

/** The progress ring on the greeting card, with the % in the middle. */
export function ring(share: number, size = 64, label?: string): HTMLElement {
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, share));
  const text = label ?? `${Math.round(pct * 100)}%`;
  const wrap = h('span', { class: 'ring', style: `width:${size}px;height:${size}px`, role: 'img', 'aria-label': `${text} gedaan` });
  wrap.innerHTML =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" class="ring-track"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" class="ring-fill" ` +
    `stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}" ` +
    `transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  wrap.appendChild(h('b', { class: 'ring-label', text }));
  return wrap;
}

/** 'Nieuw', 'Doos 3', 'Gekend' as a small coloured pill. */
export function boxBadge(box: Box, extra = ''): HTMLElement {
  return h('span', { class: `badge box-${box} ${extra}`.trim(), text: boxLabel(box) });
}

/** Card text with its **key term** in bold, as text nodes (never HTML). */
export function rich(text: string): Node[] {
  return boldSegments(text).map((s) => (s.bold ? h('strong', { text: s.text }) : document.createTextNode(s.text)));
}

/** A round icon button (close, back, star, menu). */
export function iconButton(name: string, label: string, onClick: (e: Event) => void, extra = ''): HTMLButtonElement {
  return h('button', {
    class: `icon-btn ${extra}`.trim(),
    type: 'button',
    'aria-label': label,
    title: label,
    html: icon(name, 22),
    on: { click: onClick },
  });
}

/** The big page title ("Vakken", "Quiz", "Voortgang", "Profiel"). */
export function pageTitle(title: string, right?: Node | null): HTMLElement {
  return h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: title }), right ?? null);
}

/** A section heading inside a page, with an optional small action on the right. */
export function sectionTitle(title: string, right?: Node | null): HTMLElement {
  return h('div', { class: 'section-head' }, h('h2', { text: title }), right ?? null);
}

/** A calm empty state. */
export function emptyState(iconName: string, title: string, text?: string, action?: Node | null): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty-icon', html: icon(iconName, 28) }),
    h('p', { class: 'empty-title', text: title }),
    text ? h('p', { class: 'empty-text', text }) : null,
    action ?? null,
  );
}

/** A small chip ("SCM H3 · dia 114"). */
export function chip(text: string, extra = ''): HTMLElement {
  return h('span', { class: `chip ${extra}`.trim(), text });
}

/** '1 vraag' / '10 vragen'. */
export function questionsLabel(n: number): string {
  return n === 1 ? '1 vraag' : `${n} vragen`;
}

/** '1 hoofdstuk' / '4 hoofdstukken'. */
export function chaptersLabel(n: number): string {
  return n === 1 ? '1 hoofdstuk' : `${n} hoofdstukken`;
}

/** A short, calm vibration on phones that allow it (Android); iOS ignores it. */
export function buzz(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not available: nothing to do.
  }
}

/** Does the person prefer less motion? */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
