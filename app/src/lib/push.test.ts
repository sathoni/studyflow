/**
 * Reminders (Phase 5): the part of push.ts that runs without a phone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBytes } from './push.ts';
import { VAPID_PUBLIC_KEY } from './server-config.ts';

test('the public signing key is a 65-byte P-256 point, as PushManager wants it', () => {
  const bytes = keyBytes(VAPID_PUBLIC_KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4, 'uncompressed point');
});
