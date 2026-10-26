/**
 * Overhoor-instrumenten: 1 → 3 → 7 → 14 days (SPEC-v3 §7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueInstruments, foldInstrument, instrumentReviewRow, nextStep, scorePreview } from './instruments.ts';
import type { Instrument, InstrumentReview, InstrumentScore } from './model.ts';

const ID = 'i1';
let n = 0;
const row = (day: string, score: InstrumentScore, id = ID): InstrumentReview => ({
  id: `r${++n}`,
  instrument_id: id,
  day,
  score,
  created_at: `${day}T12:00:${String(n % 60).padStart(2, '0')}Z`,
});

const instrument = (id: string, status = 'live'): Instrument => ({
  id, course_id: 'SCM', chapter_id: 'SCM-H3', title: id, notion_url: null, minutes: 10, status, updated_at: '',
});

test('steps: Alles juist moves on, Bijna repeats, Veel fout goes back to 1 day', () => {
  assert.equal(nextStep(0, 'alles'), 1);
  assert.equal(nextStep(3, 'alles'), 3);
  assert.equal(nextStep(2, 'bijna'), 2);
  assert.equal(nextStep(3, 'veel_fout'), 0);
});

test('a run of Alles juist: 3, 7, 14, 14 days', () => {
  const rows = [row('2026-10-01', 'alles'), row('2026-10-04', 'alles'), row('2026-10-11', 'alles'), row('2026-10-25', 'alles')];
  const due = rows.map((_, i) => foldInstrument(ID, rows.slice(0, i + 1)).due);
  assert.deepEqual(due, ['2026-10-04', '2026-10-11', '2026-10-25', '2026-11-08']);
});

test('Bijna keeps the step, Veel fout starts over, across the clock change', () => {
  const s = foldInstrument(ID, [row('2026-10-20', 'alles'), row('2026-10-23', 'bijna')]);
  assert.equal(s.due, '2026-10-26'); // still the 3-day step, across 25/10
  const reset = foldInstrument(ID, [row('2026-10-20', 'alles'), row('2026-10-23', 'veel_fout')]);
  assert.equal(reset.due, '2026-10-24');
  assert.equal(scorePreview(s, 'alles'), 7);
  assert.equal(scorePreview(s, 'veel_fout'), 1);
});

test('Overdag: never practised and overdue ones show, done today stays visible, retired ones never', () => {
  const list = dueInstruments(
    [instrument('a'), instrument('b'), instrument('c'), instrument('d', 'retired')],
    [row('2026-10-22', 'bijna', 'b'), row('2026-10-26', 'alles', 'c'), row('2026-10-25', 'alles', 'a')],
    '2026-10-26',
  );
  // a: due 28/10 → hidden; b: due 23/10 → shown; c: done today → shown last.
  assert.deepEqual(list.map((d) => [d.instrument.id, d.doneToday]), [['b', false], ['c', true]]);
  const fresh = dueInstruments([instrument('x')], [], '2026-10-26');
  assert.equal(fresh[0].state.due, null);
});

test('the row the phone sends', () => {
  const r = instrumentReviewRow('i9', 'bijna', '2026-10-26', new Date('2026-10-26T10:00:00Z'), 'u1');
  assert.deepEqual(r, { id: 'u1', instrument_id: 'i9', day: '2026-10-26', score: 'bijna', created_at: '2026-10-26T10:00:00.000Z' });
});
