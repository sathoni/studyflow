/**
 * Keeping the installed app up to date by itself.
 *
 * Copied from the Andrea & Mathieu app, where it has kept two phones current
 * since August 2026. The promise: Mathieu adds StudyFlow to his Home Screen
 * once. From then on every change reaches him on its own. He never deletes
 * it, never re-adds it, never sees "please reinstall".
 *
 * This does not happen by default. A naive service worker answers every
 * request from its cache and will happily serve the same old version forever.
 * The pieces that actually make updating work:
 *
 *  1. The cache name contains the build id, so a new build cannot reuse an
 *     old cache by accident.
 *  2. The new worker calls skipWaiting, so it takes over immediately instead
 *     of waiting for every tab to close, which on an installed iPhone app may
 *     be never.
 *  3. The page asks the browser to check for a new worker on launch, and
 *     again each time the app is brought back to the foreground.
 *  4. When a new worker takes control, the page reloads once. Exactly once:
 *     the guards below are what stop that becoming a loop. Never in the
 *     middle of a review session or a quiz: the reload waits until he closes
 *     it (every answer is saved already; this is only about not yanking the
 *     screen from under his thumb).
 *
 * One change from the Andrea version: the very first visit does not reload.
 * There was no worker in charge yet, so the page already runs the newest code,
 * and a reload would only flash the screen (and cost a second on a slow
 * network) for nothing.
 */

/** Replaced at build time with the real build id. */
export const BUILD_ID = '__BUILD_ID__';

export type UpdateState =
  /** Nothing to do; the app is running the newest version it knows of. */
  | 'current'
  /** Asking the server whether there is anything newer. */
  | 'checking'
  /** A new version arrived and the page is about to reload itself. */
  | 'updating'
  /**
   * Automatic updating is not available here: not on HTTPS, or a browser that
   * blocks service workers. The app still works, it just fetches everything
   * fresh each time instead of updating itself in the background.
   */
  | 'unavailable';

export interface UpdateOptions {
  onState?: (state: UpdateState) => void;
}

/** Where the time of the last automatic reload is kept (per tab). */
const RELOADED_AT = 'studyflow.reloadedAt';

/** Two takeovers closer together than this never cause a second reload. */
const RELOAD_GUARD_MS = 10_000;

/**
 * Register the service worker and keep it fresh.
 *
 * Safe to call when service workers are unavailable: it does nothing, and the
 * app still works, just without offline support.
 */
export function startUpdates(options: UpdateOptions = {}): void {
  const report = options.onState ?? (() => {});

  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    report('unavailable');
    return;
  }

  // Was an older worker in charge when this page loaded? If not, this is the
  // first visit and the takeover that follows needs no reload.
  const hadController = navigator.serviceWorker.controller !== null;

  // When a new worker takes over, reload so the screen matches the code.
  // The flag makes this happen once per takeover; the stored time makes sure a
  // worker that keeps replacing itself cannot drag the page into a loop.
  let reloading = false;
  const reloadNow = () => {
    if (reloading || recentlyReloaded()) return;
    reloading = true;
    markReloaded();
    report('updating');
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    // Never in the middle of a review session or a quiz: wait until he closes it.
    if (busy()) whenFree(reloadNow);
    else reloadNow();
  });

  navigator.serviceWorker
    .register(new URL('./sw.js', import.meta.url), { scope: './' })
    .then((registration) => {
      // Check straight away, in case the app sat closed for a week.
      void check(registration, report);

      // And again whenever he comes back to the app. This is the one that
      // matters on a phone: an installed app is usually suspended, not closed,
      // so "on load" alone would almost never fire.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void check(registration, report);
      });

      // A worker that is already waiting should not wait.
      if (registration.waiting) registration.waiting.postMessage({ type: 'skip-waiting' });

      registration.addEventListener('updatefound', () => {
        const incoming = registration.installing;
        if (!incoming) return;
        report('checking');
        incoming.addEventListener('statechange', () => {
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            // A newer version is ready and an older one is in charge.
            incoming.postMessage({ type: 'skip-waiting' });
          }
        });
      });
    })
    .catch(() => {
      // No offline support. Not fatal: the app still runs online.
      report('unavailable');
    });
}

async function check(
  registration: ServiceWorkerRegistration,
  report: (state: UpdateState) => void,
): Promise<void> {
  try {
    report('checking');
    await registration.update();
    report('current');
  } catch {
    // Offline, most likely. We try again next time he opens it.
    report('current');
  }
}

/** A review session or a quiz run is open (shell.ts puts .in-mode on <html>). */
function busy(): boolean {
  return document.documentElement.classList.contains('in-mode');
}

/**
 * Run `fn` once the session or quiz is closed. Switching to another app and
 * back does not count: he may be checking Notion halfway through a quiz. If
 * iOS closes the app meanwhile, the next launch runs the new version anyway.
 */
function whenFree(fn: () => void): void {
  const observer = new MutationObserver(() => {
    if (busy()) return;
    observer.disconnect();
    fn();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

function recentlyReloaded(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    return Date.now() - at < RELOAD_GUARD_MS;
  } catch {
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // Without storage the in-memory flag still prevents a loop within this page.
  }
}
