/**
 * Access without a login: the personal link (SPEC-v3 §2, "Personal link").
 *
 * Mathieu gets one link, https://sathoni.github.io/studyflow/?k=<KEY>, opens it
 * in Safari and adds it to his Home Screen. The manifest has no start_url, so
 * the icon keeps the whole address, key included.
 *
 *   Each launch    read `k` from location.search and keep it in localStorage.
 *                  The query is NEVER stripped from the address: the icon on
 *                  the Home Screen must keep it.
 *   Each request   apikey = the publishable key (role anon) plus the header
 *                  x-sf-key = KEY. The database checks it in every policy.
 *   No key         one calm screen, "Open StudyFlow via je persoonlijke link",
 *                  with a paste field as the fallback.
 *   #demo          always works, without a key and without the network.
 *
 * Every function takes its surroundings as arguments, with the browser as the
 * default, so the tests can run them in Node.
 */

import { SUPABASE_KEY } from './server-config.ts';

/** Where the key is remembered on this phone. */
export const KEY_STORAGE = 'studyflow.key';

/** The bit of the browser this file needs. */
export interface AccessEnv {
  search: string;
  hash: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/** What the app runs on. */
export type Access =
  | { mode: 'demo' }
  | { mode: 'key'; key: string; source: 'url' | 'stored' }
  | { mode: 'none'; reason: 'missing' | 'malformed' };

/** localStorage can throw (blocked storage, some private modes); null then. */
function safeStorage(): AccessEnv['storage'] {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function browserEnv(): AccessEnv {
  return { search: location.search, hash: location.hash, storage: safeStorage() };
}

/** `#demo`, or a deeper demo address such as `#demo/quiz`. */
export function isDemoHash(hash: string): boolean {
  return /^#demo(\/|$)/.test(hash);
}

/**
 * Does this look like a key? 32 random bytes in base64url are 43 characters;
 * anything from 20 to 200 characters of the base64url alphabet is accepted, so
 * a future longer key needs no app change.
 */
export function isPlausibleKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(value);
}

function read(storage: AccessEnv['storage']): string | null {
  try {
    return storage?.getItem(KEY_STORAGE) ?? null;
  } catch {
    return null;
  }
}

function remember(storage: AccessEnv['storage'], key: string): boolean {
  try {
    storage?.setItem(KEY_STORAGE, key);
    return storage !== null;
  } catch {
    return false;
  }
}

/**
 * Decide, at launch, what the app runs on.
 *
 * A key in the address always wins and is remembered (a new link after a
 * leaked one simply replaces the old key). Without one, the remembered key is
 * used. The address itself is left exactly as it is.
 */
export function resolveAccess(env: AccessEnv = browserEnv()): Access {
  if (isDemoHash(env.hash)) return { mode: 'demo' };
  const fromUrl = new URLSearchParams(env.search).get('k');
  if (fromUrl !== null) {
    const trimmed = fromUrl.trim();
    if (isPlausibleKey(trimmed)) {
      remember(env.storage, trimmed);
      return { mode: 'key', key: trimmed, source: 'url' };
    }
    // A damaged link (cut off in a message). A good remembered key still works.
    const stored = read(env.storage);
    if (isPlausibleKey(stored)) return { mode: 'key', key: stored, source: 'stored' };
    return { mode: 'none', reason: 'malformed' };
  }
  const stored = read(env.storage);
  if (isPlausibleKey(stored)) return { mode: 'key', key: stored, source: 'stored' };
  return { mode: 'none', reason: 'missing' };
}

/** The key in use right now (null in demo mode or without a key). */
export function currentKey(env: AccessEnv = browserEnv()): string | null {
  const access = resolveAccess(env);
  return access.mode === 'key' ? access.key : null;
}

/**
 * The paste fallback on the "no key" screen: accepts the whole link or the
 * bare key, with stray spaces or quotes around it. Null when nothing usable
 * is in it.
 */
export function extractKey(pasted: string): string | null {
  const text = pasted.trim().replace(/^["'<]+|["'>]+$/g, '');
  const match = /[?&#]k=([^&#\s]+)/.exec(text);
  const candidate = match ? decodeURIComponent(match[1]) : text;
  return isPlausibleKey(candidate) ? candidate : null;
}

/** The address with ?k=<key> set, everything else (path, other params, hash) kept. */
export function withKeyInUrl(href: string, key: string): string {
  const url = new URL(href);
  url.searchParams.set('k', key);
  return url.toString();
}

/**
 * Use a pasted key: remember it and put it in the address bar (without
 * reloading), so "Add to Home Screen" from here keeps it as well.
 * Returns false when this phone cannot remember anything.
 */
export function adoptKey(
  key: string,
  env: { storage: AccessEnv['storage']; href: string; replace: (url: string) => void } = {
    storage: safeStorage(),
    href: location.href,
    replace: (url) => history.replaceState(history.state, '', url),
  },
): boolean {
  if (!isPlausibleKey(key)) return false;
  const ok = remember(env.storage, key);
  try {
    env.replace(withKeyInUrl(env.href, key));
  } catch {
    // The address bar is only a convenience; the remembered key is what counts.
  }
  return ok;
}

/** Forget the remembered key (a link that turned out to be revoked). */
export function forgetKey(storage: AccessEnv['storage'] = safeStorage()): void {
  try {
    storage?.removeItem(KEY_STORAGE);
  } catch {
    // Nothing remembered then, which is what we wanted.
  }
}

/**
 * The headers every request to Supabase carries.
 *
 * Only `apikey`: a publishable key (sb_publishable_…) is not a JWT and must
 * not go in Authorization. It makes the request run as the role `anon`; the
 * personal key in x-sf-key is what the policies check.
 */
export function authHeaders(key: string, apiKey: string = SUPABASE_KEY): Record<string, string> {
  return { apikey: apiKey, 'x-sf-key': key };
}
