/**
 * Today's queue (SPEC-v3 §3) and the session runner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, type Card, type Review, type StudySession } from './model.ts';
import {
  ReviewSession,
  buildQueue,
  cardsLabel,
  courseOrder,
  estimateSeconds,
  extraRound,
  forCourse,
  minutesLabel,
  nearestExamDays,
  owedRepeats,
  personalTiming,
  planFor,
  sessionDay,
  studyRound,
  tomorrowQueue,
  type QueueInput,
  type QueueItem,
} from './queue.ts';
import { COURSES, T0, card, chapter, exam, inBox, plan, review } from './testkit.ts';
import { addDays } from './dates.ts';

const TODAY = '2026-10-26'; // a Monday
const SUNDAY = '2026-10-25';

const CHAPTERS = [chapter('SCM-H2', 2, 'af'), chapter('SCM-H3', 3), chapter('FB-H1', 1), chapter('OR-H1', 1), chapter('BE-U1', 1)];

function input(cards: Card[], reviews: Review[], extra: Partial<QueueInput> = {}): QueueInput {
  return {
    today: TODAY,
    cards,
    reviews,
    courses: COURSES,
    chapters: CHAPTERS,
    exams: [],
    dayPlans: [],
    defaults: DEFAULTS,
    ...extra,
  };
}

const ids = (items: QueueItem[]) => items.map((i) => i.card.id);

/* ---- the plan ---- */

test('planFor: day_plan row wins, otherwise 20/10 on weekdays and 30/5 on Sunday', () => {
  assert.deepEqual([planFor(TODAY, [], DEFAULTS).cap, planFor(TODAY, [], DEFAULTS).newMax], [20, 10]);
  assert.deepEqual([planFor(SUNDAY, [], DEFAULTS).cap, planFor(SUNDAY, [], DEFAULTS).newMax], [30, 5]);
  const p = planFor(TODAY, [plan(TODAY, ['FB', 'OR'], { cap: 15, new_max: 3, reason: 'Eerst FB en OR: maandag les' })], DEFAULTS);
  assert.deepEqual([p.cap, p.newMax, p.reason, p.fromPlan, p.planOrder], [15, 3, 'Eerst FB en OR: maandag les', true, ['FB', 'OR']]);
  const half = planFor(TODAY, [plan(TODAY, ['FB'])], DEFAULTS);
  assert.deepEqual([half.cap, half.newMax], [20, 10], 'null cap/new_max fall back to the defaults');
});

test('course order: plan first, then the others by most overdue, then course sort', () => {
  const order = courseOrder(
    ['FB', 'OR', 'NOPE'],
    COURSES,
    [
      { courseId: 'BE', due: '2026-10-20' },
      { courseId: 'SCM', due: '2026-10-25' },
      { courseId: 'BE', due: '2026-10-26' },
    ],
    TODAY,
  );
  assert.deepEqual(order, ['FB', 'OR', 'BE', 'SCM', 'BR', 'IFHT']);
});

test('nearest exam: only tests within 10 days covering the chapter', () => {
  const exams = [exam('SCM', '2026-11-18', ['SCM-H2', 'SCM-H3']), exam(null, '2027-01-11'), exam('FB', '2026-11-01', [], 'opdracht')];
  assert.equal(nearestExamDays({ course_id: 'SCM', chapter_id: 'SCM-H3' }, exams, TODAY), Infinity, '23 days away: not yet');
  assert.equal(nearestExamDays({ course_id: 'SCM', chapter_id: 'SCM-H3' }, exams, '2026-11-10'), 8);
  assert.equal(nearestExamDays({ course_id: 'SCM', chapter_id: 'SCM-H9' }, exams, '2026-11-10'), Infinity);
  assert.equal(nearestExamDays({ course_id: 'FB', chapter_id: 'FB-H1' }, exams, '2026-10-30'), Infinity, 'opdracht is not a test');
  assert.equal(nearestExamDays({ course_id: 'FB', chapter_id: 'FB-H1' }, exams, '2027-01-05'), 6, 'all-course exam');
});

/* ---- due cards ---- */

test('due cards follow the day plan order, then lowest box, then oldest due', () => {
  const scm3 = card('SCM-H3', { id: 'scm-box3' });
  const scm1 = card('SCM-H3', { id: 'scm-box1' });
  const fbOld = card('FB-H1', { id: 'fb-old' });
  const fbNew = card('FB-H1', { id: 'fb-new' });
  const notDue = card('FB-H1', { id: 'fb-later' });
  const reviews = [
    ...inBox('scm-box3', 3, '2026-10-26'),
    ...inBox('scm-box1', 1, '2026-10-26'),
    ...inBox('fb-old', 2, '2026-10-20'),
    ...inBox('fb-new', 2, '2026-10-26'),
    ...inBox('fb-later', 2, '2026-10-27'),
  ];
  const q = buildQueue(input([scm3, scm1, fbOld, fbNew, notDue], reviews, { dayPlans: [plan(TODAY, ['FB'])] }));
  assert.deepEqual(ids(q.items), ['fb-old', 'fb-new', 'scm-box1', 'scm-box3']);
  assert.ok(q.items.every((i) => i.kind === 'review' && !i.done));
  assert.deepEqual(q.courseChips, ['FB', 'SCM']);
  assert.equal(q.plan.courseOrder[0], 'FB');
});

test('the review cap holds the rest back without a word; Sunday allows 30', () => {
  const cards = Array.from({ length: 35 }, (_, i) => card('SCM-H3', { id: `due-${String(i).padStart(2, '0')}` }));
  const reviews = cards.flatMap((c) => inBox(c.id, 2, '2026-10-24'));
  const monday = buildQueue(input(cards, reviews));
  assert.equal(monday.items.length, 20);
  assert.equal(monday.rolledOver, 15);
  const sunday = buildQueue(input(cards, reviews.filter((r) => r.day < SUNDAY), { today: SUNDAY }));
  assert.equal(sunday.items.length, 30);
  const capped = buildQueue(input(cards, reviews, { dayPlans: [plan(TODAY, [], { cap: 12 })] }));
  assert.equal(capped.items.length, 12);
});

test('needs_check and retired cards never enter the queue', () => {
  const a = card('SCM-H3', { id: 'live' });
  const b = card('SCM-H3', { id: 'check', status: 'needs_check' });
  const c = card('SCM-H3', { id: 'gone', status: 'retired' });
  const q = buildQueue(input([a, b, c], []));
  assert.deepEqual(ids(q.items), ['live']);
});

/* ---- new cards ---- */

test('new cards: up to new_max, near test first, then the plan courses take turns', () => {
  const fbOld = card('FB-H1', { id: 'fb-old', created_at: '2026-10-01T10:00:00Z' });
  const fbYoung = card('FB-H1', { id: 'fb-young', created_at: '2026-10-20T10:00:00Z' });
  const scmB = card('SCM-H3', { id: 'scm-b', sibling_group: 'g1', sort: 2, created_at: '2026-10-22T10:00:00Z' });
  const scmA = card('SCM-H3', { id: 'scm-a', sibling_group: 'g1', sort: 1, created_at: '2026-10-22T10:00:00Z' });
  const or = card('OR-H1', { id: 'or-1', created_at: '2026-09-01T10:00:00Z' });
  const q = buildQueue(
    input([fbOld, fbYoung, scmB, scmA, or], [], {
      dayPlans: [plan(TODAY, ['FB', 'OR'], { new_max: 4 })],
      exams: [exam('SCM', '2026-11-03', ['SCM-H3'])],
    }),
  );
  // SCM has a test within 10 days, so its two cards are picked first. The other
  // two slots go to the courses the day plan names, taking turns (FB, then OR),
  // each in its own order (FB's oldest first). The list itself is grouped per
  // course in today's order (FB, OR, then SCM).
  assert.deepEqual(ids(q.items), ['fb-old', 'or-1', 'scm-a', 'scm-b']);
  assert.ok(q.items.every((i) => i.kind === 'new'));
  assert.equal(q.total, 4);
});

test('Sunday takes 5 new cards by default', () => {
  const cards = Array.from({ length: 12 }, (_, i) => card('SCM-H3', { id: `n-${i}` }));
  assert.equal(buildQueue(input(cards, [], { today: SUNDAY })).items.length, 5);
  assert.equal(buildQueue(input(cards, [])).items.length, 10);
});

test('a new card answered wrong in a quiz goes first among the new cards', () => {
  const a = card('SCM-H3', { id: 'aaa', created_at: '2026-09-01T10:00:00Z' });
  const b = card('SCM-H3', { id: 'bbb', created_at: '2026-10-01T10:00:00Z' });
  const reviews = [review('bbb', '2026-10-25', 'quiz_fout', { mode: 'quiz' })];
  const q = buildQueue(input([a, b], reviews, { dayPlans: [plan(TODAY, [], { new_max: 1 })] }));
  assert.deepEqual(ids(q.items), ['bbb']);
});

/* ---- a stable list while he works ---- */

test('answered cards stay in the list, ticked off; rolled-over cards do not slip in', () => {
  const cards = Array.from({ length: 24 }, (_, i) => card('SCM-H3', { id: `d-${String(i).padStart(2, '0')}` }));
  const before = cards.flatMap((c) => inBox(c.id, 2, '2026-10-25'));
  const q0 = buildQueue(input(cards, before));
  assert.equal(q0.items.length, 20);
  assert.equal(q0.progress, 0);

  const answered = q0.items.slice(0, 5).map((i) => review(i.card.id, TODAY, 'gekend'));
  const q1 = buildQueue(input(cards, [...before, ...answered]));
  assert.deepEqual(ids(q1.items), ids(q0.items), 'same list');
  assert.equal(q1.doneCount, 5);
  assert.equal(q1.remaining.length, 15);
  assert.equal(q1.progress, 0.25);
  assert.equal(q1.items[0].state.box, 2, 'state shown is the start-of-day state');
});

test('new cards answered today keep their place when earlier-sorting cards arrive later', () => {
  const morning = Array.from({ length: 3 }, (_, i) => card('SCM-H3', { id: `m-${i}`, created_at: '2026-10-20T10:00:00Z' }));
  const answered = [review('m-0', TODAY, 'gekend'), review('m-1', TODAY, 'niet')];
  const evening = card('SCM-H3', { id: 'arrived', created_at: '2026-10-01T10:00:00Z' }); // older, sorts first
  const p = [plan(TODAY, [], { new_max: 2 })];
  const q = buildQueue(input([...morning, evening], answered, { dayPlans: p }));
  assert.deepEqual(ids(q.items).sort(), ['m-0', 'm-1']);
  assert.equal(q.remaining.length, 0);
  assert.equal(q.progress, 1);
});

test('an empty day is complete, not a division by zero', () => {
  const q = buildQueue(input([], []));
  assert.equal(q.total, 0);
  assert.equal(q.progress, 1);
  assert.equal(minutesLabel(q.remainingSec), '±0 min');
});

test('an undone answer puts the card back in the remaining list', () => {
  const c = card('SCM-H3', { id: 'undo-me' });
  const a = review('undo-me', TODAY, 'niet');
  const u = review('undo-me', TODAY, 'undo', { undoes: a.id });
  const q = buildQueue(input([c], [a, u]));
  assert.equal(q.remaining.length, 1);
  assert.equal(q.repeats.length, 0);
});

/* ---- herhaling ---- */

test('owed repeats: a fail today is owed twice at most, and a right answer ends it', () => {
  const fail = review('x', TODAY, 'niet');
  assert.equal(owedRepeats([fail], TODAY).get('x'), 1);
  const try1 = review('x', TODAY, 'niet', { mode: 'herhaling' });
  assert.equal(owedRepeats([fail, try1], TODAY).get('x'), 2);
  const try2 = review('x', TODAY, 'niet', { mode: 'herhaling' });
  assert.equal(owedRepeats([fail, try1, try2], TODAY).has('x'), false);
  const right = review('x', TODAY, 'gekend', { mode: 'herhaling' });
  assert.equal(owedRepeats([fail, right], TODAY).has('x'), false);
  assert.equal(owedRepeats([review('y', '2026-10-25', 'niet')], TODAY).size, 0, 'yesterday is over');
});

test('the queue hands owed repeats to a resumed session', () => {
  const a = card('SCM-H3', { id: 'a' });
  const b = card('SCM-H3', { id: 'b' });
  const q = buildQueue(input([a, b], [review('a', TODAY, 'niet'), review('a', TODAY, 'niet', { mode: 'herhaling' })]));
  assert.deepEqual(ids(q.remaining), ['b']);
  assert.equal(q.repeats.length, 1);
  assert.equal(q.repeats[0].attempt, 2);
  const s = new ReviewSession(q.remaining, q.repeats);
  assert.equal(s.current!.item.card.id, 'b');
  s.answer('gekend');
  assert.deepEqual([s.current!.item.card.id, s.current!.mode, s.current!.attempt], ['a', 'herhaling', 2]);
  s.answer('niet');
  assert.ok(s.finished, 'no third try');
});

test('ReviewSession: first pass, failed cards at the end, at most two more tries', () => {
  const items = buildQueue(input(['a', 'b', 'c'].map((id) => card('SCM-H3', { id })), [])).items;
  const s = new ReviewSession(items);
  assert.deepEqual(s.position, { done: 0, total: 3 });
  assert.equal(s.answer('niet').mode, 'sessie'); // a
  assert.deepEqual(s.position, { done: 1, total: 4 });
  s.answer('hint'); // b
  s.answer('niet'); // c
  assert.deepEqual([s.current!.item.card.id, s.current!.mode, s.current!.attempt], ['a', 'herhaling', 1]);
  s.answer('niet'); // a, try 1 failed
  assert.deepEqual([s.current!.item.card.id, s.current!.attempt], ['c', 1]);
  s.answer('gekend'); // c fixed
  assert.deepEqual([s.current!.item.card.id, s.current!.attempt], ['a', 2]);
  s.answer('niet'); // a, try 2 failed: dropped
  assert.ok(s.finished);
  assert.equal(s.current, null);
  const sum = s.summary();
  assert.deepEqual([sum.answered, sum.cards, sum.firstTryRight, sum.failed], [6, 3, 1, ['a', 'c']]);
  assert.equal(sum.firstTryShare, 1 / 3);
  assert.throws(() => s.answer('gekend'));
});

test('ReviewSession undo steps back exactly one answer', () => {
  const items = buildQueue(input(['a', 'b'].map((id) => card('SCM-H3', { id })), [])).items;
  const s = new ReviewSession(items);
  assert.equal(s.undo(), false);
  s.answer('niet');
  assert.equal(s.position.total, 3);
  assert.equal(s.undo(), true);
  assert.equal(s.current!.item.card.id, 'a');
  assert.deepEqual(s.position, { done: 0, total: 2 });
  s.answer('gekend');
  s.answer('gekend');
  assert.ok(s.finished);
  assert.equal(s.summary().failed.length, 0);
});

/* ---- one course, extra rounds, tomorrow ---- */

test('forCourse and extraRound for "Verder studeren"', () => {
  const cards = Array.from({ length: 25 }, (_, i) => card('SCM-H3', { id: `s-${String(i).padStart(2, '0')}` }));
  const fb = card('FB-H1', { id: 'fb' });
  const reviews = [...cards.flatMap((c) => inBox(c.id, 2, '2026-10-26')), ...inBox('fb', 2, '2026-10-26')];
  const inp = input([...cards, fb], reviews, { dayPlans: [plan(TODAY, ['FB'])] });
  const q = buildQueue(inp);
  assert.equal(forCourse(q, 'SCM').length, 19);
  const extra = extraRound(inp, q, 'SCM');
  assert.equal(extra.length, 6, 'the six rolled-over SCM cards');
  assert.ok(extra.every((i) => !q.items.some((t) => t.card.id === i.card.id)));
});

test('tomorrow: what was answered today comes back on its own day', () => {
  const c = card('SCM-H3', { id: 't' });
  const today = review('t', TODAY, 'niet');
  const q = tomorrowQueue(input([c], [today]));
  assert.equal(q.day, addDays(TODAY, 1));
  assert.deepEqual(ids(q.items), ['t']);
  assert.equal(q.items[0].kind, 'review');
});

test('across the clock change a Doos 2 card waits exactly three calendar days', () => {
  const c = card('SCM-H3', { id: 'dst' });
  const rows = [review('dst', '2026-10-24', 'gekend')]; // new -> Doos 2, due 27/10
  assert.equal(buildQueue(input([c], rows, { today: '2026-10-26' })).items.length, 0);
  assert.equal(buildQueue(input([c], rows, { today: '2026-10-27' })).items.length, 1);
});

/* ---- estimates ---- */

test('estimates: 15 s per review, 30 s per new card by default', () => {
  const timing = { reviewSec: 15, newSec: 30, source: 'default' as const };
  const items = [...Array(10).fill({ kind: 'review' }), ...Array(4).fill({ kind: 'new' })];
  assert.equal(estimateSeconds(items, timing), 270);
  assert.equal(minutesLabel(270), '±5 min');
  assert.equal(minutesLabel(20), '±1 min');
  assert.equal(cardsLabel(1), '1 kaartje');
  assert.equal(cardsLabel(32), '32 kaartjes');
  const q = buildQueue(input([card('SCM-H3'), card('SCM-H3')], []));
  assert.equal(q.totalSec, 60);
  assert.equal(q.timing.source, 'default');
});

test('his own medians replace the defaults after 14 days', () => {
  const rows: Review[] = [];
  // Day 1: first sight of 12 cards (new samples, 40 s).
  for (let i = 0; i < 12; i++) rows.push(review(`k${i}`, '2026-10-05', 'gekend', { ms: 40000 }));
  // Later: reviews of the same cards (review samples, 9 s), plus one absurd outlier.
  for (let i = 0; i < 12; i++) rows.push(review(`k${i}`, '2026-10-20', 'gekend', { ms: 9000 }));
  rows.push(review('k0', '2026-10-21', 'gekend', { ms: 900000 }));
  const early = personalTiming(rows, '2026-10-15', DEFAULTS);
  assert.equal(early.source, 'default', 'only 10 days of history');
  const later = personalTiming(rows, '2026-10-19', DEFAULTS);
  assert.deepEqual(later, { reviewSec: 15, newSec: 40, source: 'personal' }, 'reviews not yet sampled: default stays');
  const now = personalTiming(rows, '2026-10-22', DEFAULTS);
  assert.equal(now.reviewSec, 9);
  assert.equal(now.newSec, 30, 'new samples are older than 14 days by now');
});

/* ---- edge cases from the adversarial review (26/10) ---- */

test('a quiz mistake on a Doos 4 card: not in today\'s list, due in tomorrow\'s', () => {
  const c = card('SCM-H3', { id: 'qf' });
  const rows = [...inBox('qf', 4, '2026-11-05'), review('qf', TODAY, 'quiz_fout', { mode: 'quiz' })];
  assert.equal(buildQueue(input([c], rows)).items.length, 0, 'today stays as it was this morning');
  const t = tomorrowQueue(input([c], rows));
  assert.deepEqual(ids(t.items), ['qf']);
  assert.equal(t.items[0].kind, 'review');
  assert.equal(t.items[0].state.box, 4, 'the box did not move');
});

test('new cards from one session keep the order they were written in (split cards stay together)', () => {
  const at = '2026-10-24T18:00:00Z';
  const a = card('SCM-H3', { id: 'zz-a', sort: 1, created_at: at });
  const b1 = card('SCM-H3', { id: 'aa-b1', sort: 2, sibling_group: 'eoq', created_at: at });
  const b2 = card('SCM-H3', { id: 'aa-b2', sort: 3, sibling_group: 'eoq', created_at: at });
  const c = card('SCM-H3', { id: 'mm-c', sort: 4, created_at: at });
  const q = buildQueue(input([c, b2, a, b1], []));
  assert.deepEqual(ids(q.items), ['zz-a', 'aa-b1', 'aa-b2', 'mm-c']);
});

test('herhaling answers today never tick off or reshuffle the day list', () => {
  const c = card('SCM-H3', { id: 'h1' });
  const rows = [...inBox('h1', 3, TODAY), review('h1', TODAY, 'niet'), review('h1', TODAY, 'gekend', { mode: 'herhaling' })];
  const q = buildQueue(input([c], rows));
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].done, true);
  assert.equal(q.repeats.length, 0, 'a right herhaling ends the repeats');
  assert.equal(q.items[0].state.box, 3, 'the list shows the state of this morning');
});

test('the cap counts due cards only; new cards fill up to new_max on top', () => {
  const due = Array.from({ length: 25 }, (_, i) => card('SCM-H3', { id: `due-${String(i).padStart(2, '0')}` }));
  const fresh = Array.from({ length: 12 }, (_, i) => card('FB-H1', { id: `new-${String(i).padStart(2, '0')}` }));
  const rows = due.flatMap((c) => inBox(c.id, 2, TODAY));
  const q = buildQueue(input([...due, ...fresh], rows));
  assert.equal(q.items.filter((i) => i.kind === 'review').length, 20);
  assert.equal(q.items.filter((i) => i.kind === 'new').length, 10);
  assert.equal(q.rolledOver, 5);
});

/* ---- a round over one chapter or course, any time ---- */

test('study round: due first, then new in chapter order, then early ones; answered today left out', () => {
  const due = card('SCM-H3', { id: 'due' });
  const early = card('SCM-H3', { id: 'early' });
  const fresh2 = card('SCM-H3', { id: 'new-2', sort: 2 });
  const fresh1 = card('SCM-H3', { id: 'new-1', sort: 1 });
  const done = card('SCM-H3', { id: 'done-today' });
  const other = card('FB-H1', { id: 'fb' });
  const reviews = [
    ...inBox('due', 2, '2026-10-26'),
    ...inBox('early', 3, '2026-10-30'), // last seen 23/10, due Friday
    review('done-today', TODAY, 'gekend', { mode: 'extra' }),
  ];
  // A day without room in today's lists: everything is extra practice.
  const none = [plan(TODAY, [], { cap: 0, new_max: 0 })];
  const r = studyRound(input([due, early, fresh2, fresh1, done, other], reviews, { dayPlans: none }), { kind: 'hoofdstuk', id: 'SCM-H3' });
  assert.deepEqual(ids(r.items), ['due', 'new-1', 'new-2', 'early']);
  assert.deepEqual([r.left, r.inToday], [0, 0]);
  const small = studyRound(input([due, early, fresh2, fresh1], reviews, { dayPlans: none }), { kind: 'vak', id: 'SCM' }, 2);
  assert.deepEqual(ids(small.items), ['due', 'new-1']);
  assert.equal(small.left, 2, 'the next round carries on');
});

test('extra practice never touches today\'s lists: their cards stay there, the round takes the rest', () => {
  const due = card('SCM-H3', { id: 'due' });
  const early = card('SCM-H3', { id: 'early' });
  const fresh = card('SCM-H3', { id: 'new-1' });
  const reviews = [...inBox('due', 2, TODAY), ...inBox('early', 3, '2026-10-30')];
  const all = input([due, early, fresh], reviews);
  const r = studyRound(all, { kind: 'hoofdstuk', id: 'SCM-H3' });
  assert.deepEqual(ids(r.items), ['early'], 'the due and the new card wait in today\'s lists');
  assert.equal(r.inToday, 2);
  // After the extra round, today's lists are exactly what they were.
  const after = buildQueue(input([due, early, fresh], [...reviews, review('early', TODAY, 'gekend', { mode: 'extra' })]));
  assert.deepEqual(ids(after.items), ids(buildQueue(all).items));
  assert.equal(after.doneCount, 0);
});

/* ---- two lists a day: 🌅 herhaling at 7:00, 🌙 new cards in the evening (29/10) ---- */

function sessionOf(key: string, cardIds: string[], kind: StudySession['kind'] = 'zelfstudie'): StudySession {
  const chapterId = key.split(':')[0];
  return {
    id: `s-${key}`, session_key: key, course_id: chapterId.split('-')[0], chapter_id: chapterId,
    kind, title: key, card_ids: cardIds, created_at: T0, updated_at: T0,
  };
}

test('sessionDay: the study day of a lesson or self-study key; none for imports', () => {
  assert.equal(sessionDay({ session_key: 'BR-D2:2026-10-29:1-17', kind: 'zelfstudie' }), '2026-10-29');
  assert.equal(sessionDay({ session_key: 'SCM-H1:migratie:1', kind: 'import' }), null);
  assert.equal(sessionDay({ session_key: 'OR-S1:inhaal', kind: 'les' }), null);
});

test('the day in two lists: the evening\'s new cards first in the day, then the morning\'s', () => {
  const due = card('SCM-H3', { id: 'due-1' });
  const fresh = card('FB-H1', { id: 'new-1' });
  const q = buildQueue(input([due, fresh], inBox('due-1', 2, TODAY)));
  assert.deepEqual(ids(q.parts.review.items), ['due-1']);
  assert.deepEqual(ids(q.parts.new.items), ['new-1']);
  assert.deepEqual(ids(q.items), ['new-1', 'due-1']);
  assert.deepEqual([q.parts.review.progress, q.parts.new.courseChips], [0, ['FB']]);
});

test('evening list: today\'s and yesterday\'s study always and first, then the rest up to new_max', () => {
  const t1 = card('FB-H1', { id: 'today-1' });
  const t2 = card('FB-H1', { id: 'today-2' });
  const y1 = card('FB-H1', { id: 'yest-1' });
  const old1 = card('FB-H1', { id: 'old-1' });
  const imp = card('FB-H1', { id: 'import-1' });
  const sessions = [
    sessionOf(`FB-H1:${TODAY}:p10`, ['today-1', 'today-2']),
    sessionOf(`FB-H1:${addDays(TODAY, -1)}:p8`, ['yest-1']),
    sessionOf(`FB-H1:${addDays(TODAY, -4)}:p5`, ['old-1']),
    sessionOf('FB-H1:migratie', ['import-1'], 'import'),
  ];
  const all = [imp, old1, y1, t2, t1];
  const two = buildQueue(input(all, [], { sessions, dayPlans: [plan(TODAY, [], { new_max: 2 })] }));
  assert.deepEqual(ids(two.items), ['today-1', 'today-2', 'yest-1'], 'today and yesterday always, even past new_max');
  const five = buildQueue(input(all, [], { sessions, dayPlans: [plan(TODAY, [], { new_max: 5 })] }));
  assert.deepEqual(ids(five.items), ['today-1', 'today-2', 'yest-1', 'old-1', 'import-1'], 'then the most recent study, imports last');
  assert.ok(five.items.every((i) => i.kind === 'new'));
});

test('29/10: SCM done as extra practice never eats the places of the planned BR and OR cards', () => {
  const brToday = Array.from({ length: 3 }, (_, i) => card('BR-D2', { id: `br-today-${i}` }));
  const orToday = Array.from({ length: 3 }, (_, i) => card('OR-S2', { id: `or-today-${i}` }));
  const brOld = Array.from({ length: 6 }, (_, i) => card('BR-D1', { id: `br-old-${i}` }));
  const orOld = Array.from({ length: 6 }, (_, i) => card('OR-S1', { id: `or-old-${i}` }));
  const scm = Array.from({ length: 12 }, (_, i) => card('SCM-H1', { id: `scm-${String(i).padStart(2, '0')}` }));
  const sessions = [
    sessionOf(`BR-D2:${TODAY}:1-17`, brToday.map((c) => c.id)),
    sessionOf(`OR-S2:${TODAY}:1-28`, orToday.map((c) => c.id)),
  ];
  // The old app logged those rounds as 'sessie'; from now on they are 'extra'.
  for (const mode of ['sessie', 'extra'] as const) {
    const rows = scm.map((c) => review(c.id, TODAY, 'gekend', { mode }));
    const q = buildQueue(
      input([...brToday, ...orToday, ...brOld, ...orOld, ...scm], rows, {
        sessions,
        dayPlans: [plan(TODAY, ['BR', 'OR'], { new_max: 10 })],
      }),
    );
    assert.deepEqual(
      ids(q.parts.new.items),
      ['br-today-0', 'br-today-1', 'br-today-2', 'or-today-0', 'or-today-1', 'or-today-2', 'br-old-0', 'br-old-1', 'or-old-0', 'or-old-1'],
      mode,
    );
    assert.equal(q.parts.new.doneCount, 0, `${mode}: nothing of the evening list is done yet`);
  }
});

test('due cards done as extra practice leave their place to the next; ticked-off list cards keep theirs', () => {
  const cards = Array.from({ length: 6 }, (_, i) => card('SCM-H3', { id: `d-${i}` }));
  const before = cards.flatMap((c) => inBox(c.id, 2, TODAY));
  const p = [plan(TODAY, [], { cap: 3 })];
  assert.deepEqual(ids(buildQueue(input(cards, before, { dayPlans: p })).parts.review.items), ['d-0', 'd-1', 'd-2']);
  const rows = [...before, review('d-0', TODAY, 'gekend'), review('d-1', TODAY, 'gekend', { mode: 'extra' })];
  const q = buildQueue(input(cards, rows, { dayPlans: p }));
  assert.deepEqual(ids(q.parts.review.items), ['d-0', 'd-2', 'd-3']);
  assert.deepEqual(ids(q.parts.review.remaining), ['d-2', 'd-3']);
  assert.equal(q.rolledOver, 2, 'd-4 and d-5 wait; d-1 is done');
});

test('a card of today\'s study done as extra practice is ticked off, not asked again', () => {
  const a = card('FB-H1', { id: 'fresh-a' });
  const b = card('FB-H1', { id: 'fresh-b' });
  const sessions = [sessionOf(`FB-H1:${TODAY}:p1`, ['fresh-a', 'fresh-b'])];
  const q = buildQueue(input([a, b], [review('fresh-a', TODAY, 'gekend', { mode: 'extra' })], { sessions }));
  assert.deepEqual(ids(q.parts.new.items), ['fresh-a', 'fresh-b']);
  assert.deepEqual(ids(q.parts.new.remaining), ['fresh-b']);
});

test('owed repeats: a right answer as extra practice settles a fail; a fail as extra owes nothing', () => {
  assert.equal(owedRepeats([review('x', TODAY, 'niet'), review('x', TODAY, 'gekend', { mode: 'extra' })], TODAY).has('x'), false);
  assert.equal(owedRepeats([review('y', TODAY, 'niet', { mode: 'extra' })], TODAY).has('y'), false);
});

test('yesterday\'s study not reviewed yet comes back first the next evening', () => {
  const c = card('BR-D2', { id: 'thu-card' });
  const other = card('SCM-H3', { id: 'scm-new' });
  const sessions = [sessionOf(`BR-D2:${addDays(TODAY, -1)}:1-17`, ['thu-card'])];
  const q = buildQueue(input([other, c], [], { sessions, dayPlans: [plan(TODAY, ['SCM'], { new_max: 1 })] }));
  assert.deepEqual(ids(q.parts.new.items), ['thu-card'], 'even when the plan names other courses');
});
