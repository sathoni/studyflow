/**
 * Sync against a small fake of Supabase's REST interface: headers, paging,
 * cursors, the outbox on the wire, pruning, and the rhythm.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDriver, Store } from './store.ts';
import type { Course, Review } from './model.ts';
import {
  FLUSH_EVERY_RATINGS,
  OVERLAP_MS,
  Rest,
  Syncer,
  advanceCursor,
  keyAccepted,
  pullAll,
  pullQuery,
  pullTable,
  prune,
  toWire,
} from './sync.ts';

const KEY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
const URL_ = 'https://example.supabase.co';

/** A tiny PostgREST: tables of rows, eq/gt filters, order, limit, offset. */
class FakeServer {
  tables = new Map<string, Record<string, unknown>[]>();
  requests: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  acceptKey = KEY;
  offline = false;
  refuse: ((table: string, row: Record<string, unknown>) => boolean) | null = null;
  seq = 0;

  rows(table: string): Record<string, unknown>[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method: init.method ?? 'GET', url: url.toString(), headers, body });
    if (this.offline) throw new TypeError('Failed to fetch');
    const keyOk = headers['x-sf-key'] === this.acceptKey;

    if (url.pathname === '/functions/v1/media') {
      if (!keyOk) return new Response('{"error":"unauthorized"}', { status: 401 });
      const paths = (body as { paths: string[] }).paths;
      return Response.json({ expires_in: 3600, urls: paths.map((p) => ({ path: p, signed_url: `${URL_}/signed/${p}`, error: null })) });
    }

    const table = url.pathname.replace('/rest/v1/', '');
    if (init.method === 'POST') {
      if (!keyOk) return new Response('{"message":"new row violates row-level security policy"}', { status: 401 });
      const rows = body as Record<string, unknown>[];
      for (const row of rows) {
        if (this.refuse?.(table, row)) return new Response('{"message":"violates check constraint"}', { status: 400 });
      }
      const key = table === 'card_marks' ? 'card_id' : 'id';
      for (const row of rows) {
        const existing = this.rows(table).find((r) => r[key] === row[key]);
        if (existing && table === 'card_marks') Object.assign(existing, row, { updated_at: new Date().toISOString() });
        else if (!existing) this.rows(table).push({ ...row, seq: ++this.seq, created_at: new Date().toISOString() });
      }
      return new Response(null, { status: 201 });
    }

    // GET: RLS means a wrong key sees nothing, not an error.
    let rows = keyOk ? [...this.rows(table)] : [];
    let limit = Infinity;
    let offset = 0;
    let order: string[] = [];
    let select: string[] | null = null;
    for (const [k, v] of url.searchParams) {
      if (k === 'limit') limit = Number(v);
      else if (k === 'offset') offset = Number(v);
      else if (k === 'order') order = v.split(',').map((o) => o.split('.')[0]);
      else if (k === 'select') select = v === '*' ? null : v.split(',');
      else if (v.startsWith('gt.')) {
        const bound = v.slice(3);
        rows = rows.filter((r) => (k === 'seq' ? Number(r[k]) > Number(bound) : String(r[k]) > bound));
      }
    }
    rows.sort((a, b) => {
      for (const f of order) {
        const x = a[f] as string | number;
        const y = b[f] as string | number;
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return 0;
    });
    rows = rows.slice(offset, offset + limit);
    if (select) rows = rows.map((r) => Object.fromEntries(select!.map((c) => [c, r[c]])));
    return Response.json(rows);
  };
}

function course(id: string, updated_at: string, name = id): Course & Record<string, unknown> {
  return { id, name, color: '#000', icon: 'x', sort: 1, updated_at };
}

function review(n: number): Review {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    card_id: 'c1',
    reviewed_at: '2026-10-25T20:00:00.000Z',
    day: '2026-10-25',
    result: 'gekend',
    hints_used: 0,
    mode: 'sessie',
    undoes: null,
    ms: 1200,
  };
}

function setup() {
  const server = new FakeServer();
  const store = new Store(new MemoryDriver());
  const rest = new Rest({ key: KEY, url: URL_, apiKey: 'sb_publishable_test', mediaUrl: `${URL_}/functions/v1/media`, fetch: server.fetch });
  return { server, store, rest };
}

test('every request carries apikey (publishable) and x-sf-key, never Authorization', async () => {
  const { server, rest } = setup();
  await rest.select('courses', 'select=id');
  await rest.insert('reviews', [toWire('reviews', review(1))]);
  await rest.signImages(['SCM-H3/p006.webp']);
  for (const r of server.requests) {
    assert.equal(r.headers.apikey, 'sb_publishable_test');
    assert.equal(r.headers['x-sf-key'], KEY);
    assert.equal('Authorization' in r.headers, false);
  }
});

test('inserts: logs ignore duplicates, card_marks merges on card_id, return=minimal', async () => {
  const { server, rest } = setup();
  await rest.insert('reviews', [toWire('reviews', review(1))]);
  await rest.insert('card_marks', [{ card_id: 'c1', starred: true }]);
  const [logs, marks] = server.requests;
  assert.equal(logs.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
  assert.equal(new URL(logs.url).search, '');
  assert.equal(marks.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(new URL(marks.url).searchParams.get('on_conflict'), 'card_id');
});

test('toWire keeps only the columns the database grants', () => {
  const local = { ...review(1), seq: 5, created_at: 'x' };
  assert.deepEqual(Object.keys(toWire('reviews', local)).sort(), [
    'card_id', 'day', 'hints_used', 'id', 'mode', 'ms', 'result', 'reviewed_at', 'undoes',
  ]);
  assert.deepEqual(toWire('card_marks', { card_id: 'c1', starred: true, updated_at: 'x' }), { card_id: 'c1', starred: true });
  assert.deepEqual(Object.keys(toWire('card_flags', { id: '1', card_id: 'c', reason: 'fout', note: null, created_at: 'x', resolved_at: null })).sort(), [
    'card_id', 'id', 'note', 'reason',
  ]);
});

test('pull queries: content with an hour of overlap, logs by seq, slides without their text', () => {
  const q = new URLSearchParams(pullQuery('cards', '2026-10-25T12:00:00.000Z'));
  assert.equal(q.get('updated_at'), `gt.${new Date(Date.parse('2026-10-25T12:00:00Z') - OVERLAP_MS).toISOString()}`);
  assert.equal(q.get('order'), 'id.asc');
  assert.equal(q.has('offset'), false, 'never offset paging');
  const next = new URLSearchParams(pullQuery('slides', '2026-10-25T12:00:00.000Z', 'SCM-H3/p006'));
  assert.equal(next.get('key'), 'gt.SCM-H3/p006', 'the next page starts after the last key');
  assert.equal(q.get('limit'), '1000');
  const logs = new URLSearchParams(pullQuery('reviews', 41));
  assert.equal(logs.get('seq'), 'gt.41');
  assert.equal(logs.get('order'), 'seq.asc');
  assert.equal(new URLSearchParams(pullQuery('reviews', null)).get('seq'), null);
  assert.doesNotMatch(new URLSearchParams(pullQuery('slides', null)).get('select') ?? '', /text/);
  assert.equal(new URLSearchParams(pullQuery('card_flags', '2026-10-25T12:00:00Z')).has('created_at'), true);
  assert.equal(new URLSearchParams(pullQuery('day_plan', null)).get('order'), 'day.asc');
});

test('cursors move to the newest value seen, never back', () => {
  assert.equal(advanceCursor('reviews', [{ seq: 3 }, { seq: 9 }, { seq: 5 }], 4), 9);
  assert.equal(advanceCursor('reviews', [], 4), 4);
  assert.equal(advanceCursor('cards', [{ updated_at: '2026-10-25T10:00:00Z' }], '2026-10-26T00:00:00Z'), '2026-10-26T00:00:00Z');
  assert.equal(advanceCursor('cards', [{ updated_at: '2026-10-27T10:00:00Z' }], null), '2026-10-27T10:00:00Z');
});

test('a pull pages through more rows than one request may return', async () => {
  const { server, store, rest } = setup();
  for (let i = 0; i < 25; i++) {
    server.rows('courses').push(course(`C${String(i).padStart(2, '0')}`, `2026-10-25T10:00:${String(i).padStart(2, '0')}.000Z`));
  }
  for (let i = 1; i <= 23; i++) server.rows('reviews').push({ ...review(i), seq: i });
  assert.equal(await pullTable(store, rest, 'courses', 10), 25);
  assert.equal((await store.all('courses')).length, 25);
  assert.equal(await store.cursor('courses'), '2026-10-25T10:00:24.000Z');
  assert.equal(await pullTable(store, rest, 'reviews', 10), 23);
  assert.equal(await store.cursor('reviews'), 23);

  // Next time only what is new (plus the hour of overlap, which changes nothing).
  server.rows('reviews').push({ ...review(24), seq: 24 });
  assert.equal(await pullTable(store, rest, 'reviews', 10), 1);
  assert.equal(await pullTable(store, rest, 'courses', 10), 0);
});

test('a changed content row arrives on the next pull', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  await pullAll(store, rest);
  server.rows('courses')[0] = course('SCM', '2026-10-25T11:00:00.000Z', 'Supply Chain Management');
  await pullAll(store, rest);
  assert.equal((await store.get('courses', 'SCM'))?.name, 'Supply Chain Management');
});

test('a row the server changes halfway through a pull is not skipped (key paging)', async () => {
  const { server, store } = setup();
  for (let i = 0; i < 25; i++) {
    server.rows('courses').push(course(`C${String(i).padStart(2, '0')}`, `2026-10-25T10:00:${String(i).padStart(2, '0')}.000Z`));
  }
  // After the first page, the routine touches a row of that first page.
  let gets = 0;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const response = await server.fetch(input, init);
    if ((init.method ?? 'GET') === 'GET' && ++gets === 1) {
      server.rows('courses')[2] = course('C02', '2026-10-25T10:05:00.000Z', 'touched');
    }
    return response;
  };
  const rest = new Rest({ key: KEY, url: URL_, apiKey: 'sb_publishable_test', fetch });
  await pullTable(store, rest, 'courses', 10);
  assert.equal((await store.all('courses')).length, 25, 'every row arrived');
  // The touched row comes in on the next pull, thanks to the hour of overlap.
  await pullTable(store, rest, 'courses', 10);
  assert.equal((await store.get('courses', 'C02'))?.name, 'touched');
});

test('a row deleted on the server mid-prune never makes another row disappear', async () => {
  const { server, store } = setup();
  const all = Array.from({ length: 25 }, (_, i) => course(`C${String(i).padStart(2, '0')}`, '2026-10-25T10:00:00.000Z'));
  server.rows('courses').push(...all);
  await store.accept('courses', all);
  let gets = 0;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const response = await server.fetch(input, init);
    if (new URL(String(input)).pathname.endsWith('/courses') && ++gets === 1) {
      server.tables.set('courses', server.rows('courses').filter((r) => r.id !== 'C03'));
    }
    return response;
  };
  const rest = new Rest({ key: KEY, url: URL_, apiKey: 'sb_publishable_test', fetch });
  await prune(store, rest, 10);
  const left = (await store.all('courses')).map((c) => c.id);
  assert.equal(left.includes('C10'), true, 'C10 still exists on the server and must stay');
  assert.equal(left.length >= 24, true);
});

test('a wrong or revoked key reads as empty: keyAccepted says no', async () => {
  const { server, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  assert.equal(await keyAccepted(rest), true);
  server.acceptKey = 'another-key-entirely-123456';
  assert.equal(await keyAccepted(rest), false);
});

test('prune drops local content the server no longer has, and never touches logs', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  await store.accept('courses', [course('SCM', '2026-10-25T10:00:00.000Z'), course('OLD', '2026-10-01T10:00:00.000Z')]);
  await store.accept('reviews', [{ ...review(1), seq: 1 }]);
  const removed = await prune(store, rest);
  assert.deepEqual(removed, { courses: 1 });
  assert.deepEqual((await store.all('courses')).map((c) => c.id), ['SCM']);
  assert.equal((await store.all('reviews')).length, 1);
});

test('syncNow: flush first, then pull; the review comes back with its seq', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  await store.write('reviews', review(1));
  const syncer = new Syncer({ store, rest, online: () => true, now: () => 1_000_000 });
  const states: string[] = [];
  syncer.onState((s) => states.push(s));
  const report = await syncer.syncNow();
  assert.equal(report.state, 'idle');
  assert.equal(report.flushed?.sent, 1);
  assert.equal(await store.pendingCount(), 0);
  assert.equal((await store.get('reviews', review(1).id))?.seq, 1);
  assert.deepEqual(states, ['idle', 'working', 'idle']);
  assert.equal(await syncer.lastSyncAt(), 1_000_000);
  // The POST went before the first GET.
  assert.equal(server.requests[0].method, 'POST');
});

test('offline: nothing is lost, the state says offline', async () => {
  const { server, store, rest } = setup();
  await store.write('reviews', review(1));
  server.offline = true;
  const syncer = new Syncer({ store, rest, online: () => true });
  const report = await syncer.syncNow();
  assert.equal(report.state, 'offline');
  assert.equal(await store.pendingCount(), 1);
  const quiet = new Syncer({ store, rest, online: () => false });
  assert.equal((await quiet.syncNow()).state, 'offline');
});

test('a revoked key: state no-access, outbox kept, no prune', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  await store.accept('courses', [course('SCM', '2026-10-25T10:00:00.000Z')]);
  server.acceptKey = 'revoked-revoked-revoked-revoked';
  const syncer = new Syncer({ store, rest, online: () => true });
  assert.equal((await syncer.syncNow()).state, 'no-access');
  assert.equal((await store.all('courses')).length, 1, 'nothing wiped');
  await store.write('reviews', review(2));
  assert.equal((await syncer.syncNow()).state, 'no-access');
  assert.equal(await store.pendingCount(), 1);
});

test('a refused row is parked after three tries and never blocks the queue', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  server.refuse = (_t, row) => row.ms === -5;
  await store.write('reviews', { ...review(1), ms: -5 }, 1);
  await store.write('reviews', review(2), 2);
  const syncer = new Syncer({ store, rest, online: () => true });
  for (let i = 0; i < 3; i++) assert.equal((await syncer.syncNow()).state, 'idle');
  assert.equal((await store.parked()).length, 1);
  assert.equal(await store.pendingCount(), 0);
  assert.equal(server.rows('reviews').length, 1);
});

test('calls during a sync do not overlap; every 10th rating flushes', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  const syncer = new Syncer({ store, rest, online: () => true });
  const [a, b] = [syncer.syncNow(), syncer.syncNow()];
  assert.equal(a, b);
  await a;

  for (let i = 1; i < FLUSH_EVERY_RATINGS; i++) {
    await store.write('reviews', review(100 + i));
    syncer.noteRating();
  }
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await store.pendingCount(), FLUSH_EVERY_RATINGS - 1, 'nothing sent before the 10th');
  await store.write('reviews', review(200));
  syncer.noteRating();
  await syncer.flushNow();
  assert.equal(await store.pendingCount(), 0);
});

test('start(): syncs on open, on online and when the app comes back; flushes when it leaves', async () => {
  const { server, store, rest } = setup();
  server.rows('courses').push(course('SCM', '2026-10-25T10:00:00.000Z'));
  const handlers = new Map<string, () => void>();
  const win = {
    addEventListener: (t: string, f: () => void) => handlers.set(`w:${t}`, f),
    removeEventListener: (t: string) => handlers.delete(`w:${t}`),
    setInterval: () => 1,
    clearInterval: () => undefined,
  } as unknown as Window;
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t: string, f: () => void) => handlers.set(`d:${t}`, f),
    removeEventListener: (t: string) => handlers.delete(`d:${t}`),
  } as unknown as Document & { visibilityState: string };
  const syncer = new Syncer({ store, rest, online: () => true });
  let rounds = 0;
  syncer.onState((s) => s === 'working' && rounds++);
  const stop = syncer.start(win, doc);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rounds, 1, 'on open');
  handlers.get('w:online')!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rounds, 2, 'on online');

  await store.write('reviews', review(7));
  (doc as { visibilityState: string }).visibilityState = 'hidden';
  handlers.get('d:visibilitychange')!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await store.pendingCount(), 0, 'flushed on leaving');
  stop();
  assert.equal(handlers.size, 0);
});

test('signImages asks the media function with the key', async () => {
  const { server, rest } = setup();
  const urls = await rest.signImages(['SCM-H3/p006.webp']);
  assert.equal(urls[0].signed_url, `${URL_}/signed/SCM-H3/p006.webp`);
  const req = server.requests[0];
  assert.deepEqual(req.body, { action: 'sign_download', paths: ['SCM-H3/p006.webp'] });
});
