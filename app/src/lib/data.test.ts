/**
 * The door the screens use (data.ts), driven over the demo data: reading,
 * rating, undo, quizzes, flags, stars and instruments, all local first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDriver, Store } from './store.ts';
import { Actions, loadSnapshot, queueInput, quizData, starredIds } from './data.ts';
import { buildQueue } from './queue.ts';
import { buildRun, homeQuizSuggestion, chapterQuizList, sessionQuizList, type Grade } from './quiz.ts';
import { foldCard } from './leitner.ts';
import { buildDemo, seedDemo } from '../demo/data.ts';
import { dueInstruments } from './instruments.ts';
import { seeded } from './testkit.ts';

const NOW = new Date('2026-10-26T19:30:00Z'); // Monday evening, 20:30 in Brussels

async function demoStore() {
  const store = new Store(new MemoryDriver());
  await seedDemo(store, NOW);
  return store;
}

test('the demo: all 6 courses incl. BE, ~30 cards, visuals, an open session quiz, a finished chapter', () => {
  const d = buildDemo(NOW);
  assert.deepEqual(d.courses.map((c) => c.id), ['SCM', 'BR', 'OR', 'FB', 'IFHT', 'BE']);
  assert.ok(d.cards.length >= 24 && d.cards.length <= 36);
  assert.ok(d.cards.filter((c) => c.answer.visual || c.front.visual).length >= 3);
  assert.equal(d.quiz_items.filter((i) => i.course_id === 'BE').length, 0, 'Business English has no quiz items');
  assert.equal(d.quizzes.length, 1);
  assert.ok(d.quizzes[0].item_ids.length >= 8 && d.quizzes[0].item_ids.length <= 10);
  assert.ok(d.chapters.some((c) => c.status === 'af'));
  assert.equal(d.day_plan[0].day, '2026-10-26');
  for (const c of d.cards) assert.equal(c.hints.length, 3);
  for (const i of d.quiz_items.filter((i) => i.format === 'mcq')) {
    assert.equal(i.options?.length, 4);
    assert.equal(i.options?.filter((o) => o.correct).length, 1);
  }
  for (const i of d.quiz_items.filter((i) => i.format === 'cloze')) assert.match(i.stem, /____/);
  // Fixed ids: two loads give the same data.
  assert.deepEqual(buildDemo(NOW).cards.map((c) => c.id), d.cards.map((c) => c.id));
});

test('seeding the demo queues nothing for the server', async () => {
  const store = await demoStore();
  assert.equal(await store.pendingCount(), 0);
});

test('snapshot → today\'s queue and the quiz lists work on the demo', async () => {
  const s = await loadSnapshot(await demoStore(), NOW);
  assert.equal(s.today, '2026-10-26');
  const queue = buildQueue(queueInput(s));
  assert.ok(queue.total > 0, 'something to review today');
  assert.deepEqual(queue.courseChips.slice(0, 2), ['SCM', 'FB'], 'day plan order first');
  assert.equal(queue.plan.reason, 'Eerst SCM: toets binnen drie weken');

  const data = quizData(s);
  const suggestion = homeQuizSuggestion(data);
  assert.equal(suggestion?.kind, 'sessie');
  assert.equal(suggestion?.label, 'Nieuwe quiz · SCM H3 · dia 12–26');
  assert.equal(sessionQuizList(data)[0].done, false);
  assert.equal(chapterQuizList(data).find((c) => c.chapter.id === 'SCM-H2')?.finished, true);
  assert.equal(chapterQuizList(data).some((c) => c.chapter.course_id === 'BE'), false);
  assert.equal(buildRun({ kind: 'vak', id: 'BE' }, data), null);
  assert.equal(starredIds(s).size, 1);
  assert.equal(dueInstruments(s.instruments, s.instrumentReviews, s.today).length, 1);
});

test('rate: saved locally, queued, and the queue moves on', async () => {
  const store = await demoStore();
  let ratings = 0;
  const actions = new Actions(store, { onRating: () => ratings++, now: () => NOW });
  const before = buildQueue(queueInput(await loadSnapshot(store, NOW)));
  const first = before.remaining[0];
  const row = await actions.rate(first.card.id, 'gekend', 'sessie', 0, 8000);
  assert.equal(row.result, 'gekend');
  assert.equal(row.day, '2026-10-26');
  assert.equal(ratings, 1);
  assert.equal(await store.pendingCount(), 1);
  const after = buildQueue(queueInput(await loadSnapshot(store, NOW)));
  assert.equal(after.doneCount, before.doneCount + 1);
});

test('"Gekend" after a hint is logged as hint and keeps the box', async () => {
  const store = await demoStore();
  const actions = new Actions(store, { now: () => NOW });
  const s = await loadSnapshot(store, NOW);
  const target = buildQueue(queueInput(s)).remaining.find((i) => i.state.box >= 1)!;
  const row = await actions.rate(target.card.id, 'gekend', 'sessie', 2);
  assert.equal(row.result, 'hint');
  assert.equal(row.hints_used, 2);
  const state = foldCard(target.card.id, (await loadSnapshot(store, NOW)).reviews);
  assert.equal(state.box, target.state.box);
});

test('undo cancels exactly the answer it points at', async () => {
  const store = await demoStore();
  const actions = new Actions(store, { now: () => NOW });
  const s = await loadSnapshot(store, NOW);
  const target = buildQueue(queueInput(s)).remaining[0];
  const rated = await actions.rate(target.card.id, 'niet', 'sessie');
  await actions.undo(rated);
  const state = foldCard(target.card.id, (await loadSnapshot(store, NOW)).reviews);
  assert.equal(state.box, target.state.box);
  assert.equal(await store.pendingCount(), 2, 'both rows go to the server');
});

test('Opnieuw leren puts a card back in Doos 1', async () => {
  const store = await demoStore();
  const actions = new Actions(store, { now: () => NOW });
  const s = await loadSnapshot(store, NOW);
  const card = s.cards.find((c) => foldCard(c.id, s.reviews).box >= 2)!;
  const row = await actions.relearn(card.id);
  assert.equal(row.mode, 'handmatig');
  assert.equal(foldCard(card.id, (await loadSnapshot(store, NOW)).reviews).box, 1);
});

test('a quiz run: answers logged with the scope, wrong cards come back tomorrow', async () => {
  const store = await demoStore();
  const actions = new Actions(store, { now: () => NOW });
  const s = await loadSnapshot(store, NOW);
  const run = buildRun({ kind: 'sessie', id: s.quizzes[0].id }, quizData(s), { rng: seeded(3) })!;
  assert.ok(run.questions.length >= 8);
  const grades = new Map<number, Grade>();
  for (const q of run.questions) {
    // Right on odd questions, a wrong option or a wrong text on even ones.
    const answer = q.options
      ? { option: q.options.findIndex((o) => (q.n % 2 === 1 ? o.correct : !o.correct)) }
      : { text: q.n % 2 === 1 ? String((q.item.answer as { accept?: string[]; value?: number }).accept?.[0] ?? (q.item.answer as { value: number }).value) : 'zzz' };
    const { grade, attempt } = await actions.answerQuiz(run, q, answer);
    assert.equal(attempt.scope, `sessie:${s.quizzes[0].id}`);
    grades.set(q.n, grade);
  }
  const result = await actions.finishQuiz(run, grades);
  assert.ok(result.correct > 0 && result.correct < run.questions.length);
  const after = await loadSnapshot(store, NOW);
  const back = after.reviews.filter((r) => r.result === 'quiz_fout');
  assert.equal(back.length, result.backTomorrow.length);
  for (const r of back) {
    assert.equal(r.mode, 'quiz');
    assert.equal(foldCard(r.card_id, after.reviews).due, '2026-10-27');
  }
  // The session quiz counts as done now.
  assert.equal(sessionQuizList(quizData(after))[0].done, true);
});

test('a wrong quiz answer sends its card back tomorrow at once, without waiting for the end', async () => {
  const store = await demoStore();
  const actions = new Actions(store, { now: () => NOW });
  const s = await loadSnapshot(store, NOW);
  const run = buildRun({ kind: 'sessie', id: s.quizzes[0].id }, quizData(s), { rng: seeded(5) })!;
  const q = run.questions.find((x) => x.options)!;
  const wrong = { option: q.options!.findIndex((o) => !o.correct) };
  const { grade } = await actions.answerQuiz(run, q, wrong);
  assert.equal(grade.correct, false);
  // The app is closed here (iOS, or an update reload): the mistake already counts.
  let after = await loadSnapshot(store, NOW);
  const rows = after.reviews.filter((r) => r.result === 'quiz_fout');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].card_id, q.item.card_id);
  assert.equal(foldCard(q.item.card_id, after.reviews).due, '2026-10-27');
  // Finishing (or closing) the run later never writes it twice.
  await actions.finishQuiz(run, new Map([[q.n, grade]]));
  after = await loadSnapshot(store, NOW);
  assert.equal(after.reviews.filter((r) => r.result === 'quiz_fout').length, 1);
  // A right answer writes nothing to the reviews log.
  const q2 = run.questions.find((x) => x.options && x.n !== q.n)!;
  await actions.answerQuiz(run, q2, { option: q2.options!.findIndex((o) => o.correct) });
  after = await loadSnapshot(store, NOW);
  assert.equal(after.reviews.filter((r) => r.result === 'quiz_fout').length, 1);
});

test('flag, star and instrument score are saved locally and queued', async () => {
  const store = await demoStore();
  const actions = new Actions(store, { now: () => NOW });
  const s = await loadSnapshot(store, NOW);
  const flag = await actions.flag(s.cards[0].id, 'onduidelijk', '  te vaag  ');
  assert.equal(flag.note, 'te vaag');
  await actions.star(s.cards[1].id, true);
  await actions.scoreInstrument(s.instruments[0].id, 'bijna');
  const after = await loadSnapshot(store, NOW);
  assert.equal(after.flags.length, 1);
  assert.equal(starredIds(after).has(s.cards[1].id), true);
  assert.equal(after.instrumentReviews.length, s.instrumentReviews.length + 1);
  assert.equal(await store.pendingCount(), 3);
});
