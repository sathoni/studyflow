/**
 * Mini-quizzes: the three kinds, sampling, grading, Belgian numbers, lists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Quiz, QuizAttempt, QuizItem } from './model.ts';
import {
  MAX_FIX_TRIES,
  RUN_LENGTH,
  attemptRow,
  buildMistakeRun,
  buildRun,
  cardsStillWrong,
  chapterQuizList,
  courseQuizList,
  formatBelgianNumber,
  gradeAnswer,
  homeQuizSuggestion,
  levenshtein,
  matchCloze,
  matchNumeric,
  normalizeAnswer,
  parseBelgianNumber,
  parseScope,
  poolFor,
  recentItemIds,
  retryQuestion,
  runLength,
  runScores,
  runsAgo,
  sampleItems,
  wrongCardsOf,
  scopeKey,
  sessionQuizList,
  showOptions,
  summarizeRun,
  weakCards,
  type Grade,
  type QuizData,
} from './quiz.ts';
import { COURSES, T0, attempt, card, chapter, item, seeded } from './testkit.ts';

const CHAPTERS = [chapter('SCM-H2', 2, 'af'), chapter('SCM-H3', 3), chapter('FB-H1', 1), chapter('BE-U1', 1)];

/** 12 SCM-H3 cards with an mcq, a tf and a cloze each; 3 SCM-H2 cards; 2 FB cards with numeric items. */
function world() {
  const cards: Card[] = [];
  const items: QuizItem[] = [];
  for (let i = 0; i < 12; i++) {
    const c = card('SCM-H3', { id: `h3-${String(i).padStart(2, '0')}` });
    cards.push(c);
    items.push(item(c, 'mcq'), item(c, 'tf'), item(c, 'cloze'));
  }
  for (let i = 0; i < 3; i++) {
    const c = card('SCM-H2', { id: `h2-${i}` });
    cards.push(c);
    items.push(item(c, 'mcq'));
  }
  for (let i = 0; i < 2; i++) {
    const c = card('FB-H1', { id: `fb-${i}` });
    cards.push(c);
    items.push(item(c, 'numeric'), item(c, 'mcq'));
  }
  // BE cards exist and are reviewed, but have no quiz items (the database refuses them);
  // one sneaks in here anyway to prove the app ignores it too.
  const be = card('BE-U1', { id: 'be-0' });
  cards.push(be);
  items.push(item(be, 'cloze'));
  return { cards, items };
}

function data(extra: Partial<QuizData> = {}): QuizData {
  const { cards, items } = world();
  return { courses: COURSES, chapters: CHAPTERS, cards, items, quizzes: [], sessions: [], attempts: [], ...extra };
}

function sessionQuiz(id: string, itemIds: string[], extra: Partial<Quiz> = {}): Quiz {
  return {
    id, kind: 'sessie', session_id: `s-${id}`, course_id: 'SCM', chapter_id: 'SCM-H3',
    title: 'SCM H3 · dia 121–135', item_ids: itemIds, created_at: T0, updated_at: T0, ...extra,
  };
}

/* ---- scopes ---- */

test('scope keys match quiz_attempts.scope', () => {
  assert.equal(scopeKey({ kind: 'sessie', id: 'q1' }), 'sessie:q1');
  assert.equal(scopeKey({ kind: 'hoofdstuk', id: 'SCM-H3' }), 'hoofdstuk:SCM-H3');
  assert.deepEqual(parseScope('vak:FB'), { kind: 'vak', id: 'FB' });
  assert.equal(parseScope('weekquiz:1'), null);
  assert.equal(parseScope(null), null);
});

/* ---- the session quiz ---- */

test('session quiz: the first time exactly its fixed items, in their order', () => {
  const d = data();
  const ids = d.items.filter((i) => i.chapter_id === 'SCM-H3').slice(0, 8).map((i) => i.id);
  d.quizzes = [sessionQuiz('q1', ids)];
  const a = buildRun({ kind: 'sessie', id: 'q1' }, d, { rng: seeded(1) })!;
  const b = buildRun({ kind: 'sessie', id: 'q1' }, d, { rng: seeded(99) })!;
  assert.deepEqual(a.questions.map((q) => q.item.id), ids);
  assert.deepEqual(b.questions.map((q) => q.item.id), ids, 'not done yet: still the fixed set');
  assert.equal(a.title, 'SCM H3 · dia 121–135');
  assert.equal(a.scope_key, 'sessie:q1');
  assert.equal(a.kind_label, 'Na je studie');
  assert.deepEqual(a.questions.map((q) => q.n), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('session quiz done before: same cards, other questions (unseen items first)', () => {
  const d = data();
  // 4 cards (h3-00 … h3-03) with 3 items each; the fixed quiz holds their mcq items.
  const cards = ['h3-00', 'h3-01', 'h3-02', 'h3-03'];
  const fixed = d.items.filter((i) => cards.includes(i.card_id) && i.format === 'mcq');
  d.quizzes = [sessionQuiz('q1', fixed.map((i) => i.id))];
  d.attempts = fixed.map((i, n) => attempt(i, 'run-1-0000-4000-8000-000000000001', 'sessie:q1', true, '2026-10-25', n));
  const redo = buildRun({ kind: 'sessie', id: 'q1' }, d, { rng: seeded(5), now: Date.parse('2026-10-26T18:00:00Z') })!;
  assert.equal(redo.questions.length, fixed.length, 'same length');
  assert.ok(redo.questions.every((q) => cards.includes(q.item.card_id)), 'same material');
  assert.ok(redo.questions.every((q) => q.item.format !== 'mcq'), 'the mcq items were just asked: other wordings first');
});

test('weak spots: up to half of a chapter quiz goes back to what went wrong, in another wording', () => {
  const d = data();
  const wrong = d.items.filter((i) => i.chapter_id === 'SCM-H3' && i.format === 'mcq').slice(0, 3);
  d.attempts = wrong.map((i, n) => attempt(i, 'run-2-0000-4000-8000-000000000002', 'hoofdstuk:SCM-H3', false, '2026-10-24', n));
  const now = Date.parse('2026-10-26T18:00:00Z');
  for (let seed = 1; seed <= 5; seed++) {
    const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(seed), now })!;
    const weakAsked = run.questions.filter((q) => wrong.some((w) => w.card_id === q.item.card_id));
    assert.equal(weakAsked.length, 3, 'all three weak cards come back (half of 10 = 5 slots)');
    assert.ok(weakAsked.every((q) => q.item.format !== 'mcq'), 'asked in another wording than the one that went wrong');
  }
  // Answered right since: no longer weak. Older than 21 days: forgotten as a weak spot.
  const fixedLater = [...d.attempts, ...wrong.map((i, n) => attempt(i, 'run-3-0000-4000-8000-000000000003', 'hoofdstuk:SCM-H3', true, '2026-10-25', n))];
  assert.equal(weakCards(fixedLater, now).size, 0);
  assert.equal(weakCards(d.attempts, Date.parse('2026-11-20T18:00:00Z')).size, 0);
});

test('session quiz skips retired items and items of cards that left the queue', () => {
  const d = data();
  const [i1, i2, i3] = d.items.filter((i) => i.format === 'mcq' && i.chapter_id === 'SCM-H3');
  d.items = d.items.map((i) => (i.id === i2.id ? { ...i, status: 'retired' as const } : i));
  d.cards = d.cards.map((c) => (c.id === i3.card_id ? { ...c, status: 'needs_check' as const } : c));
  d.quizzes = [sessionQuiz('q1', [i1.id, i2.id, i3.id, 'missing-item'])];
  assert.deepEqual(buildRun({ kind: 'sessie', id: 'q1' }, d)!.questions.map((q) => q.item.id), [i1.id]);
});

/* ---- Business English ---- */

test('Business English never gets a quiz of any kind', () => {
  const d = data();
  const beItem = d.items.find((i) => i.course_id === 'BE')!;
  d.quizzes = [sessionQuiz('qbe', [beItem.id], { course_id: 'BE', chapter_id: 'BE-U1' })];
  assert.equal(buildRun({ kind: 'sessie', id: 'qbe' }, d), null);
  assert.equal(buildRun({ kind: 'hoofdstuk', id: 'BE-U1' }, d), null);
  assert.equal(buildRun({ kind: 'vak', id: 'BE' }, d), null);
  assert.equal(poolFor({ kind: 'vak', id: 'BE' }, d).length, 0);
  assert.ok(!chapterQuizList(d).some((e) => e.chapter.course_id === 'BE'));
  assert.ok(!courseQuizList(d).some((e) => e.course.id === 'BE'));
  assert.ok(!sessionQuizList(d).some((e) => e.quiz.course_id === 'BE'));
});

/* ---- sampled runs ---- */

test('chapter quiz: 10 questions, at most one per card, only from that chapter', () => {
  const d = data();
  for (let seed = 1; seed <= 20; seed++) {
    const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(seed) })!;
    assert.equal(run.questions.length, RUN_LENGTH);
    const cards = run.questions.map((q) => q.item.card_id);
    assert.equal(new Set(cards).size, cards.length, 'one item per card');
    assert.ok(run.questions.every((q) => q.item.chapter_id === 'SCM-H3'));
    assert.equal(run.title, 'SCM H3');
    assert.equal(run.chapter_id, 'SCM-H3');
  }
});

test('formats are mixed as evenly as the pool allows', () => {
  const d = data();
  for (let seed = 1; seed <= 20; seed++) {
    const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(seed) })!;
    const count = { mcq: 0, tf: 0, cloze: 0, numeric: 0 };
    for (const q of run.questions) count[q.format]++;
    // 10 questions over three formats: 4/3/3 in some order.
    assert.deepEqual([count.mcq, count.tf, count.cloze].sort(), [3, 3, 4], JSON.stringify(count));
  }
});

test('a course quiz mixes chapters and still keeps one item per card', () => {
  const d = data();
  const run = buildRun({ kind: 'vak', id: 'SCM' }, d, { rng: seeded(3) })!;
  assert.equal(run.questions.length, 10);
  assert.ok(run.questions.every((q) => q.item.course_id === 'SCM'));
  assert.equal(run.title, 'Supply Chain Management');
  assert.equal(run.kind_label, 'Gemengde quiz');
  // Across a few runs, both chapters show up.
  const chapters = new Set<string>();
  for (let s = 1; s <= 10; s++) {
    for (const q of buildRun({ kind: 'vak', id: 'SCM' }, d, { rng: seeded(s) })!.questions) chapters.add(q.item.chapter_id);
  }
  assert.deepEqual([...chapters].sort(), ['SCM-H2', 'SCM-H3']);
});

test('a small pool gives a shorter quiz, an empty pool none', () => {
  const d = data();
  const run = buildRun({ kind: 'hoofdstuk', id: 'FB-H1' }, d, { rng: seeded(1) })!;
  assert.equal(run.questions.length, 2, 'two FB cards, one item each');
  assert.equal(buildRun({ kind: 'hoofdstuk', id: 'OR-H9' }, d), null);
  assert.equal(buildRun({ kind: 'sessie', id: 'nope' }, d), null);
});

test('items seen in the last 2 runs are avoided while unseen ones remain', () => {
  const d = data();
  const pool = poolFor({ kind: 'hoofdstuk', id: 'SCM-H3' }, d);
  // Two recent runs asked the mcq and the tf of cards 0–9; a third, older run their cloze.
  const old: QuizAttempt[] = [];
  const firstTen = (format: string) => pool.filter((i) => i.format === format).slice(0, 10);
  const runA = firstTen('mcq');
  const runB = firstTen('tf');
  const runOld = firstTen('cloze');
  runOld.forEach((i, n) => old.push(attempt(i, 'aaaaaaaa-run-old', 'hoofdstuk:SCM-H3', true, '2026-10-01', n)));
  runA.forEach((i, n) => old.push(attempt(i, 'bbbbbbbb-run-a', 'hoofdstuk:SCM-H3', true, '2026-10-20', n)));
  runB.forEach((i, n) => old.push(attempt(i, 'cccccccc-run-b', 'vak:SCM', false, '2026-10-22', n)));
  const recent = recentItemIds(old, new Set(pool.map((i) => i.id)));
  assert.deepEqual([...recent].sort(), [...runA, ...runB].map((i) => i.id).sort(), 'the old run is forgotten');

  for (let seed = 1; seed <= 10; seed++) {
    const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, { ...d, attempts: old }, { rng: seeded(seed) })!;
    assert.equal(run.questions.length, 10);
    // 36 items, 20 recent: every card still has an unseen item (its cloze, or all
    // three for cards 10–11), so none of the recent ones is asked.
    assert.ok(run.questions.every((q) => !recent.has(q.item.id)), `seed ${seed}`);
  }
});

test('when everything was seen lately, recent items are asked rather than nothing', () => {
  const d = data();
  const pool = poolFor({ kind: 'hoofdstuk', id: 'FB-H1' }, d);
  const seen = pool.map((i, n) => attempt(i, 'dddddddd-run', 'hoofdstuk:FB-H1', true, '2026-10-24', n));
  const run = buildRun({ kind: 'hoofdstuk', id: 'FB-H1' }, { ...d, attempts: seen }, { rng: seeded(5) })!;
  assert.equal(run.questions.length, 2);
});

test('runs vary: two runs of the same chapter rarely ask the same ten in the same order', () => {
  const d = data();
  const a = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(11) })!;
  const b = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(12) })!;
  assert.notDeepEqual(a.questions.map((q) => q.item.id), b.questions.map((q) => q.item.id));
});

test('sampleItems is deterministic for a seed and never repeats a card', () => {
  const d = data();
  const pool = poolFor({ kind: 'vak', id: 'SCM' }, d);
  const x = sampleItems(pool, new Set(), 10, seeded(7)).map((i) => i.id);
  const y = sampleItems(pool, new Set(), 10, seeded(7)).map((i) => i.id);
  assert.deepEqual(x, y);
  const all = sampleItems(pool, new Set(), 100, seeded(7));
  assert.equal(all.length, 15, 'one per card: 12 + 3 SCM cards');
});

/* ---- options ---- */

test('mcq options are shuffled with letters A–D; the correct one is tracked', () => {
  const c = card('SCM-H3');
  const mcq = item(c, 'mcq');
  const positions = new Set<number>();
  for (let s = 1; s <= 30; s++) {
    const shown = showOptions(mcq, seeded(s))!;
    assert.deepEqual(shown.map((o) => o.letter), ['A', 'B', 'C', 'D']);
    assert.equal(shown.filter((o) => o.correct).length, 1);
    const right = shown.find((o) => o.correct)!;
    assert.equal(right.text, 'Juist antwoord');
    assert.equal(right.index, 0, 'index points back into the stored options');
    positions.add(shown.indexOf(right));
  }
  assert.equal(positions.size, 4, 'the right answer lands on every letter over 30 runs');
});

test('true/false always reads Juist, Fout', () => {
  const c = card('SCM-H3');
  const tf = item(c, 'tf', {
    options: [
      { text: 'Fout', correct: true, why: 'Want …' },
      { text: 'Juist', correct: false, why: 'Nee.' },
    ],
  });
  for (let s = 1; s <= 5; s++) assert.deepEqual(showOptions(tf, seeded(s))!.map((o) => o.text), ['Juist', 'Fout']);
  assert.equal(showOptions(item(c, 'cloze')), null);
});

/* ---- typed answers ---- */

test('cloze matching is lenient: case, accents, punctuation, articles, one typo', () => {
  const accept = ['economische voorraad', 'economische'];
  assert.ok(matchCloze('Economische voorraad', accept));
  assert.ok(matchCloze('  economische   voorraad. ', accept));
  assert.ok(matchCloze('de economische voorraad', accept));
  assert.ok(matchCloze('economisch', accept), 'one letter short of a long word');
  assert.ok(matchCloze('econimische', accept), 'one wrong letter');
  assert.ok(matchCloze('Créditeur', ['crediteur']));
  assert.ok(!matchCloze('technische voorraad', accept));
  assert.ok(!matchCloze('', accept));
  assert.ok(matchCloze('de', ['de']), 'a lone article is still an answer');
  // Short answers must be exact: one typo in "btw" is another word.
  assert.ok(matchCloze('BTW', ['btw']));
  assert.ok(!matchCloze('bte', ['btw']));
  assert.equal(normalizeAnswer("L'Été, de zon!"), 'l ete de zon');
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('abc', 'abcdef', 1), 2, 'stops early above the limit');
});

test('Belgian numbers', () => {
  const cases: [string, number | null][] = [
    ['41.000', 41000],
    ['41000', 41000],
    ['41 000', 41000],
    ['877,95', 877.95],
    ['1.234.567,8', 1234567.8],
    ['1.234.567', 1234567],
    ['2.5', 2.5],
    ['0.125', 0.125],
    ['1234.567', 1234.567],
    ['12.500', 12500],
    [',5', 0.5],
    ['-12,5', -12.5],
    ['−3', -3],
    ['€ 1 250,50', 1250.5],
    ['2020 stuks', 2020],
    ['12 %', 12],
    ['Q = 878.', 878],
    ['1,234.56', 1234.56],
    ['1,000,000', 1000000],
    ['abc', null],
    ['', null],
    ['1.2.3', null],
    ['1,2,3', null],
  ];
  for (const [input, want] of cases) assert.equal(parseBelgianNumber(input), want, JSON.stringify(input));
  assert.equal(formatBelgianNumber(2020), '2.020');
  assert.equal(formatBelgianNumber(877.95), '877,95');
});

test('numeric answers: tolerance, units, and a 1% default', () => {
  const a = { value: 2020, unit: 'stuks', tolerance: 0.5, steps: [] };
  assert.ok(matchNumeric('2.020', a));
  assert.ok(matchNumeric('2020,4 stuks', a));
  assert.ok(!matchNumeric('2021', a));
  assert.ok(!matchNumeric('twee', a));
  const b = { value: 878 };
  assert.ok(matchNumeric('877,95', b));
  assert.ok(matchNumeric('885', b), 'within 1%');
  assert.ok(!matchNumeric('890', b));
  assert.ok(matchNumeric('0', { value: 0 }), 'exact zero');
});

/* ---- grading and the end screen ---- */

test('gradeAnswer: mcq tap, tf correction, cloze and numeric text', () => {
  const c = card('SCM-H3');
  const mcqQ = { n: 1, item: item(c, 'mcq'), format: 'mcq' as const, formatLabel: 'Meerkeuze', options: null as never };
  mcqQ.options = showOptions(mcqQ.item, seeded(4)) as never;
  const right = (mcqQ.options as { correct: boolean }[]).findIndex((o) => o.correct);
  const wrong = right === 0 ? 1 : 0;
  assert.equal(gradeAnswer(mcqQ, { option: right }).correct, true);
  const g = gradeAnswer(mcqQ, { option: wrong });
  assert.equal(g.correct, false);
  assert.equal(g.expected, 'Juist antwoord');
  assert.ok(g.chosen && !g.chosen.correct && g.chosen.why);

  const tfItem = item(c, 'tf');
  const tfQ = { n: 2, item: tfItem, format: 'tf' as const, formatLabel: 'Juist of fout', options: showOptions(tfItem) };
  const tg = gradeAnswer(tfQ, { option: 1 }); // "Fout" is right in the fixture
  assert.equal(tg.correct, true);
  assert.equal(tg.correction, 'Zo is het wel.');

  const clozeItem = item(c, 'cloze');
  const cq = { n: 3, item: clozeItem, format: 'cloze' as const, formatLabel: 'Invullen', options: null };
  assert.equal(gradeAnswer(cq, { text: 'Economische' }).correct, true);
  assert.equal(gradeAnswer(cq, { text: 'fysieke' }).expected, 'economische');

  const numItem = item(c, 'numeric', { answer: { value: 2020, unit: 'stuks', tolerance: 0.5, steps: ['Q = √(2·D·Cb/Cv)'] } });
  const nq = { n: 4, item: numItem, format: 'numeric' as const, formatLabel: 'Rekenen', options: null };
  const ng = gradeAnswer(nq, { text: '2.020' });
  assert.equal(ng.correct, true);
  assert.equal(ng.expected, '2.020 stuks');
  assert.deepEqual(ng.steps, ['Q = √(2·D·Cb/Cv)']);
});

test('attemptRow carries run, scope, study day and the original option index', () => {
  const d = data();
  const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(2), runId: 'run-1' })!;
  const q = run.questions.find((x) => x.format === 'mcq')!;
  const tap = 2;
  const g = gradeAnswer(q, { option: tap });
  const row = attemptRow(run, q, { option: tap }, g, true, new Date('2026-10-26T01:30:00Z'), 'att-1');
  assert.equal(row.id, 'att-1');
  assert.equal(row.run_id, 'run-1');
  assert.equal(row.scope, 'hoofdstuk:SCM-H3');
  assert.equal(row.card_id, q.item.card_id);
  assert.equal(row.hint_used, true);
  assert.equal(row.day, '2026-10-25', '02:30 Brussels still belongs to the evening before');
  assert.deepEqual(row.answer, { option: q.options![tap].index, text: q.options![tap].text });
  const typed = attemptRow(run, q, { text: 'x' }, { correct: false, chosen: null }, false);
  assert.deepEqual(typed.answer, { text: 'x' });
});

test('end screen: score, mistakes, and which cards come back tomorrow', () => {
  const d = data();
  const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(9) })!;
  const grades = new Map<number, Grade>();
  for (const q of run.questions) {
    const right = q.n > 2;
    grades.set(q.n, { correct: right, expected: '', chosen: null, explanation: null, correction: null, steps: [] });
  }
  const r = summarizeRun(run, grades);
  assert.equal(r.score, '8/10');
  assert.equal(r.mistakes.length, 2);
  assert.equal(r.backTomorrow.length, 2);
  assert.equal(r.backLabel, 'Deze 2 kaartjes komen morgen terug');
  const one = summarizeRun(run, new Map([[1, { ...grades.get(1)! }]]));
  assert.equal(one.backLabel, 'Dit kaartje komt morgen terug');
  const none = summarizeRun(run, new Map());
  assert.equal(none.backLabel, null);
  assert.equal(none.score, '0/10');
});

/* ---- lists ---- */

test('Quiz tab: open session quizzes first, done ones with their last score', () => {
  const d = data();
  const h3 = d.items.filter((i) => i.chapter_id === 'SCM-H3');
  const qOld = sessionQuiz('q-old', h3.slice(0, 3).map((i) => i.id), { created_at: '2026-10-20T18:00:00Z', title: 'SCM H3 · dia 100–110' });
  const qNew = sessionQuiz('q-new', h3.slice(3, 6).map((i) => i.id), { created_at: '2026-10-25T18:00:00Z', title: 'SCM H3 · dia 121–135' });
  const qDone = sessionQuiz('q-done', h3.slice(6, 9).map((i) => i.id), { created_at: '2026-10-22T18:00:00Z' });
  const attempts = h3.slice(6, 9).map((i, n) => attempt(i, 'eeeeeeee-run', 'sessie:q-done', n !== 0, '2026-10-23', n));
  const list = sessionQuizList({ ...d, quizzes: [qOld, qDone, qNew], attempts });
  assert.deepEqual(list.map((e) => e.quiz.id), ['q-new', 'q-old', 'q-done']);
  assert.deepEqual(list.map((e) => e.done), [false, false, true]);
  assert.deepEqual([list[2].last!.correct, list[2].last!.total], [2, 3]);

  const home = homeQuizSuggestion({ ...d, quizzes: [qOld, qDone, qNew], attempts });
  assert.equal(home?.kind, 'sessie');
  assert.equal(home?.label, 'Nieuwe quiz · SCM H3 · dia 121–135');
});

test('finished chapters are highlighted until their chapter quiz is done', () => {
  const d = data();
  const list = chapterQuizList(d);
  assert.deepEqual(list.map((e) => e.chapter.id), ['SCM-H2', 'SCM-H3', 'FB-H1']);
  const h2 = list.find((e) => e.chapter.id === 'SCM-H2')!;
  assert.deepEqual([h2.finished, h2.highlighted, h2.pool], [true, true, 3]);
  assert.equal(list.find((e) => e.chapter.id === 'SCM-H3')!.highlighted, false);

  // No open session quiz: Home suggests the finished chapter.
  const home = homeQuizSuggestion(d);
  assert.equal(home?.kind, 'hoofdstuk');
  assert.equal(home?.label, 'Mini-quiz · SCM H2 · 3 vragen');

  const pool = poolFor({ kind: 'hoofdstuk', id: 'SCM-H2' }, d);
  const done = pool.map((i, n) => attempt(i, 'ffffffff-run', 'hoofdstuk:SCM-H2', true, '2026-10-25', n));
  const after = chapterQuizList({ ...d, attempts: done }).find((e) => e.chapter.id === 'SCM-H2')!;
  assert.deepEqual([after.finished, after.highlighted, after.runs], [true, false, 1]);
  assert.equal(homeQuizSuggestion({ ...d, attempts: done }), null);
});

test('course list: average and trend over the last five runs of any kind', () => {
  const d = data();
  const h3 = d.items.filter((i) => i.chapter_id === 'SCM-H3');
  const attempts: QuizAttempt[] = [];
  // Six runs, oldest first, scoring 0/2, 1/2, 2/2, 2/2, 1/2, 2/2.
  const right = [0, 1, 2, 2, 1, 2];
  right.forEach((r, k) => {
    const runId = `${String(k).padStart(8, '0')}-run`;
    h3.slice(0, 2).forEach((i, n) => attempts.push(attempt(i, runId, 'hoofdstuk:SCM-H3', n < r, `2026-10-${10 + k}`, n)));
  });
  const scm = courseQuizList({ ...d, attempts }).find((e) => e.course.id === 'SCM')!;
  assert.equal(scm.runs, 6);
  assert.deepEqual(scm.trend, [0.5, 1, 1, 0.5, 1]);
  assert.equal(scm.average, 0.8);
  assert.equal(runScores({ ...d, attempts })[0].course_id, 'SCM');
  const fb = courseQuizList(d).find((e) => e.course.id === 'FB')!;
  assert.deepEqual([fb.runs, fb.average, fb.pool], [0, null, 4]);
});

/* ---- edge cases from the adversarial review (26/10) ---- */

test('a session quiz closed after two questions stays "Nieuwe quiz" on Home until done to the end', () => {
  const d = data();
  const h3 = d.items.filter((i) => i.chapter_id === 'SCM-H3').slice(0, 5);
  const quiz = sessionQuiz('q-half', h3.map((i) => i.id), { title: 'SCM H3 · dia 121–135' });
  const half = h3.slice(0, 2).map((i, n) => attempt(i, 'aaaaaaaa-run', 'sessie:q-half', true, '2026-10-25', n));
  let list = sessionQuizList({ ...d, quizzes: [quiz], attempts: half });
  assert.deepEqual([list[0].done, list[0].questions, list[0].runs], [false, 5, 0]);
  assert.equal(homeQuizSuggestion({ ...d, quizzes: [quiz], attempts: half })?.label, 'Nieuwe quiz · SCM H3 · dia 121–135');

  const full = h3.map((i, n) => attempt(i, 'bbbbbbbb-run', 'sessie:q-half', n !== 4, '2026-10-26', n));
  list = sessionQuizList({ ...d, quizzes: [quiz], attempts: [...half, ...full] });
  assert.deepEqual([list[0].done, list[0].runs, list[0].last?.correct, list[0].last?.total], [true, 1, 4, 5]);
  assert.notEqual(homeQuizSuggestion({ ...d, quizzes: [quiz], attempts: [...half, ...full] })?.kind, 'sessie');
});

test('a session quiz counts its live questions, not the ids it was made with', () => {
  const d = data();
  const h3 = d.items.filter((i) => i.chapter_id === 'SCM-H3').slice(0, 4);
  const retired = { ...h3[3], status: 'retired' as const };
  const items = d.items.map((i) => (i.id === retired.id ? retired : i));
  const quiz = sessionQuiz('q-4', h3.map((i) => i.id));
  const [entry] = sessionQuizList({ ...d, items, quizzes: [quiz] });
  assert.equal(entry.questions, 3);
  // Three answers are then a complete run.
  const done = h3.slice(0, 3).map((i, n) => attempt(i, 'cccccccc-run', 'sessie:q-4', true, '2026-10-26', n));
  assert.equal(sessionQuizList({ ...d, items, quizzes: [quiz], attempts: done })[0].done, true);
});

test('a chapter quiz stopped halfway keeps the "Hoofdstuk af" highlight', () => {
  const d = data();
  const pool = poolFor({ kind: 'hoofdstuk', id: 'SCM-H2' }, d);
  const half = pool.slice(0, 1).map((i, n) => attempt(i, 'dddddddd-run', 'hoofdstuk:SCM-H2', true, '2026-10-25', n));
  const entry = chapterQuizList({ ...d, attempts: half }).find((e) => e.chapter.id === 'SCM-H2')!;
  assert.equal(entry.highlighted, true);
  assert.equal(homeQuizSuggestion({ ...d, attempts: half })?.kind, 'hoofdstuk');
});

test('examenklaar counts as finished too; bezig and niet_gezien do not', () => {
  const d = data();
  const chapters = d.chapters.map((c) => (c.id === 'SCM-H3' ? { ...c, status: 'examenklaar' as const } : c.id === 'SCM-H2' ? { ...c, status: 'niet_gezien' as const } : c));
  const list = chapterQuizList({ ...d, chapters });
  assert.equal(list.find((e) => e.chapter.id === 'SCM-H3')!.highlighted, true);
  assert.equal(list.find((e) => e.chapter.id === 'SCM-H2')!.finished, false);
});

test('Business English: no session quiz even if one slipped into the data, no chapter or course quiz', () => {
  const d = data();
  const beItems = d.items.filter((i) => i.course_id === 'BE');
  const beChapter = d.chapters.find((c) => c.course_id === 'BE')!;
  const sneaky = sessionQuiz('q-be', beItems.map((i) => i.id), { course_id: 'BE', chapter_id: beChapter.id });
  const withBe = { ...d, quizzes: [sneaky], chapters: d.chapters.map((c) => (c.course_id === 'BE' ? { ...c, status: 'af' as const } : c)) };
  assert.equal(sessionQuizList(withBe).length, 0);
  assert.equal(chapterQuizList(withBe).some((e) => e.chapter.course_id === 'BE'), false);
  assert.equal(courseQuizList(withBe).some((e) => e.course.id === 'BE'), false);
  const home = homeQuizSuggestion(withBe);
  assert.equal(home?.kind, 'hoofdstuk', 'Home suggests a finished chapter of another course');
  assert.notEqual(home?.kind === 'hoofdstuk' ? home.entry.chapter.course_id : null, 'BE');
  assert.equal(buildRun({ kind: 'sessie', id: 'q-be' }, withBe), null);
  assert.equal(buildRun({ kind: 'hoofdstuk', id: beChapter.id }, withBe), null);
  assert.equal(buildRun({ kind: 'vak', id: 'BE' }, withBe), null);
});

test('a chapter with 9 cards and 27 items announces 9 questions, not 10', () => {
  const cards = Array.from({ length: 9 }, (_, n) => card('SCM-H3', { id: `nine-${n}` }));
  const items = cards.flatMap((c) => [item(c, 'mcq'), item(c, 'tf'), item(c, 'cloze')]);
  assert.equal(items.length, 27);
  assert.equal(runLength(items), 9);
  const d = data({ cards, items, chapters: [chapter('SCM-H3', 3, 'af')] });
  const [entry] = chapterQuizList(d);
  assert.deepEqual([entry.pool, entry.questions], [27, 9]);
  assert.equal(buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(2) })!.questions.length, 9);
  assert.equal(homeQuizSuggestion(d)?.label, 'Mini-quiz · SCM H3 · 9 vragen');
});

/* ---- smarter quizzes (30/10): no repeats, all mistakes back, "Oefen je fouten" ---- */

/** Answer every question of a run, wrong for the cards in `wrong`. */
function answerRun(run: { run_id: string; scope_key: string; questions: { item: QuizItem }[] }, day: string, wrong: ReadonlySet<string> = new Set()): QuizAttempt[] {
  return run.questions.map((q, n) => attempt(q.item, run.run_id, run.scope_key, !wrong.has(q.item.card_id), day, n));
}

test('quizzing one chapter again and again: every card comes before any card repeats', () => {
  const d = data();
  const cards = d.cards.filter((c) => c.chapter_id === 'SCM-H3').map((c) => c.id);
  let attempts: QuizAttempt[] = [];
  const asked: string[][] = [];
  for (let r = 0; r < 3; r++) {
    const day = `2026-10-2${r}`;
    const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, { ...d, attempts }, { rng: seeded(r + 1), runId: `run-${r}-0000-4000-8000-000000000000`, n: 4 })!;
    asked.push(run.questions.map((q) => q.item.card_id));
    attempts = [...attempts, ...answerRun(run, day)];
  }
  // 12 cards, 4 questions a run: three runs cover all twelve, none twice.
  assert.deepEqual([...asked.flat()].sort(), [...cards].sort());
  // The fourth run starts again with the cards asked longest ago (run 1).
  const fourth = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, { ...d, attempts }, { rng: seeded(9), n: 4 })!;
  assert.deepEqual(fourth.questions.map((q) => q.item.card_id).sort(), [...asked[0]].sort());
  // And in another wording than the first time.
  const firstItems = new Set(attempts.filter((a) => a.run_id.startsWith('run-0')).map((a) => a.item_id));
  assert.ok(fourth.questions.every((q) => !firstItems.has(q.item.id)));
});

test('runsAgo: 0 for the latest run, then older; never asked is missing', () => {
  const d = data();
  const [a, b, c] = d.items.filter((i) => i.chapter_id === 'SCM-H3');
  const rows = [attempt(a, 'run-old', 'hoofdstuk:SCM-H3', true, '2026-10-20'), attempt(b, 'run-new', 'hoofdstuk:SCM-H3', true, '2026-10-22')];
  const ago = runsAgo(rows, new Set([a.id, b.id, c.id]));
  assert.deepEqual([ago.get(b.id), ago.get(a.id), ago.has(c.id)], [0, 1, false]);
});

test('five mistakes out of ten: all five come back in the next chapter quiz, in other words', () => {
  const d = data();
  const first = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(3), runId: 'run-a-0000-4000-8000-000000000000' })!;
  const wrong = new Set(first.questions.slice(0, 5).map((q) => q.item.card_id));
  const attempts = answerRun(first, '2026-10-29', wrong);
  for (let seed = 1; seed <= 5; seed++) {
    const next = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, { ...d, attempts }, { rng: seeded(seed), now: Date.parse('2026-10-30T18:00:00Z') })!;
    const back = next.questions.filter((q) => wrong.has(q.item.card_id));
    assert.equal(back.length, 5, `seed ${seed}`);
    const missed = new Set(attempts.filter((a) => !a.correct).map((a) => a.item_id));
    assert.ok(back.every((q) => !missed.has(q.item.id)), 'another wording than the one that went wrong');
  }
});

test('a session quiz done before never asks one card twice while it skips another', () => {
  const d = data();
  const cards = ['h3-00', 'h3-01', 'h3-02', 'h3-03'];
  // The first time: the mcq and the tf of four cards (8 questions).
  const fixed = d.items.filter((i) => cards.includes(i.card_id) && (i.format === 'mcq' || i.format === 'tf'));
  d.quizzes = [sessionQuiz('q1', fixed.map((i) => i.id))];
  d.attempts = fixed.map((i, n) => attempt(i, 'run-1-0000-4000-8000-000000000001', 'sessie:q1', true, '2026-10-25', n));
  for (let seed = 1; seed <= 5; seed++) {
    const redo = buildRun({ kind: 'sessie', id: 'q1' }, d, { rng: seeded(seed) })!;
    assert.equal(redo.questions.length, 8, 'as long as the first time');
    const perCard = cards.map((c) => redo.questions.filter((q) => q.item.card_id === c).length);
    assert.deepEqual(perCard, [2, 2, 2, 2], `seed ${seed}: every card, none skipped`);
    assert.equal(new Set(redo.questions.map((q) => q.item.id)).size, 8, 'never the same question twice');
  }
});

test('Oefen je fouten: the cards that went wrong, in another wording', () => {
  const d = data();
  const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(4), runId: 'run-f-0000-4000-8000-000000000000' })!;
  const wrong = new Set(run.questions.slice(2, 5).map((q) => q.item.card_id));
  d.attempts = answerRun(run, '2026-10-29', wrong);
  assert.deepEqual(new Set(wrongCardsOf(d.attempts, run.run_id)), wrong);
  const fix = buildMistakeRun(run.run_id, d, { rng: seeded(1), runId: 'fix-1-0000-4000-8000-000000000000' })!;
  assert.equal(fix.scope_key, `fouten:${run.run_id}`);
  assert.equal(fix.kind_label, 'Je fouten oefenen');
  assert.equal(fix.title, 'SCM H3');
  assert.deepEqual(new Set(fix.questions.map((q) => q.item.card_id)), wrong);
  const missed = new Set(d.attempts.filter((a) => !a.correct).map((a) => a.item_id));
  assert.ok(fix.questions.every((q) => !missed.has(q.item.id)), 'other words than the ones that went wrong');
  assert.equal(buildMistakeRun('run-without-mistakes', d), null);
});

test('Oefen je fouten: a wrong card comes back in another wording, three tries at most, until it is right', () => {
  const d = data();
  const run = buildRun({ kind: 'hoofdstuk', id: 'SCM-H3' }, d, { rng: seeded(4), runId: 'run-g-0000-4000-8000-000000000000' })!;
  const cardId = run.questions[0].item.card_id;
  d.attempts = answerRun(run, '2026-10-29', new Set([cardId]));
  const fix = buildMistakeRun(run.run_id, d, { rng: seeded(2) })!;
  const grades = new Map<number, Grade>();
  const wrongGrade = { correct: false } as Grade;
  const rightGrade = { correct: true } as Grade;
  // Wrong, wrong: each time another wording comes back at the end.
  grades.set(1, wrongGrade);
  fix.questions.push(retryQuestion(fix, cardId, d, seeded(3))!);
  grades.set(2, wrongGrade);
  fix.questions.push(retryQuestion(fix, cardId, d, seeded(4))!);
  assert.equal(fix.questions.length, MAX_FIX_TRIES);
  assert.equal(new Set(fix.questions.map((q) => q.item.id)).size, 3, 'three different wordings');
  assert.equal(retryQuestion(fix, cardId, d), null, 'no fourth try');
  assert.deepEqual(cardsStillWrong(fix, grades), [cardId]);
  // Right on the third try: nothing left to fix.
  grades.set(3, rightGrade);
  assert.deepEqual(cardsStillWrong(fix, grades), []);
});

test('practising mistakes is not a score: no course average, and the scope is known', () => {
  const d = data();
  const [i] = d.items.filter((x) => x.chapter_id === 'SCM-H3');
  const runId = '1b2c3d4e-0000-4000-8000-000000000000';
  d.attempts = [attempt(i, 'fix-run', `fouten:${runId}`, true, '2026-10-29')];
  assert.deepEqual(parseScope(`fouten:${runId}`), { kind: 'fouten', id: runId });
  assert.equal(runScores(d)[0].course_id, null);
  assert.equal(courseQuizList(d).find((c) => c.course.id === 'SCM')!.runs, 0);
});
