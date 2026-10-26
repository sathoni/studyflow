/**
 * The frame around the screens: the bottom tab bar (Home · Vakken · Quiz ·
 * Voortgang · Profiel), the address after the # (so the phone's back works
 * and a reload stays on the same screen), and redrawing.
 *
 * Two kinds of screen:
 *   pages   drawn from the snapshot, redrawn whenever the data changes (a
 *           sync, an answer), keeping the scroll position;
 *   modes   the review session and the quiz run: full screen, no tab bar,
 *           they keep their own state and ignore redraws until they close.
 *
 * Addresses: '#/vakken', '#/vak/SCM', … and in the demo '#demo/vakken'. The
 * ?k= key in the address is never touched (SPEC-v3 "Personal link").
 */

import { h, fill } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { closeAllSheets, hideToast } from '../ui/overlay.ts';
import type { AppContext } from '../context.ts';
import type { Snapshot } from '../lib/data.ts';
import { derive, type Derived } from './derive.ts';

export interface PageEnv {
  ctx: AppContext;
  s: Snapshot;
  d: Derived;
  /** The parts of the address after the screen name. */
  params: string[];
  /** Open another screen (pushes onto the phone's back history). */
  go(path: string, options?: { replace?: boolean }): void;
  /** Back to where he came from, or to `fallback` when he arrived here directly. */
  back(fallback: string): void;
  /** Draw the current page again from fresh data, keeping the scroll position. */
  redraw(): void;
  /** Change the address without a new history entry and redraw (tabs inside a page). */
  replace(path: string): void;
}

export type PageFn = (env: PageEnv) => Node;

export interface ModeHandle {
  el: HTMLElement;
  dispose?(): void;
}

export type ModeFn = (env: PageEnv) => ModeHandle;

export type TabId = 'home' | 'vakken' | 'quiz' | 'voortgang' | 'profiel';

export interface PageSpec {
  tab: TabId;
  render: PageFn;
}

const TABS: { id: TabId; label: string; icon: string; path: string }[] = [
  { id: 'home', label: 'Home', icon: 'home', path: '' },
  { id: 'vakken', label: 'Vakken', icon: 'courses', path: 'vakken' },
  { id: 'quiz', label: 'Quiz', icon: 'quiz', path: 'quiz' },
  { id: 'voortgang', label: 'Voortgang', icon: 'progress', path: 'voortgang' },
  { id: 'profiel', label: 'Profiel', icon: 'profile', path: 'profiel' },
];

interface Route {
  name: string;
  params: string[];
  path: string;
}

export class Shell {
  private ctx: AppContext;
  private root: HTMLElement;
  private pages: Record<string, PageSpec>;
  private modes: Record<string, ModeFn>;
  private token = 0;
  private mode: ModeHandle | null = null;
  private pageEl: HTMLElement | null = null;
  private tabbar: HTMLElement | null = null;
  private scrollMemory = new Map<string, number>();
  private currentPath: string | null = null;
  private currentIsMode = false;
  private redrawTimer: number | null = null;
  private stopped = false;

  constructor(ctx: AppContext, root: HTMLElement, pages: Record<string, PageSpec>, modes: Record<string, ModeFn>) {
    this.ctx = ctx;
    this.root = root;
    this.pages = pages;
    this.modes = modes;
  }

  /** Start: draw the screen in the address, then follow back/forward. */
  async start(): Promise<void> {
    const route = this.parse(location.hash);
    // A session or quiz never resumes from a cold start: its state is gone.
    if (this.modes[route.name]) history.replaceState({ sf: 0 }, '', this.hashFor(''));
    else if (!history.state || typeof history.state.sf !== 'number') history.replaceState({ sf: 0 }, '', location.href);
    window.addEventListener('popstate', () => void this.render('back'));
    document.addEventListener('visibilitychange', () => {
      // Back after a while: the study day may have rolled over (04:00).
      if (document.visibilityState === 'visible') this.scheduleRedraw(50);
    });
    await this.render('nav');
  }

  /** The key was refused: stop drawing, another screen takes over. */
  stop(): void {
    this.stopped = true;
    this.disposeMode();
  }

  /** Data changed (sync, answer): redraw the page soon, never a mode. */
  scheduleRedraw(delay = 150): void {
    if (this.currentIsMode) return;
    if (this.redrawTimer !== null) clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      void this.render('redraw');
    }, delay);
  }

  hashFor(path: string): string {
    const clean = path.replace(/^\/+/, '');
    if (this.ctx.mode === 'demo') return clean ? `#demo/${clean}` : '#demo';
    return `#/${clean}`;
  }

  private parse(hash: string): Route {
    const raw = hash.replace(/^#demo/, '').replace(/^#/, '').replace(/^\/+/, '');
    const parts = raw
      .split('/')
      .filter(Boolean)
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          return p;
        }
      });
    const name = parts[0] ?? '';
    const known = name === '' || this.pages[name] || this.modes[name];
    return known ? { name, params: parts.slice(1), path: parts.join('/') } : { name: '', params: [], path: '' };
  }

  go(path: string, options: { replace?: boolean } = {}): void {
    if (this.currentPath !== null && !this.currentIsMode) this.scrollMemory.set(this.currentPath, window.scrollY);
    const depth = (history.state?.sf ?? 0) as number;
    const url = this.hashFor(path);
    if (options.replace) history.replaceState({ sf: depth }, '', url);
    else history.pushState({ sf: depth + 1 }, '', url);
    void this.render('nav');
  }

  back(fallback: string): void {
    if (((history.state?.sf ?? 0) as number) > 0) history.back();
    else this.go(fallback, { replace: true });
  }

  private env(s: Snapshot, d: Derived, route: Route): PageEnv {
    return {
      ctx: this.ctx,
      s,
      d,
      params: route.params,
      go: (path, options) => this.go(path, options),
      back: (fallback) => this.back(fallback),
      redraw: () => void this.render('redraw'),
      replace: (path) => {
        const depth = (history.state?.sf ?? 0) as number;
        history.replaceState({ sf: depth }, '', this.hashFor(path));
        void this.render('redraw');
      },
    };
  }

  private async render(kind: 'nav' | 'redraw' | 'back'): Promise<void> {
    if (this.stopped) return;
    const token = ++this.token;
    const route = this.parse(location.hash);
    if (kind === 'redraw' && this.currentIsMode && route.path === this.currentPath) return;
    if (kind !== 'redraw') closeAllSheets();
    const s = await this.ctx.snapshot();
    if (token !== this.token || this.stopped) return;
    const d = derive(s);
    const env = this.env(s, d, route);

    const modeFn = this.modes[route.name];
    if (modeFn) {
      if (kind !== 'redraw' || route.path !== this.currentPath) {
        if (this.currentPath !== null && !this.currentIsMode) this.scrollMemory.set(this.currentPath, window.scrollY);
        this.disposeMode();
        hideToast();
        const handle = modeFn(env);
        this.mode = handle;
        this.pageEl = null;
        this.tabbar = null;
        document.documentElement.classList.add('in-mode');
        fill(this.root, handle.el);
        window.scrollTo(0, 0);
      }
      this.currentPath = route.path;
      this.currentIsMode = true;
      return;
    }

    const spec = this.pages[route.name] ?? this.pages[''];
    let node: Node;
    try {
      node = spec.render(env);
    } catch (error) {
      console.error(error);
      node = h('div', { class: 'page-error' }, h('p', { text: 'Dit scherm kon niet getekend worden.' }), h('p', { class: 'muted small', text: String(error) }));
    }
    if (token !== this.token) return;

    const wasMode = this.currentIsMode;
    if (wasMode) {
      this.disposeMode();
      hideToast();
    }
    document.documentElement.classList.remove('in-mode');
    if (!this.pageEl || !this.tabbar || !this.root.contains(this.pageEl)) this.buildFrame();

    const y = window.scrollY;
    fill(this.pageEl!, node);
    this.markTab(spec.tab);

    if (kind === 'redraw' && this.currentPath === route.path) {
      window.scrollTo(0, y);
    } else if (kind === 'back' || wasMode) {
      window.scrollTo(0, this.scrollMemory.get(route.path) ?? 0);
    } else {
      window.scrollTo(0, 0);
    }
    this.currentPath = route.path;
    this.currentIsMode = false;
  }

  private disposeMode(): void {
    try {
      this.mode?.dispose?.();
    } catch (error) {
      console.error(error);
    }
    this.mode = null;
  }

  private buildFrame(): void {
    this.pageEl = h('main', { class: 'page', id: 'page' });
    this.tabbar = h(
      'nav',
      { class: 'tabbar', 'aria-label': 'Hoofdmenu' },
      TABS.map((t) =>
        h(
          'a',
          {
            class: 'tab',
            href: this.hashFor(t.path),
            dataset: { tab: t.id },
            on: {
              click: (event: MouseEvent) => {
                event.preventDefault();
                const route = this.parse(location.hash);
                const active = (this.pages[route.name] ?? this.pages['']).tab === t.id;
                if (active && route.path === t.path) {
                  // Tapping the tab you are on scrolls back to the top, as on iOS.
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                  return;
                }
                this.go(t.path, { replace: active });
              },
            },
          },
          h('span', { class: 'tab-icon tab-off', html: icon(t.icon, 25) }),
          h('span', { class: 'tab-icon tab-on', html: icon(`${t.icon}On`, 25) }),
          h('span', { class: 'tab-label', text: t.label }),
        ),
      ),
    );
    fill(this.root, h('div', { class: 'shell' }, this.pageEl, this.tabbar));
  }

  private markTab(tab: TabId): void {
    for (const el of this.tabbar?.querySelectorAll<HTMLElement>('.tab') ?? []) {
      const on = el.dataset.tab === tab;
      el.classList.toggle('active', on);
      if (on) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  }
}
