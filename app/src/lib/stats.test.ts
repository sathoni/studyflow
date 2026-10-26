/**
 * The numbers on Home, Voortgang and Profiel (stats.ts) and the card markup (text.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card, review } from './testkit.ts';
import {
  boxSpread,
  cardsByDay,
  currentStates,
  firstTryShare,
  goalProgress,
  hardestCards,
  masteredShare,
  quizzesThisWeek,
  streak,
  weekBars,
  weekCards,
  weekMinutes,
} from './stats.ts';
import { boldSegments, clozeParts, plainText } from './text.ts';
import type { RunScore } from './quiz.ts';

const MON = '2026-10-26'; // a Monday
const THU = '2026-10-29';

test('cards per day: distinct cards, herhaling counts, undone and manual rows do not', () => {
  const a = review('a', MON, 'niet');
  const rows = [
    a,
    review('a', MON, 'gekend', { mode: 'herhaling' }),
    review('b', MON, 'gekend'),
    review('c', MON, 'opnieuw', { mode: 'handmatig' }),
    review('d', MON, 'quiz_fout', { mode: 'quiz' }),
  ];
  const bRow = rows[2];
  rows.push(review('b', MON, 'undo', { undoes: bRow.id }));
  assert.equal(cardsByDay(rows).get(MON), 1);
});

test('week bars run Monday to Sunday and mark today and the future', () => {
  const bars = weekBars([review('a', MON, 'gekend'), review('b', '2026-10-28', 'gekend'), review('c', '2026-10-28', 'niet')], '2026-10-28');
  assert.deepEqual(bars.map((b) => b.label), ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo']);
  assert.deepEqual(bars.map((b) => b.count), [1, 0, 2, 0, 0, 0, 0]);
  assert.equal(bars[2].isToday, true);
  assert.equal(bars[3].future, true);
  assert.equal(weekCards(bars.length ? [review('a', MON, 'gekend')] : [], '2026-10-28'), 1);
});

test('streak: today counts once studied, otherwise it runs up to yesterday', () => {
  const rows = ['2026-10-23', '2026-10-24', '2026-10-25'].map((d) => review('a', d, 'gekend'));
  assert.equal(streak(rows, MON), 3, 'not studied yet today: the streak is not broken');
  assert.equal(streak([...rows, review('a', MON, 'gekend')], MON), 4);
  assert.equal(streak(rows, '2026-10-27'), 0, 'a whole day missed');
  assert.equal(streak([], MON), 0);
});

test('minutes this week: own times, capped, with a fallback for missing ones', () => {
  const rows = [
    review('a', MON, 'gekend', { ms: 60_000 }),
    review('b', MON, 'gekend', { ms: 3_600_000 }), // capped at 5 min
    review('c', '2026-10-27', 'gekend', { ms: null }), // 15 s
    review('d', '2026-10-19', 'gekend', { ms: 600_000 }), // last week
  ];
  assert.equal(weekMinutes(rows, THU), 6);
});

test('first try share: first-pass answers of the last 14 days; hint counts as right', () => {
  const rows = [
    review('a', MON, 'gekend'),
    review('b', MON, 'hint', { hints_used: 1 }),
    review('c', MON, 'niet'),
    review('c', MON, 'gekend', { mode: 'herhaling' }),
    review('d', '2026-10-01', 'niet'), // too old
  ];
  assert.equal(firstTryShare(rows, MON), 2 / 3);
  assert.equal(firstTryShare([], MON), null);
});

test('box spread, mastered share and hardest cards', () => {
  const c1 = card('SCM-H3');
  const c2 = card('SCM-H3');
  const c3 = card('SCM-H3');
  const c4 = card('SCM-H3', { status: 'retired' });
  const rows = [
    review(c1.id, '2026-10-01', 'gekend'), // → 2
    review(c1.id, '2026-10-04', 'gekend'), // → 3
    review(c2.id, '2026-10-01', 'gekend'),
    review(c2.id, '2026-10-04', 'niet'), // lapse → 1
  ];
  const states = currentStates([c1, c2, c3, c4], rows);
  assert.equal(states.has(c4.id), false, 'retired cards are left out');
  assert.deepEqual(boxSpread([c1.id, c2.id, c3.id], states), [1, 1, 0, 1, 0, 0, 0]);
  assert.equal(masteredShare([c1.id, c2.id, c3.id], states), 1 / 3);
  assert.equal(masteredShare([], states), null);
  const hard = hardestCards([c1, c2, c3], states, new Set([c3.id]));
  assert.deepEqual(hard.map((c) => c.id), [c3.id, c2.id], 'starred first, then lapses; c1 never lapsed');
});

test('goals: the three known ones measured, unknown ones left out', () => {
  const input = { queue: { doneCount: 12, total: 32, progress: 12 / 32 }, accuracy: 0.76, quizzesWeek: 2 };
  const daily = goalProgress({ id: 'daily_queue', label: 'x', target: 1, unit: 'share' }, input)!;
  assert.equal(daily.label, '12 / 32');
  const acc = goalProgress({ id: 'accuracy', label: 'x', target: 0.8, unit: 'share' }, input)!;
  assert.equal(acc.label, '76% / 80%');
  assert.equal(acc.share, 0.95);
  const quiz = goalProgress({ id: 'quizzes_week', label: 'x', target: 3, unit: 'count' }, input)!;
  assert.equal(quiz.label, '2 / 3');
  assert.equal(goalProgress({ id: 'iets', label: 'x', target: 3, unit: 'count' }, input), null);
  const empty = goalProgress({ id: 'daily_queue', label: 'x', target: 1, unit: 'share' }, { ...input, queue: { doneCount: 0, total: 0, progress: 1 } })!;
  assert.equal(empty.reached, true, 'nothing to do counts as done');
});

test('quizzes this week count runs from Monday on', () => {
  const run = (day: string): RunScore => ({ run_id: day, scope: null, course_id: 'SCM', day, at: 0, correct: 1, total: 1 });
  assert.equal(quizzesThisWeek([run('2026-10-25'), run(MON), run(THU)], THU), 2);
});

test('bold segments: key terms, a lone marker stays text, nothing is lost', () => {
  assert.deepEqual(boldSegments('De **EOQ** is **Q**.'), [
    { text: 'De ', bold: false },
    { text: 'EOQ', bold: true },
    { text: ' is ', bold: false },
    { text: 'Q', bold: true },
    { text: '.', bold: false },
  ]);
  assert.deepEqual(boldSegments('2 ** 3'), [{ text: '2 ** 3', bold: false }]);
  assert.deepEqual(boldSegments('**alles**'), [{ text: 'alles', bold: true }]);
  assert.equal(plainText('**Bestelde + beschikbare voorraad**: alles'), 'Bestelde + beschikbare voorraad: alles');
  assert.deepEqual(boldSegments(''), []);
});

test('cloze parts split around the blank', () => {
  assert.deepEqual(clozeParts('EOQ: Q = √(2·D·____ / Cv)'), ['EOQ: Q = √(2·D·', ' / Cv)']);
  assert.equal(clozeParts('geen blank'), null);
});
