/**
 * The personal link instead of a login (SPEC-v3 §2 "Personal link").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_STORAGE,
  adoptKey,
  authHeaders,
  extractKey,
  forgetKey,
  isDemoHash,
  isPlausibleKey,
  resolveAccess,
  withKeyInUrl,
  type AccessEnv,
} from './access.ts';
import { SUPABASE_KEY } from './server-config.ts';

const KEY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'; // 43 chars, base64url
const KEY2 = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e';

function memory(initial: Record<string, string> = {}): NonNullable<AccessEnv['storage']> & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('a key in the address is used and remembered', () => {
  const storage = memory();
  const access = resolveAccess({ search: `?k=${KEY}`, hash: '', storage });
  assert.deepEqual(access, { mode: 'key', key: KEY, source: 'url' });
  assert.equal(storage.data.get(KEY_STORAGE), KEY);
});

test('every launch from the Home Screen icon reads the key again; a new link replaces the old key', () => {
  const storage = memory({ [KEY_STORAGE]: KEY });
  const access = resolveAccess({ search: `?k=${KEY2}`, hash: '', storage });
  assert.equal(access.mode === 'key' && access.key, KEY2);
  assert.equal(storage.data.get(KEY_STORAGE), KEY2);
});

test('without a key in the address the remembered one is used', () => {
  const access = resolveAccess({ search: '', hash: '', storage: memory({ [KEY_STORAGE]: KEY }) });
  assert.deepEqual(access, { mode: 'key', key: KEY, source: 'stored' });
});

test('no key anywhere: the "open via your link" screen', () => {
  assert.deepEqual(resolveAccess({ search: '', hash: '', storage: memory() }), { mode: 'none', reason: 'missing' });
  assert.deepEqual(resolveAccess({ search: '', hash: '', storage: null }), { mode: 'none', reason: 'missing' });
});

test('a damaged link falls back to the remembered key, otherwise says it is damaged', () => {
  assert.equal(resolveAccess({ search: '?k=abc', hash: '', storage: memory({ [KEY_STORAGE]: KEY }) }).mode, 'key');
  assert.deepEqual(resolveAccess({ search: '?k=abc', hash: '', storage: memory() }), { mode: 'none', reason: 'malformed' });
});

test('#demo always works, without a key', () => {
  assert.deepEqual(resolveAccess({ search: '', hash: '#demo', storage: null }), { mode: 'demo' });
  assert.equal(isDemoHash('#demo/quiz'), true);
  assert.equal(isDemoHash('#demolition'), false);
});

test('storage that throws (private mode) does not break the launch', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(resolveAccess({ search: `?k=${KEY}`, hash: '', storage: broken }).mode, 'key');
  assert.equal(resolveAccess({ search: '', hash: '', storage: broken }).mode, 'none');
  forgetKey(broken);
});

test('the paste field accepts the whole link or the bare key', () => {
  assert.equal(extractKey(`https://sathoni.github.io/studyflow/?k=${KEY}`), KEY);
  assert.equal(extractKey(`  "${KEY}"  `), KEY);
  assert.equal(extractKey(`<https://sathoni.github.io/studyflow/?x=1&k=${KEY}#demo>`), KEY);
  assert.equal(extractKey('hallo'), null);
  assert.equal(isPlausibleKey('short'), false);
  assert.equal(isPlausibleKey('has spaces in it but long enough'), false);
});

test('a pasted key goes into the address bar too, so Add to Home Screen keeps it', () => {
  const storage = memory();
  let replaced = '';
  const ok = adoptKey(KEY, { storage, href: 'https://sathoni.github.io/studyflow/#home', replace: (u) => (replaced = u) });
  assert.equal(ok, true);
  assert.equal(replaced, `https://sathoni.github.io/studyflow/?k=${KEY}#home`);
  assert.equal(storage.data.get(KEY_STORAGE), KEY);
  assert.equal(withKeyInUrl(`https://x.test/a/?k=${KEY2}&v=2`, KEY), `https://x.test/a/?k=${KEY}&v=2`);
});

test('every request: apikey = the publishable key, plus x-sf-key; no Authorization header', () => {
  const headers = authHeaders(KEY);
  assert.deepEqual(headers, { apikey: SUPABASE_KEY, 'x-sf-key': KEY });
  assert.match(SUPABASE_KEY, /^sb_publishable_/);
});
