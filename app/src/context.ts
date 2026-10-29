/**
 * What every screen gets: the store, the actions, the images, the sync state.
 *
 * Built once at launch (app.ts) and passed down, so a screen never has to know
 * whether it runs on the real server or on the demo.
 */

import type { Store } from './lib/store.ts';
import type { Actions, Snapshot } from './lib/data.ts';
import type { Images } from './lib/images.ts';
import type { Rest, SyncState, Syncer } from './lib/sync.ts';

export type Theme = 'systeem' | 'licht' | 'donker';

export interface AppContext {
  mode: 'real' | 'demo';
  store: Store;
  actions: Actions;
  images: Images;
  /** null in demo mode: nothing is ever sent. */
  syncer: Syncer | null;
  /** The server calls with his key (reminders); null in demo mode. */
  rest: Rest | null;
  /** Everything on the phone right now (instant, never waits for the network). */
  snapshot(): Promise<Snapshot>;
  /** Hear about the sync state (offline banner, "laatste update …"). */
  onSync(listener: (state: SyncState, detail?: string) => void): () => void;
  /** True when IndexedDB was not available and the app runs on memory. */
  degraded: boolean;
}

export const THEME_STORAGE = 'studyflow.theme';

/** The chosen theme (Profiel → Donkere modus); 'systeem' follows the phone. */
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE);
    return value === 'licht' || value === 'donker' ? value : 'systeem';
  } catch {
    return 'systeem';
  }
}

/** Apply and remember a theme. index.html applies the stored one before the first paint. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'systeem') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme === 'donker' ? 'dark' : 'light');
  // The status bar follows a forced theme too (index.html has one colour per scheme).
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.dataset.scheme ?? (meta.media.includes('dark') ? 'dark' : 'light');
    meta.dataset.scheme = scheme;
    const own = scheme === 'dark' ? '#0B1020' : '#F4F6FB';
    meta.content = theme === 'systeem' ? own : theme === 'donker' ? '#0B1020' : '#F4F6FB';
  }
  try {
    if (theme === 'systeem') localStorage.removeItem(THEME_STORAGE);
    else localStorage.setItem(THEME_STORAGE, theme);
  } catch {
    // Not remembered; it still applies for this launch.
  }
}
