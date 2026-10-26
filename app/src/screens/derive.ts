/**
 * What every screen works out from the snapshot, worked out once per draw:
 * lookups by id, every card's box right now, today's queue and the quiz data.
 */

import type { Card, Chapter, Course, Slide } from '../lib/model.ts';
import type { Snapshot } from '../lib/data.ts';
import { queueInput, quizData, starredIds } from '../lib/data.ts';
import type { CardState } from '../lib/leitner.ts';
import { buildQueue, type TodayQueue } from '../lib/queue.ts';
import type { QuizData } from '../lib/quiz.ts';
import { currentStates, knownShare } from '../lib/stats.ts';

export interface Derived {
  courses: Map<string, Course>;
  chapters: Map<string, Chapter>;
  slides: Map<string, Slide>;
  /** Live cards only (needs_check and retired never show). */
  live: Card[];
  cardById: Map<string, Card>;
  byCourse: Map<string, Card[]>;
  byChapter: Map<string, Card[]>;
  /** Every live card's box right now, today's answers included. */
  states: Map<string, CardState>;
  starred: Set<string>;
  queue: TodayQueue;
  qdata: QuizData;
}

export function derive(s: Snapshot): Derived {
  const live = s.cards.filter((c) => c.status === 'live');
  const byCourse = new Map<string, Card[]>();
  const byChapter = new Map<string, Card[]>();
  for (const c of live) {
    let a = byCourse.get(c.course_id);
    if (!a) byCourse.set(c.course_id, (a = []));
    a.push(c);
    let b = byChapter.get(c.chapter_id);
    if (!b) byChapter.set(c.chapter_id, (b = []));
    b.push(c);
  }
  return {
    courses: new Map(s.courses.map((c) => [c.id, c])),
    chapters: new Map(s.chapters.map((c) => [c.id, c])),
    slides: new Map(s.slides.map((sl) => [sl.key, sl])),
    live,
    cardById: new Map(s.cards.map((c) => [c.id, c])),
    byCourse,
    byChapter,
    states: currentStates(s.cards, s.reviews, s.defaults.wait_days),
    starred: starredIds(s),
    queue: buildQueue(queueInput(s)),
    qdata: quizData(s),
  };
}

/** The % for a course or chapter: share of its cards he knew last time (Doos 2+). */
export function shareOf(d: Derived, cards: readonly Card[] | undefined): number | null {
  return knownShare((cards ?? []).map((c) => c.id), d.states);
}

/** Chapters of a course that hold live cards or are known, in order. */
export function chaptersOf(s: Snapshot, courseId: string): Chapter[] {
  return s.chapters.filter((c) => c.course_id === courseId);
}

/** 'SCM H3' for a chapter. */
export function chapterCode(ch: Chapter | undefined): string {
  return ch ? `${ch.course_id} ${ch.code}` : '';
}
