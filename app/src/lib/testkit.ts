/**
 * Small factories for the tests. Not part of the app (nothing imports it
 * outside *.test.ts, so esbuild never bundles it).
 */

import type {
  Card,
  Chapter,
  Course,
  DayPlan,
  Exam,
  QuizAttempt,
  QuizItem,
  Review,
  ReviewMode,
  ReviewResult,
} from './model.ts';
import { DEFAULTS } from './model.ts';

export const T0 = '2026-09-01T10:00:00.000Z';

export const COURSES: Course[] = [
  { id: 'SCM', name: 'Supply Chain Management', color: '#2F6FEB', icon: 'truck', sort: 1, updated_at: T0 },
  { id: 'BR', name: 'Burgerlijk recht', color: '#D93F3F', icon: 'scales', sort: 2, updated_at: T0 },
  { id: 'OR', name: 'Ondernemingsrecht', color: '#8250DF', icon: 'building', sort: 3, updated_at: T0 },
  { id: 'FB', name: 'Financieel beheer', color: '#1F9D55', icon: 'calculator', sort: 4, updated_at: T0 },
  { id: 'IFHT', name: 'IFHT', color: '#E8730C', icon: 'globe', sort: 5, updated_at: T0 },
  { id: 'BE', name: 'Business English 1', color: '#0F9AA8', icon: 'speech', sort: 6, updated_at: T0 },
];

export function chapter(id: string, sort = 1, status: Chapter['status'] = 'bezig'): Chapter {
  const [course, code] = id.split('-');
  return {
    id, course_id: course, code, title: `${course} ${code}`, sort, notion_page_id: null,
    slide_numbering: 'position', status, updated_at: T0,
  };
}

let cardNo = 0;

export function card(chapterId: string, extra: Partial<Card> = {}): Card {
  cardNo++;
  const course = chapterId.split('-')[0];
  return {
    id: extra.id ?? `c${String(cardNo).padStart(4, '0')}-0000-4000-8000-000000000000`,
    course_id: course,
    chapter_id: chapterId,
    type: 'begrip',
    front: { text: `Vraag ${cardNo}` },
    answer: { core: `**Antwoord** ${cardNo}` },
    hints: ['h1', 'h2', 'h3'],
    source: { label: `${course} · dia ${cardNo}` },
    exam_value: 2,
    sibling_group: null,
    sort: cardNo,
    legacy_notion_id: null,
    notion_inbox_id: null,
    status: 'live',
    version: 1,
    created_at: T0,
    updated_at: T0,
    ...extra,
  };
}

let reviewNo = 0;

export function review(
  cardId: string,
  day: string,
  result: ReviewResult,
  extra: Partial<Review> = {},
): Review {
  reviewNo++;
  return {
    id: extra.id ?? `r${String(reviewNo).padStart(7, '0')}-0000-4000-8000-000000000000`,
    card_id: cardId,
    reviewed_at: extra.reviewed_at ?? `${day}T19:${String(Math.floor(reviewNo / 60) % 60).padStart(2, '0')}:${String(reviewNo % 60).padStart(2, '0')}.000Z`,
    day,
    result,
    hints_used: 0,
    mode: 'sessie' as ReviewMode,
    undoes: null,
    ms: 8000,
    ...extra,
  };
}

/** Rows that put a card in `box` with its due day on `due`. */
export function inBox(cardId: string, box: number, due: string): Review[] {
  const waits = DEFAULTS.wait_days;
  // The last review happened wait(box) days before `due`.
  const lastDay = new Date(Date.parse(due + 'T00:00:00Z') - waits[box - 1] * 86_400_000).toISOString().slice(0, 10);
  const rows: Review[] = [];
  if (box === 1) return [review(cardId, lastDay, 'niet')];
  // new -> 2 with one gekend, then one gekend per box; all on earlier days.
  const steps = box - 1; // number of gekend rows needed
  for (let i = steps - 1; i >= 1; i--) {
    const d = new Date(Date.parse(lastDay + 'T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10);
    rows.push(review(cardId, d, 'gekend'));
  }
  rows.push(review(cardId, lastDay, 'gekend'));
  return rows;
}

export function plan(day: string, order: string[], extra: Partial<DayPlan> = {}): DayPlan {
  return { day, course_order: order, reason: null, cap: null, new_max: null, reminder_at: '21:00', source: 'notion', updated_at: T0, ...extra };
}

export function exam(courseId: string | null, day: string, chapterIds: string[] = [], kind: Exam['kind'] = 'toets'): Exam {
  return { id: `e-${courseId}-${day}`, course_id: courseId, kind, day, end_day: null, chapter_ids: chapterIds, title: 'Toets', updated_at: T0 };
}

let itemNo = 0;

export function item(c: Card, format: QuizItem['format'], extra: Partial<QuizItem> = {}): QuizItem {
  itemNo++;
  const base: QuizItem = {
    id: extra.id ?? `i${String(itemNo).padStart(7, '0')}-0000-4000-8000-000000000000`,
    card_id: c.id,
    course_id: c.course_id,
    chapter_id: c.chapter_id,
    format,
    stem: format === 'cloze' ? 'De ____ voorraad' : `Vraag bij ${c.id}`,
    options: null,
    answer: null,
    hint: 'Denk aan …',
    explanation: 'Omdat …',
    source_label: c.source.label,
    status: 'live',
    created_at: T0,
    updated_at: T0,
  };
  if (format === 'mcq') {
    base.options = [
      { text: 'Juist antwoord', correct: true, why: 'Dit klopt.' },
      { text: 'Fout B', correct: false, why: 'Niet B.' },
      { text: 'Fout C', correct: false, why: 'Niet C.' },
      { text: 'Fout D', correct: false, why: 'Niet D.' },
    ];
  } else if (format === 'tf') {
    base.options = [
      { text: 'Juist', correct: false, why: 'Het is fout.' },
      { text: 'Fout', correct: true, why: 'Want …' },
    ];
    base.answer = { correction: 'Zo is het wel.' };
  } else if (format === 'cloze') {
    base.answer = { accept: ['economische', 'economische voorraad'] };
  } else {
    base.answer = { value: 2020, unit: 'stuks', tolerance: 0.5, steps: [] };
  }
  return { ...base, ...extra };
}

export function attempt(i: QuizItem, runId: string, scope: string, correct: boolean, day: string, n = 0): QuizAttempt {
  return {
    id: `${runId.slice(0, 8)}-${i.id.slice(0, 8)}-4000-8000-${String(n).padStart(12, '0')}`,
    run_id: runId,
    item_id: i.id,
    card_id: i.card_id,
    scope,
    correct,
    answer: null,
    hint_used: false,
    answered_at: `${day}T18:00:${String(n % 60).padStart(2, '0')}.000Z`,
    day,
  };
}

/** A seeded random generator, so sampling tests are repeatable. */
export function seeded(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
