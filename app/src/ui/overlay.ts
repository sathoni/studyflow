/**
 * Things that float over a screen: the bottom sheet (score an instrument,
 * report a card, preview a card) and the toast ("Ongedaan maken").
 *
 * The sheet slides up and dims the screen behind it. It closes on the grey
 * backdrop, on its ✕ and on Escape. Under reduced motion it simply appears.
 */

import { h } from './dom.ts';
import { icon } from './icons.ts';

export interface SheetOptions {
  title: string;
  /** Called after the sheet is gone, however it was closed. */
  onClose?: () => void;
  /** 'tall' for content that needs most of the screen (card preview). */
  size?: 'auto' | 'tall';
  /** Extra class on the panel. */
  className?: string;
}

export interface SheetHandle {
  close(): void;
  body: HTMLElement;
  panel: HTMLElement;
}

let openSheets = 0;
const handles = new Set<() => void>();

/** Close every open sheet (another screen is being opened). */
export function closeAllSheets(): void {
  for (const close of [...handles]) close();
}

export function openSheet(options: SheetOptions, ...content: (Node | null | false)[]): SheetHandle {
  const body = h('div', { class: 'sheet-body' });
  for (const node of content) if (node) body.appendChild(node);

  const panel = h(
    'div',
    {
      class: `sheet sheet-${options.size ?? 'auto'} ${options.className ?? ''}`.trim(),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': options.title,
      tabindex: '-1',
    },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'sheet-head' },
      h('h2', { class: 'sheet-title', text: options.title }),
      h('button', {
        class: 'icon-btn sheet-close',
        type: 'button',
        'aria-label': 'Sluiten',
        html: icon('close', 20),
        on: { click: () => close() },
      }),
    ),
    body,
  );
  const backdrop = h('div', { class: 'sheet-backdrop', on: { click: () => close() } });
  const layer = h('div', { class: 'sheet-layer' }, backdrop, panel);

  const previousFocus = document.activeElement as HTMLElement | null;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    handles.delete(close);
    document.removeEventListener('keydown', onKey, true);
    layer.classList.remove('open');
    openSheets = Math.max(0, openSheets - 1);
    if (openSheets === 0) document.documentElement.classList.remove('sheet-open');
    const done = () => {
      layer.remove();
      previousFocus?.focus?.({ preventScroll: true });
      options.onClose?.();
    };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) done();
    else setTimeout(done, 240);
  }

  document.body.appendChild(layer);
  handles.add(close);
  openSheets++;
  document.documentElement.classList.add('sheet-open');
  document.addEventListener('keydown', onKey, true);
  // Next frame, so the slide-up transition runs.
  requestAnimationFrame(() => {
    layer.classList.add('open');
    panel.focus({ preventScroll: true });
  });

  return { close, body, panel };
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */

export interface ToastOptions {
  action?: { label: string; run: () => void | Promise<void> };
  /** Milliseconds before it goes by itself. */
  duration?: number;
  icon?: string;
}

let current: { el: HTMLElement; timer: number } | null = null;

/** Dismiss whatever toast is showing. */
export function hideToast(): void {
  if (!current) return;
  const { el, timer } = current;
  clearTimeout(timer);
  current = null;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 220);
}

/**
 * A short line at the bottom of the screen. One at a time: a new toast
 * replaces the old one. "Ongedaan maken" stays 6 s (SPEC-v3 §2).
 */
export function toast(text: string, options: ToastOptions = {}): () => void {
  hideToast();
  const el = h(
    'div',
    { class: 'toast', role: 'status', 'aria-live': 'polite' },
    options.icon ? h('span', { class: 'toast-icon', html: icon(options.icon, 18) }) : null,
    h('span', { class: 'toast-text', text }),
    options.action
      ? h('button', {
          class: 'toast-action',
          type: 'button',
          text: options.action.label,
          on: {
            click: async () => {
              const run = options.action!.run;
              hideToast();
              await run();
            },
          },
        })
      : null,
  );
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const timer = window.setTimeout(hideToast, options.duration ?? (options.action ? 6000 : 2600));
  current = { el, timer };
  return hideToast;
}
