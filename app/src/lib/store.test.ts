/**
 * The local store and its outbox: local first, resend-safe, and one bad row
 * never blocks the rest (parked after three refusals).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDriver, FallbackDriver, Store, MAX_REFUSALS, classifyFailure, OUTBOX } from './store.ts';
import type { CardMark, Course, Review, TableName } from './model.ts';

const T = '2026-10-25T20:00:00.000Z';

function review(n: number, extra: Partial<Review> = {}): Review {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    card_id: 'c1',
    reviewed_at: T,
    day: '2026-10-25',
    result: 'gekend',
    hints_used: 0,
    mode: 'sessie',
    undoes: null,
    ms: 1000,
    ...extra,
  };
}

const course = (id: string, name = id): Course => ({ id, name, color: '#000', icon: 'x', sort: 1, updated_at: T });

test('a write is on the phone at once and queued for the server', async () => {
  const store = new Store(new MemoryDriver());
  await store.write('reviews', review(1));
  assert.equal((await store.all('reviews')).length, 1);
  assert.equal(await store.pendingCount(), 1);
});

test('content tables are written by the server only', async () => {
  const store = new Store(new MemoryDriver());
  await assert.rejects(store.write('courses', course('SCM')), /server only/);
});

test('accept counts only rows that really changed and tells the screens', async () => {
  const store = new Store(new MemoryDriver());
  const seen: TableName[] = [];
  store.onChange((t) => seen.push(t));
  assert.equal(await store.accept('courses', [course('SCM'), course('FB')]), 2);
  assert.equal(await store.accept('courses', [course('SCM'), course('FB')]), 0);
  assert.equal(await store.accept('courses', [course('SCM', 'Supply Chain')]), 1);
  assert.deepEqual(seen, ['courses', 'courses']);
});

test('a star not yet sent is not overwritten by an older server copy', async () => {
  const store = new Store(new MemoryDriver());
  const mine: CardMark = { card_id: 'c1', starred: true, updated_at: T };
  await store.write('card_marks', mine);
  await store.accept('card_marks', [{ card_id: 'c1', starred: false, updated_at: '2026-10-01T00:00:00Z' }]);
  assert.equal((await store.get('card_marks', 'c1'))?.starred, true);
});

test('a star toggled twice is sent once, as it finally stands', async () => {
  const store = new Store(new MemoryDriver());
  await store.write('card_marks', { card_id: 'c1', starred: true, updated_at: T });
  await store.write('card_marks', { card_id: 'c1', starred: false, updated_at: T });
  const sent: unknown[][] = [];
  await store.flush(async (_t, rows) => void sent.push(rows));
  assert.deepEqual(sent, [[{ card_id: 'c1', starred: false, updated_at: T }]]);
});

test('a star changed while it is being sent stays queued and goes out again', async () => {
  const store = new Store(new MemoryDriver());
  await store.write('card_marks', { card_id: 'c1', starred: true, updated_at: T });
  const sent: unknown[][] = [];
  await store.flush(async (_t, rows) => {
    sent.push(rows);
    // He taps the star again while the first send is on its way.
    if (sent.length === 1) await store.write('card_marks', { card_id: 'c1', starred: false, updated_at: T });
  });
  assert.equal(await store.pendingCount(), 1, 'the newer state is still waiting');
  await store.flush(async (_t, rows) => void sent.push(rows));
  assert.deepEqual(sent.map((rows) => (rows[0] as CardMark).starred), [true, false]);
  assert.equal(await store.pendingCount(), 0);
});

test('a review sent twice (answer lost on the way back) is the same row both times', async () => {
  const store = new Store(new MemoryDriver());
  await store.write('reviews', review(1));
  const sent: unknown[] = [];
  // The server stored it but the phone never heard back: the flush counts it as offline.
  await store.flush(async (_t, rows) => {
    sent.push(...rows);
    throw new Error('Geen verbinding met de server.');
  });
  assert.equal(await store.pendingCount(), 1);
  await store.flush(async (_t, rows) => void sent.push(...rows));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], 'same uuid, so the server ignores the second copy');
  assert.equal(await store.pendingCount(), 0);
});

test('flush sends in batches, oldest first, and empties the outbox', async () => {
  const store = new Store(new MemoryDriver());
  for (let i = 1; i <= 5; i++) await store.write('reviews', review(i), 1000 + i);
  const sent: string[] = [];
  const result = await store.flush(async (_t, rows) => {
    for (const r of rows as Review[]) sent.push(r.id.slice(-1));
  });
  assert.deepEqual(sent, ['1', '2', '3', '4', '5']);
  assert.equal(result.sent, 5);
  assert.equal(await store.pendingCount(), 0);
});

test('no connection: the flush stops and keeps everything, nothing counted as refused', async () => {
  const store = new Store(new MemoryDriver());
  await store.write('reviews', review(1));
  await store.write('reviews', review(2));
  const result = await store.flush(async () => {
    throw new Error('Geen verbinding met de server.');
  });
  assert.equal(result.stopped, 'network');
  assert.equal(await store.pendingCount(), 2);
  assert.equal((await store.pending())[0].attempts, 0);
});

test('a rejected key (401/403) stops the flush without counting refusals', async () => {
  const store = new Store(new MemoryDriver());
  await store.write('reviews', review(1));
  const result = await store.flush(async () => {
    throw new Error('401: permission denied');
  });
  assert.equal(result.stopped, 'access');
  assert.equal((await store.pending())[0].attempts, 0);
});

test('one bad row: the good ones still go, the bad one is parked after three refusals', async () => {
  const store = new Store(new MemoryDriver());
  for (let i = 1; i <= 4; i++) await store.write('reviews', review(i, i === 2 ? { result: 'gekend', ms: -1 } : {}), 1000 + i);
  const send = async (_t: TableName, rows: unknown[]) => {
    if ((rows as Review[]).some((r) => r.ms === -1)) throw new Error('400: violates check constraint');
  };
  const first = await store.flush(send);
  assert.equal(first.sent, 3);
  assert.equal(first.refused, 1);
  assert.equal(await store.pendingCount(), 1);

  for (let i = 2; i <= MAX_REFUSALS; i++) await store.flush(send);
  assert.equal(await store.pendingCount(), 0, 'parked rows are no longer pending');
  const parked = await store.parked();
  assert.equal(parked.length, 1);
  assert.match(parked[0].lastError ?? '', /check constraint/);

  // New rows behind it go through untouched.
  await store.write('reviews', review(9));
  const later = await store.flush(send);
  assert.equal(later.sent, 1);
  assert.equal(later.parked, 0);

  // After Claude fixed the cause, the parked row can be retried.
  assert.equal(await store.retryParked(), 1);
  assert.equal(await store.pendingCount(), 1);
});

test('failures are classified by their status prefix', () => {
  assert.equal(classifyFailure('409: duplicate'), 'refused');
  assert.equal(classifyFailure('403: denied'), 'access');
  assert.equal(classifyFailure('503: busy'), 'network');
  assert.equal(classifyFailure('De server antwoordde niet op tijd.'), 'network');
});

test('cursors and meta values live in the same database as the rows', async () => {
  const driver = new MemoryDriver();
  const store = new Store(driver);
  await store.setCursor('cards', '2026-10-25T10:00:00Z');
  await store.setCursor('reviews', 42);
  assert.equal(await store.cursor('cards'), '2026-10-25T10:00:00Z');
  assert.equal(await store.cursor('reviews'), 42);
  await store.clear();
  assert.equal(await store.cursor('cards'), null);
});

test('remove drops server rows but keeps a row that still waits in the outbox', async () => {
  const store = new Store(new MemoryDriver());
  await store.accept('courses', [course('SCM'), course('XX')]);
  assert.equal(await store.remove('courses', ['XX']), 1);
  assert.deepEqual((await store.all('courses')).map((c) => c.id), ['SCM']);
  await store.write('card_marks', { card_id: 'c1', starred: true, updated_at: T });
  assert.equal(await store.remove('card_marks', ['c1']), 0);
});

test('a row that vanished from under the outbox is simply dropped', async () => {
  const driver = new MemoryDriver();
  const store = new Store(driver);
  await store.write('reviews', review(1));
  await driver.delete('reviews', review(1).id);
  const result = await store.flush(async () => assert.fail('nothing to send'));
  assert.equal(result.sent, 0);
  assert.equal((await driver.getAll(OUTBOX)).length, 0);
});

test('FallbackDriver runs on memory when IndexedDB will not open', async () => {
  const driver = new FallbackDriver(Promise.reject(new Error('blocked')));
  const store = new Store(driver);
  await store.write('reviews', review(1));
  assert.equal(driver.degraded, true);
  assert.equal((await store.all('reviews')).length, 1);
});
