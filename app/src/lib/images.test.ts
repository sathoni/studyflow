/**
 * Slide images: batching of signed addresses, the blob cache, and the CSS crop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageCache, SIGN_BATCH, cardImagePaths, cropBox, demoImages, normalizeCrop, slidePath, visualPath } from './images.ts';
import type { SignedUrl } from './sync.ts';
import type { Card, Slide } from './model.ts';
import { card } from './testkit.ts';

function harness() {
  const blobs = new Map<string, Blob>();
  const signCalls: string[][] = [];
  const downloads: string[] = [];
  let made = 0;
  const cache = new ImageCache({
    sign: async (paths) => {
      signCalls.push(paths);
      return paths.map((p): SignedUrl => ({ path: p, signed_url: p.includes('p999') ? null : `https://s.test/${p}?token=t`, error: null }));
    },
    blobs: { getBlob: async (k) => blobs.get(k), putBlob: async (k, b) => void blobs.set(k, b) },
    fetch: (async (url: string) => {
      downloads.push(String(url));
      return new Response(new Blob(['img']), { status: 200 });
    }) as typeof fetch,
    createObjectURL: () => `blob:${++made}`,
  });
  return { cache, blobs, signCalls, downloads };
}

test('slide keys become storage paths', () => {
  assert.equal(slidePath('SCM-H3/p006'), 'SCM-H3/p006.webp');
  assert.equal(slidePath('FB-BOEK/p036.webp'), 'FB-BOEK/p036.webp');
  const slides = new Map<string, Slide>([['SCM-H3/p006', { key: 'SCM-H3/p006', chapter_id: 'SCM-H3', page_idx: 6, printed_no: '114', image_path: 'SCM-H3/p006.webp', w: 2000, h: 1125, updated_at: '' }]]);
  assert.equal(visualPath({ slide: 'SCM-H3/p006' }, slides), 'SCM-H3/p006.webp');
  assert.equal(visualPath({ slide: 'nonsense' }), null);
  assert.equal(visualPath(null), null);
});

test('cardImagePaths: front and back visuals, each path once', () => {
  const a: Card = card('SCM-H3', { answer: { core: 'x', visual: { slide: 'SCM-H3/p006', crop: [0, 0, 1, 1] } } });
  const b: Card = card('SCM-H3', { front: { text: 'q', visual: { slide: 'SCM-H3/p007' } }, answer: { core: 'y', visual: { slide: 'SCM-H3/p006' } } });
  const c: Card = card('SCM-H3');
  assert.deepEqual(cardImagePaths([a, b, c]), ['SCM-H3/p006.webp', 'SCM-H3/p007.webp']);
});

test('images asked in the same moment share one signing call; a blob is downloaded once', async () => {
  const { cache, signCalls, downloads, blobs } = harness();
  const [x, y, again] = await Promise.all([
    cache.url('SCM-H3/p006.webp'),
    cache.url('SCM-H3/p007.webp'),
    cache.url('SCM-H3/p006.webp'),
  ]);
  assert.equal(signCalls.length, 1);
  assert.deepEqual(signCalls[0], ['SCM-H3/p006.webp', 'SCM-H3/p007.webp']);
  assert.equal(x, again);
  assert.notEqual(x, y);
  assert.equal(downloads.length, 2);
  assert.equal(blobs.size, 2);
  // Asked again later: from memory, no network.
  await cache.url('SCM-H3/p006.webp');
  assert.equal(signCalls.length, 1);
});

test('a blob already on the phone needs no network at all (offline after the first time)', async () => {
  const { cache, blobs, signCalls } = harness();
  blobs.set('FB-BOEK/p036.webp', new Blob(['cached']));
  assert.match((await cache.url('FB-BOEK/p036.webp')) ?? '', /^blob:/);
  assert.equal(signCalls.length, 0);
});

test('more than 60 paths are split over several signing calls', async () => {
  const { cache, signCalls } = harness();
  const paths = Array.from({ length: SIGN_BATCH + 5 }, (_, i) => `SCM-H3/p${String(i + 1).padStart(3, '0')}.webp`);
  const result = await cache.prefetch(paths);
  assert.deepEqual(result, { ok: SIGN_BATCH + 5, failed: 0 });
  assert.ok(signCalls.length >= 2);
  assert.ok(signCalls.every((c) => c.length <= SIGN_BATCH));
});

test('a missing image or an invalid path gives null, never an exception', async () => {
  const { cache } = harness();
  assert.equal(await cache.url('SCM-H3/p999.webp'), null);
  assert.equal(await cache.url('../etc/passwd'), null);
  const broken = new ImageCache({
    sign: async () => {
      throw new Error('offline');
    },
    blobs: null,
  });
  assert.equal(await broken.url('SCM-H3/p006.webp'), null);
  assert.deepEqual(await broken.prefetch(['SCM-H3/p006.webp']), { ok: 0, failed: 1 });
});

test('demo images: every path shows the bundled placeholder', async () => {
  const images = demoImages();
  assert.equal(await images.url('SCM-H3/p006.webp'), './demo/placeholder.webp');
});

test('cropBox: the frame takes the crop shape, the image is scaled and shifted into it', () => {
  // The right half of a 2000×1000 page, top to bottom: a 1000×1000 square.
  const box = cropBox([0.5, 0, 1, 1], 2000, 1000);
  assert.equal(box.aspect, 1);
  assert.equal(box.image.width, '200%');
  assert.equal(box.image.height, '100%');
  assert.equal(box.image.left, '-100%');
  assert.equal(box.image.top, '0%');

  const quarter = cropBox([0.25, 0.25, 0.75, 0.75], 2000, 1125);
  assert.equal(quarter.image.width, '200%');
  assert.equal(quarter.image.left, '-50%');
  assert.equal(quarter.image.top, '-50%');
  assert.ok(Math.abs(quarter.aspect - 2000 / 1125) < 1e-9);
});

test('a broken crop shows the whole page instead of nothing', () => {
  assert.deepEqual(normalizeCrop(null), [0, 0, 1, 1]);
  assert.deepEqual(normalizeCrop([0.9, 0.9, 0.1, 0.1]), [0.1, 0.1, 0.9, 0.9]);
  assert.deepEqual(normalizeCrop([-1, 0, 2, 1]), [0, 0, 1, 1]);
  assert.deepEqual(normalizeCrop([0.5, 0.5, 0.505, 0.9]), [0, 0, 1, 1]);
  assert.equal(cropBox(undefined, 0, 0).image.width, '100%');
});
