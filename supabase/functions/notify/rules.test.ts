/**
 * The reminder rules, at chosen moments of the year (node --test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseList, dueReminders, openKinds, studyDayOf, type Counts } from './rules.ts';

const at = (iso: string) => Date.parse(iso);
const none = new Set<string>();
const counts = (extra: Partial<Counts> = {}): Counts => ({
  morning: 7,
  evening_fresh: 16,
  evening_courses: ['OR', 'BR'],
  new_max: 30,
  new_done_today: 0,
  ...extra,
});

test('the windows: 7:00–10:59 and 21:00–23:59, Brussels time (winter: UTC+1)', () => {
  assert.deepEqual(openKinds(at('2026-10-30T05:59:00Z'), none), [], '6:59');
  assert.deepEqual(openKinds(at('2026-10-30T06:00:00Z'), none), ['ochtend'], '7:00');
  assert.deepEqual(openKinds(at('2026-10-30T09:59:00Z'), none), ['ochtend'], '10:59');
  assert.deepEqual(openKinds(at('2026-10-30T10:00:00Z'), none), [], '11:00');
  assert.deepEqual(openKinds(at('2026-10-30T19:59:00Z'), none), [], '20:59');
  assert.deepEqual(openKinds(at('2026-10-30T20:00:00Z'), none), ['avond'], '21:00');
  assert.deepEqual(openKinds(at('2026-10-30T22:59:00Z'), none), ['avond'], '23:59');
  assert.deepEqual(openKinds(at('2026-10-30T23:30:00Z'), none), [], '0:30 is not a reminder hour');
});

test('summer time (UTC+2) needs no change: 7:00 and 21:00 stay Brussels time', () => {
  assert.deepEqual(openKinds(at('2027-03-28T05:00:00Z'), none), ['ochtend'], 'the morning the clocks go forward');
  assert.deepEqual(openKinds(at('2027-06-01T19:00:00Z'), none), ['avond']);
  assert.deepEqual(openKinds(at('2027-06-01T20:00:00Z'), none), ['avond']);
  assert.deepEqual(openKinds(at('2027-06-01T22:00:00Z'), none), [], 'midnight in summer');
});

test('the study day rolls over at 4:00, as in the app', () => {
  assert.equal(studyDayOf(at('2026-10-30T02:30:00Z')), '2026-10-29', '3:30 still belongs to the day before');
  assert.equal(studyDayOf(at('2026-10-30T03:00:00Z')), '2026-10-30', '4:00 is the new day');
});

test('a reminder already logged that day is never due again', () => {
  const now = at('2026-10-30T06:05:00Z');
  assert.deepEqual(dueReminders(now, new Set(['ochtend:2026-10-30']), counts()), []);
  assert.equal(dueReminders(now, new Set(['ochtend:2026-10-29']), counts()).length, 1, 'yesterday does not count');
});

test('morning: the number of cards whose day has come, skipped when there are none', () => {
  const [r] = dueReminders(at('2026-10-30T06:00:00Z'), none, counts());
  assert.deepEqual([r.key, r.skip, r.title], ['ochtend:2026-10-30', false, '🌅 Herhaling in StudyFlow']);
  assert.equal(r.body, '7 kaartjes uit je dozen wachten op je (±2 min).');
  assert.equal(dueReminders(at('2026-10-30T06:00:00Z'), none, counts({ morning: 1 }))[0].body, '1 kaartje uit je dozen wacht op je (±1 min).');
  assert.equal(dueReminders(at('2026-10-30T06:00:00Z'), none, counts({ morning: 0 }))[0].skip, true);
});

test('evening: today\'s and yesterday\'s study first, with the courses', () => {
  const [r] = dueReminders(at('2026-10-29T20:00:00Z'), none, counts());
  assert.deepEqual([r.key, r.skip, r.title], ['avond:2026-10-29', false, '🌙 Nieuwe kaartjes in StudyFlow']);
  assert.equal(r.body, '16 kaartjes van wat je studeerde staan vooraan (BR en OR).');
});

test('evening without fresh study: the catch-up, only when he has not started yet', () => {
  const now = at('2026-11-01T20:00:00Z');
  const [r] = dueReminders(now, none, counts({ evening_fresh: 0, evening_courses: [], new_max: 10 }));
  assert.deepEqual([r.skip, r.body], [false, 'Je inhaalkaartjes staan klaar (±5 min).']);
  assert.equal(dueReminders(now, none, counts({ evening_fresh: 0, new_done_today: 4 }))[0].skip, true, 'already started');
  assert.equal(dueReminders(now, none, counts({ evening_fresh: 0, new_max: 0 }))[0].skip, true, 'no catch-up planned');
});

test('course lists read naturally', () => {
  assert.deepEqual([courseList([]), courseList(['OR']), courseList(['OR', 'BR']), courseList(['SCM', 'BR', 'OR'])], ['', 'OR', 'BR en OR', 'BR, OR en SCM']);
});
