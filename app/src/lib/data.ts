/**
 * The one door the screens use: read everything, write what he does.
 *
 *   loadSnapshot(store)   every table from the phone, in one object, plus
 *                         today's study day and the defaults. Instant: no
 *                         network involved.
 *   queueInput / quizData the snapshot in the shape queue.ts and quiz.ts want
 *   Actions               every write the app makes. Each one saves on the
 *                         phone first (the screen can move on at once), then
 *                         queues the row for the server (store.ts outbox).
 *
 * The rules themselves stay in leitner.ts, queue.ts, quiz.ts and
 * instruments.ts; this file only connects them to the store.
 */

import type {
  Card,
  CardFlag,
  CardMark,
  Chapter,
  Course,
  Day,
  DayPlan,
  Defaults,
  Exam,
  FlagReason,
  Instrument,
  InstrumentReview,
  InstrumentScore,
  PipelineStatus,
  Quiz,
  QuizAttempt,
  QuizItem,
  Review,
  Setting,
  Slide,
  StudySession,
} from './model.ts';
import { readDefaults } from './model.ts';
import type { Store } from './store.ts';
import { studyDay } from './dates.ts';
import { reviewRow, undoRow } from './leitner.ts';
import type { QueueInput, SessionAnswer } from './queue.ts';
import {
  attemptRow,
  gradeAnswer,
  summarizeRun,
  type Grade,
  type QuizAnswer,
  type QuizData,
  type QuizQuestion,
  type QuizRun,
  type RunResult,
} from './quiz.ts';
import { instrumentReviewRow } from './instruments.ts';

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface Snapshot {
  /** The study day (Brussels, 04:00 rollover) the snapshot was taken on. */
  today: Day;
  defaults: Defaults;
  courses: Course[];
  chapters: Chapter[];
  sessions: StudySession[];
  quizzes: Quiz[];
  exams: Exam[];
  slides: Slide[];
  cards: Card[];
  items: QuizItem[];
  dayPlans: DayPlan[];
  instruments: Instrument[];
  settings: Setting[];
  pipeline: PipelineStatus | null;
  marks: CardMark[];
  reviews: Review[];
  attempts: QuizAttempt[];
  flags: CardFlag[];
  instrumentReviews: InstrumentReview[];
}

const bySort = <T extends { sort: number; id: string }>(a: T, b: T) => a.sort - b.sort || a.id.localeCompare(b.id);

/** Everything on the phone, sorted the way the screens show it. */
export async function loadSnapshot(store: Store, now: Date = new Date()): Promise<Snapshot> {
  const [
    courses, chapters, sessions, quizzes, exams, slides, cards, items, dayPlans, instruments,
    settings, pipeline, marks, reviews, attempts, flags, instrumentReviews,
  ] = await Promise.all([
    store.all('courses'),
    store.all('chapters'),
    store.all('study_sessions'),
    store.all('quizzes'),
    store.all('exams'),
    store.all('slides'),
    store.all('cards'),
    store.all('quiz_items'),
    store.all('day_plan'),
    store.all('instruments'),
    store.all('settings'),
    store.all('pipeline_status'),
    store.all('card_marks'),
    store.all('reviews'),
    store.all('quiz_attempts'),
    store.all('card_flags'),
    store.all('instrument_reviews'),
  ]);
  return {
    today: studyDay(now),
    defaults: readDefaults(settings),
    courses: courses.sort(bySort),
    chapters: chapters.sort(bySort),
    sessions: sessions.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    quizzes: quizzes.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    exams: exams.sort((a, b) => a.day.localeCompare(b.day)),
    slides,
    cards: cards.sort((a, b) => a.chapter_id.localeCompare(b.chapter_id) || a.sort - b.sort || a.id.localeCompare(b.id)),
    items,
    dayPlans,
    instruments,
    settings,
    pipeline: pipeline[0] ?? null,
    marks,
    reviews,
    attempts,
    flags,
    instrumentReviews,
  };
}

export function queueInput(s: Snapshot): QueueInput {
  return {
    today: s.today,
    cards: s.cards,
    reviews: s.reviews,
    courses: s.courses,
    chapters: s.chapters,
    exams: s.exams,
    dayPlans: s.dayPlans,
    defaults: s.defaults,
  };
}

export function quizData(s: Snapshot): QuizData {
  return {
    courses: s.courses,
    chapters: s.chapters,
    cards: s.cards,
    items: s.items,
    quizzes: s.quizzes,
    sessions: s.sessions,
    attempts: s.attempts,
  };
}

/** Cards he marked ☆ "moeilijk". */
export function starredIds(s: Pick<Snapshot, 'marks'>): Set<string> {
  return new Set(s.marks.filter((m) => m.starred).map((m) => m.card_id));
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export interface ActionHooks {
  /** Called after every rating (sync.ts Syncer.noteRating: every 10th flushes). */
  onRating?: () => void;
  /** Called after any write, e.g. to flush at the end of a quiz. */
  onWrite?: () => void;
  now?: () => Date;
}

export class Actions {
  private store: Store;
  private hooks: ActionHooks;

  constructor(store: Store, hooks: ActionHooks = {}) {
    this.store = store;
    this.hooks = hooks;
  }

  private now(): Date {
    return this.hooks.now ? this.hooks.now() : new Date();
  }

  /**
   * One answer in a review session. `mode` comes from ReviewSession.current
   * ('sessie' on the first pass, 'herhaling' on a repeat, which changes no box).
   * "Gekend" after a hint is logged as 'hint' (it stays in its box).
   */
  async rate(
    cardId: string,
    answer: SessionAnswer,
    mode: 'sessie' | 'herhaling',
    hintsUsed = 0,
    ms: number | null = null,
  ): Promise<Review> {
    const result = answer === 'gekend' && hintsUsed > 0 ? 'hint' : answer;
    const row = reviewRow({ card_id: cardId, result, mode, hints_used: hintsUsed, ms }, this.now());
    await this.store.write('reviews', row);
    this.hooks.onRating?.();
    this.hooks.onWrite?.();
    return row;
  }

  /** "Ongedaan maken": a row that cancels the given one. */
  async undo(target: Review): Promise<Review> {
    const row = undoRow(target, this.now());
    await this.store.write('reviews', row);
    this.hooks.onWrite?.();
    return row;
  }

  /** "Opnieuw leren" from the card preview: back to Doos 1. */
  async relearn(cardId: string): Promise<Review> {
    const row = reviewRow({ card_id: cardId, result: 'opnieuw', mode: 'handmatig' }, this.now());
    await this.store.write('reviews', row);
    this.hooks.onWrite?.();
    return row;
  }

  /** Cards already sent back tomorrow, per quiz run (one quiz_fout row per card and run). */
  private sentBack = new Map<string, Set<string>>();

  /** Write the quiz_fout row for a card once per run. */
  private async sendBack(runId: string, cardId: string, now: Date): Promise<void> {
    let done = this.sentBack.get(runId);
    if (!done) this.sentBack.set(runId, (done = new Set()));
    if (done.has(cardId)) return;
    done.add(cardId);
    await this.store.write('reviews', reviewRow({ card_id: cardId, result: 'quiz_fout', mode: 'quiz' }, now));
  }

  /**
   * One quiz answer: graded, logged, and returned for the feedback panel.
   *
   * A wrong answer sends its card back tomorrow at once (a quiz_fout row; the
   * box does not move). Not only at the end of the run: iOS may close the app
   * halfway, or an update may reload it, and the mistake must still count.
   */
  async answerQuiz(
    run: QuizRun,
    question: QuizQuestion,
    answer: QuizAnswer,
    hintUsed = false,
  ): Promise<{ grade: Grade; attempt: QuizAttempt }> {
    const grade = gradeAnswer(question, answer);
    const now = this.now();
    const attempt = attemptRow(run, question, answer, grade, hintUsed, now);
    await this.store.write('quiz_attempts', attempt);
    if (!grade.correct) await this.sendBack(run.run_id, question.item.card_id, now);
    this.hooks.onWrite?.();
    return { grade, attempt };
  }

  /**
   * The end of a run (or closing it halfway): the score for the end screen.
   * Every card with a wrong answer comes back tomorrow; answerQuiz already
   * wrote those rows, so this only fills a gap and never writes one twice.
   */
  async finishQuiz(run: QuizRun, grades: ReadonlyMap<number, Grade>): Promise<RunResult> {
    const result = summarizeRun(run, grades);
    const now = this.now();
    for (const cardId of result.backTomorrow) await this.sendBack(run.run_id, cardId, now);
    this.hooks.onWrite?.();
    return result;
  }

  /** "Meld een probleem". */
  async flag(cardId: string, reason: FlagReason, note: string | null = null): Promise<CardFlag> {
    const row: CardFlag = {
      id: crypto.randomUUID(),
      card_id: cardId,
      reason,
      note: note?.trim() ? note.trim().slice(0, 500) : null,
      created_at: this.now().toISOString(),
      resolved_at: null,
      resolution: null,
    };
    await this.store.write('card_flags', row);
    this.hooks.onWrite?.();
    return row;
  }

  /** The ☆ on a card ("moeilijk"). */
  async star(cardId: string, starred: boolean): Promise<CardMark> {
    const row: CardMark = { card_id: cardId, starred, updated_at: this.now().toISOString() };
    await this.store.write('card_marks', row);
    this.hooks.onWrite?.();
    return row;
  }

  /** "Gedaan" on an instrument: Alles juist / Bijna / Veel fout. */
  async scoreInstrument(instrumentId: string, score: InstrumentScore): Promise<InstrumentReview> {
    const now = this.now();
    const row = instrumentReviewRow(instrumentId, score, studyDay(now), now);
    await this.store.write('instrument_reviews', row);
    this.hooks.onWrite?.();
    return row;
  }
}
