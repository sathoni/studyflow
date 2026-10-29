/**
 * Today's queue (SPEC-v3 §3, "Today's queue") and the session that works through it.
 *
 * The queue is built from each card's state *at the start of the study day*
 * (reviews from earlier days only). That one choice keeps it steady while he
 * works: a card he just answered stays in today's list, ticked off, instead of
 * vanishing and letting a rolled-over card slip in behind his back. Progress
 * is then simply "ticked off / in the list".
 *
 * Two lists a day (his wish, 29/10): the morning one at 7:00 holds the cards
 * whose day has come, the evening one (until he goes to bed, at the latest the
 * 04:00 rollover) the new cards, what he studied today first.
 *
 *   1. Course order: the day_plan row first, then the other courses by most overdue.
 *   2. Morning: due cards (due <= today), course order, lowest box, oldest due,
 *      up to day_plan.cap (default 20, Sunday 30); the rest rolls over, silently.
 *   3. Evening: every new card of today's and yesterday's lessons and self-studies,
 *      always; then other new cards up to day_plan.new_max in all (default 10,
 *      Sunday 5): quiz-flagged, near test, the plan's courses taking turns, the
 *      rest; within a course the most recent study first, split cards together.
 *   4. Extra practice (a chapter or course round, "Nog een ronde") is logged as
 *      mode 'extra'. It never takes a place in these lists, and a card done that
 *      way is not asked again the same day.
 *   5. Estimate: 15 s a review, 30 s a new card, his own medians after 14 days.
 *
 * Failed cards come back at the end of the session as "herhaling", at most
 * twice, and those tries never move a box (leitner.ts skips them).
 */

import type { Card, Chapter, Course, Day, DayPlan, Defaults, Exam, Review, StudySession } from './model.ts';
import { type CardState, compareRows, foldAll, undoneIds } from './leitner.ts';
import { addDays, daysBetween, instant, isDay, isSunday } from './dates.ts';

/** Herhaling tries after a "Niet gekend" in the same session. */
export const MAX_REPEATS = 2;

/** A test this close (in days) puts its chapters' new cards first. */
export const NEAR_EXAM_DAYS = 10;

/* ------------------------------------------------------------------ *
 * Inputs and outputs
 * ------------------------------------------------------------------ */

export interface QueueInput {
  today: string;
  cards: readonly Card[];
  reviews: readonly Review[];
  courses: readonly Course[];
  chapters: readonly Chapter[];
  exams: readonly Exam[];
  dayPlans: readonly DayPlan[];
  defaults: Defaults;
  /** Lessons and self-studies: their cards of today and yesterday always go in the evening list. */
  sessions?: readonly StudySession[];
}

export interface DayPlanResolved {
  day: string;
  cap: number;
  newMax: number;
  /** All courses, in today's order (plan first, then most overdue). */
  courseOrder: string[];
  /** "Eerst FB en OR: maandag les", or null without a plan row. */
  reason: string | null;
  /** Whether a day_plan row existed for the day. */
  fromPlan: boolean;
}

export interface QueueItem {
  card: Card;
  /** The card's state at the start of the day. */
  state: CardState;
  kind: 'review' | 'new';
  /** Already answered today in a session. */
  done: boolean;
}

/** A card owed a herhaling; `attempt` is the try it is on (1 or 2). */
export interface RepeatItem {
  item: QueueItem;
  attempt: number;
}

export interface Timing {
  reviewSec: number;
  newSec: number;
  source: 'default' | 'personal';
}

/** One of the day's two lists: 'review' in the morning, 'new' in the evening. */
export interface QueuePart {
  items: QueueItem[];
  remaining: QueueItem[];
  repeats: RepeatItem[];
  doneCount: number;
  /** 0..1 */
  progress: number;
  remainingSec: number;
  courseChips: string[];
}

export interface TodayQueue {
  day: string;
  plan: DayPlanResolved;
  /** The whole day, in order (the evening's new cards, then the morning's), done items included. */
  items: QueueItem[];
  /** The same items split in the two lists. */
  parts: { review: QueuePart; new: QueuePart };
  /** Not answered yet, in order. */
  remaining: QueueItem[];
  /** Failed today and still owed a herhaling (they go after `remaining`). */
  repeats: RepeatItem[];
  total: number;
  doneCount: number;
  /** 0..1, for the ring on Home. */
  progress: number;
  /** Due cards above the cap, rolled over to tomorrow without a word. */
  rolledOver: number;
  timing: Timing;
  /** Seconds left for `remaining` (repeats not counted). */
  remainingSec: number;
  /** Seconds for the whole day's list. */
  totalSec: number;
  /** Courses with cards in the list, in today's order (the chips on the hero card). */
  courseChips: string[];
}

/* ------------------------------------------------------------------ *
 * The plan for a day
 * ------------------------------------------------------------------ */

/** cap / new_max / reason for a day, from its day_plan row or the defaults. */
export function planFor(
  day: string,
  dayPlans: readonly DayPlan[],
  defaults: Defaults,
): Omit<DayPlanResolved, 'courseOrder'> & { planOrder: string[] } {
  const row = dayPlans.find((p) => p.day === day) ?? null;
  const sunday = isSunday(day);
  return {
    day,
    cap: row?.cap ?? (sunday ? defaults.cap_sunday : defaults.cap),
    newMax: row?.new_max ?? (sunday ? defaults.new_max_sunday : defaults.new_max),
    reason: row?.reason ?? null,
    fromPlan: row !== null,
    planOrder: row?.course_order ?? [],
  };
}

/**
 * All courses in today's order: the plan's courses first, as listed, then the
 * rest by how overdue their most overdue card is, then by the usual course order.
 */
export function courseOrder(
  planOrder: readonly string[],
  courses: readonly Course[],
  dueStates: Iterable<{ courseId: string; due: string }>,
  today: string,
): string[] {
  const known = new Set(courses.map((c) => c.id));
  const first: string[] = [];
  for (const id of planOrder) if (known.has(id) && !first.includes(id)) first.push(id);

  const overdue = new Map<string, number>();
  for (const { courseId, due } of dueStates) {
    const d = daysBetween(due, today);
    overdue.set(courseId, Math.max(overdue.get(courseId) ?? -1, d));
  }
  const rest = [...courses]
    .filter((c) => !first.includes(c.id))
    .sort(
      (a, b) =>
        (overdue.get(b.id) ?? -Infinity) - (overdue.get(a.id) ?? -Infinity) ||
        a.sort - b.sort ||
        a.id.localeCompare(b.id),
    )
    .map((c) => c.id);
  return [...first, ...rest];
}

/** Days until the nearest test covering this card, or Infinity beyond the horizon. */
export function nearestExamDays(
  card: Pick<Card, 'course_id' | 'chapter_id'>,
  exams: readonly Exam[],
  today: string,
  horizon: number = NEAR_EXAM_DAYS,
): number {
  let best = Infinity;
  for (const exam of exams) {
    if (exam.kind === 'opdracht') continue;
    if (exam.course_id !== null && exam.course_id !== card.course_id) continue;
    if (exam.chapter_ids.length > 0 && !exam.chapter_ids.includes(card.chapter_id)) continue;
    if ((exam.end_day ?? exam.day) < today) continue;
    const days = Math.max(0, daysBetween(today, exam.day));
    if (days <= horizon && days < best) best = days;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Building the queue
 * ------------------------------------------------------------------ */

/**
 * Cards answered today, not undone: in today's lists (mode 'sessie') or, with
 * `scope` 'any', also as extra practice (mode 'extra'). A card answered either
 * way is never asked again the same day.
 */
export function answeredToday(reviews: readonly Review[], today: string, scope: 'any' | 'list' = 'any'): Set<string> {
  const undone = undoneIds(reviews);
  const out = new Set<string>();
  for (const r of reviews) {
    if (r.day !== today || r.result === 'undo' || undone.has(r.id)) continue;
    if (r.mode === 'sessie' || (scope === 'any' && r.mode === 'extra')) out.add(r.card_id);
  }
  return out;
}

/** The study day in a lesson or self-study key ('BR-D2:2026-10-29:1-17'); null for imports. */
export function sessionDay(session: Pick<StudySession, 'session_key' | 'kind'>): Day | null {
  if (session.kind === 'import') return null;
  const day = session.session_key.split(':')[1];
  return isDay(day) ? day : null;
}

/** Card id -> the most recent study day of a lesson or self-study holding it. */
export function studiedOn(sessions: readonly StudySession[]): Map<string, Day> {
  const out = new Map<string, Day>();
  for (const s of sessions) {
    const day = sessionDay(s);
    if (day === null) continue;
    for (const id of s.card_ids) if ((out.get(id) ?? '') < day) out.set(id, day);
  }
  return out;
}

/**
 * Cards still owed a herhaling today: the last session answer today was
 * "Niet gekend", no herhaling since then was right, and fewer than two tries
 * have been made. Lets a session closed halfway pick up where it stopped.
 * Maps card id -> the try it is on next (1 or 2).
 */
export function owedRepeats(reviews: readonly Review[], today: string): Map<string, number> {
  const undone = undoneIds(reviews);
  const byCard = new Map<string, Review[]>();
  for (const r of reviews) {
    if (r.day !== today || r.result === 'undo' || undone.has(r.id)) continue;
    if (r.mode !== 'sessie' && r.mode !== 'herhaling' && r.mode !== 'extra') continue;
    let list = byCard.get(r.card_id);
    if (!list) byCard.set(r.card_id, (list = []));
    list.push(r);
  }
  const owed = new Map<string, number>();
  for (const [cardId, rows] of byCard) {
    rows.sort(compareRows);
    let lastFail = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].mode === 'sessie') lastFail = rows[i].result === 'niet' ? i : -1;
    }
    if (lastFail < 0) continue;
    // A right answer as extra practice afterwards also settles it.
    const after = rows.slice(lastFail + 1);
    const tries = after.filter((r) => r.mode === 'herhaling');
    const right = after.some((r) => r.result === 'gekend' || r.result === 'hint');
    if (!right && tries.length < MAX_REPEATS) owed.set(cardId, tries.length + 1);
  }
  return owed;
}

interface Ranked {
  card: Card;
  state: CardState;
  rank: number;
}

function sortDue(list: Ranked[]): Ranked[] {
  return list.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.state.box - b.state.box ||
      (a.state.due! < b.state.due! ? -1 : a.state.due! > b.state.due! ? 1 : 0) ||
      a.card.sort - b.card.sort ||
      a.card.id.localeCompare(b.card.id),
  );
}

/** Everything the queue needs, folded once. */
export function buildQueue(input: QueueInput): TodayQueue {
  const { today, defaults } = input;
  const live = input.cards.filter((c) => c.status === 'live');
  const start = foldAll(
    live.map((c) => c.id),
    input.reviews,
    { beforeDay: today, waits: defaults.wait_days },
  );
  // Answered today in any way (never asked twice), and in today's lists themselves.
  const done = answeredToday(input.reviews, today);
  const inList = answeredToday(input.reviews, today, 'list');
  const studied = studiedOn(input.sessions ?? []);
  const yesterday = addDays(today, -1);
  /** Studied today or yesterday in a lesson or self-study: always in the evening list. */
  const fresh = (id: string) => {
    const day = studied.get(id);
    return day !== undefined && day >= yesterday && day <= today;
  };

  // Due at the start of the day, and new at the start of the day.
  const dueCards: Ranked[] = [];
  const newCards: Ranked[] = [];
  for (const card of live) {
    const state = start.get(card.id)!;
    if (state.box > 0) {
      if (state.due !== null && state.due <= today) dueCards.push({ card, state, rank: 0 });
    } else {
      newCards.push({ card, state, rank: 0 });
    }
  }

  // 1. Course order.
  const base = planFor(today, input.dayPlans, defaults);
  const order = courseOrder(
    base.planOrder,
    input.courses,
    dueCards.map((d) => ({ courseId: d.card.course_id, due: d.state.due! })),
    today,
  );
  const rankOf = (courseId: string) => {
    const i = order.indexOf(courseId);
    return i < 0 ? order.length : i;
  };
  for (const r of dueCards) r.rank = rankOf(r.card.course_id);
  for (const r of newCards) r.rank = rankOf(r.card.course_id);

  // 2. The morning list: due cards, sorted, under the cap. Cards ticked off in
  // today's list keep their place even if the order changed since (a new day_plan
  // in the evening). Cards done as extra practice are not asked again and leave
  // their place to the next ones.
  sortDue(dueCards);
  const dueKept = dueCards.filter((r) => inList.has(r.card.id));
  const dueOpen = dueCards.filter((r) => !done.has(r.card.id));
  const dueFill = dueOpen.slice(0, Math.max(0, base.cap - dueKept.length));
  const dueTaken = new Set([...dueKept, ...dueFill].map((r) => r.card.id));
  const rolledOver = dueOpen.length - dueFill.length;

  // 3. The evening list: new cards.
  const chapterSort = new Map(input.chapters.map((c) => [c.id, c.sort]));
  const near = new Map(newCards.map((r) => [r.card.id, nearestExamDays(r.card, input.exams, today)]));
  // A new card he got wrong in a quiz (due set, box 0): the quiz just showed it is needed.
  const flagged = (r: Ranked) => r.state.due !== null && r.state.due <= today;
  // Within a course: the most recent study first, imported cards last; cards
  // written together keep the order they were written in, and split cards carry
  // consecutive sort numbers, so a split card's parts stay together, in order.
  const byStudy = (a: Ranked, b: Ranked) =>
    (studied.get(b.card.id) ?? '').localeCompare(studied.get(a.card.id) ?? '') ||
    instant(a.card.created_at) - instant(b.card.created_at) ||
    (chapterSort.get(a.card.chapter_id) ?? 0) - (chapterSort.get(b.card.chapter_id) ?? 0) ||
    a.card.sort - b.card.sort ||
    (a.card.sibling_group ?? '').localeCompare(b.card.sibling_group ?? '') ||
    a.card.id.localeCompare(b.card.id);

  // 3a. Everything from today's and yesterday's lessons and self-studies, always.
  const fixed = newCards.filter((r) => fresh(r.card.id)).sort((a, b) => a.rank - b.rank || byStudy(a, b));

  // 3b. Then up to new_max in all: quiz-flagged and near-test cards in front, then
  // the courses the day plan names, taking turns ("eerst BR en OR"), then the rest.
  const pool = newCards
    .filter((r) => !fresh(r.card.id))
    .sort(
      (a, b) =>
        (flagged(a) ? 0 : 1) - (flagged(b) ? 0 : 1) ||
        near.get(a.card.id)! - near.get(b.card.id)! ||
        a.rank - b.rank ||
        byStudy(a, b),
    );
  if (base.planOrder.length >= 2) {
    const front = pool.filter((r) => flagged(r) || Number.isFinite(near.get(r.card.id)!));
    const rest = pool.filter((r) => !front.includes(r));
    const lanes = base.planOrder.map((c) => rest.filter((r) => r.card.course_id === c));
    const mixed: Ranked[] = [];
    for (let i = 0; lanes.some((l) => i < l.length); i++) for (const l of lanes) if (i < l.length) mixed.push(l[i]);
    const others = rest.filter((r) => !base.planOrder.includes(r.card.course_id));
    pool.splice(0, pool.length, ...front, ...mixed, ...others);
  }
  // Ticked off in today's list: keeps its place, but only a card the plan asks
  // for, so a stray answer can never eat the places of the planned courses.
  const planned = (r: Ranked) =>
    base.planOrder.length === 0 || base.planOrder.includes(r.card.course_id) || flagged(r) || Number.isFinite(near.get(r.card.id)!);
  const slots = Math.max(0, base.newMax - fixed.length);
  const newKept = pool.filter((r) => inList.has(r.card.id) && planned(r));
  const newFill = pool.filter((r) => !done.has(r.card.id)).slice(0, Math.max(0, slots - newKept.length));
  const newTaken = [...newKept, ...newFill];
  const newPick = new Map(newTaken.map((r, i) => [r.card.id, i]));

  // Final order: the evening list (today's study per course, then the others per
  // course), then the morning list (per course).
  const items: QueueItem[] = [];
  const add = (r: Ranked, kind: QueueItem['kind']) => items.push({ card: r.card, state: r.state, kind, done: done.has(r.card.id) });
  for (const r of fixed) add(r, 'new');
  for (const r of [...newTaken].sort((a, b) => a.rank - b.rank || newPick.get(a.card.id)! - newPick.get(b.card.id)!)) add(r, 'new');
  for (const r of dueCards) if (dueTaken.has(r.card.id)) add(r, 'review');

  const remaining = items.filter((i) => !i.done);
  const owed = owedRepeats(input.reviews, today);
  const repeats = items
    .filter((i) => owed.has(i.card.id))
    .map((item) => ({ item, attempt: owed.get(item.card.id)! }));
  const timing = personalTiming(input.reviews, today, defaults);
  const part = (kind: QueueItem['kind']): QueuePart => {
    const its = items.filter((i) => i.kind === kind);
    const rem = its.filter((i) => !i.done);
    return {
      items: its,
      remaining: rem,
      repeats: repeats.filter((r) => r.item.kind === kind),
      doneCount: its.length - rem.length,
      progress: its.length === 0 ? 1 : (its.length - rem.length) / its.length,
      remainingSec: estimateSeconds(rem, timing),
      courseChips: chipsOf(rem.length > 0 ? rem : its),
    };
  };

  return {
    day: today,
    plan: { day: today, cap: base.cap, newMax: base.newMax, courseOrder: order, reason: base.reason, fromPlan: base.fromPlan },
    items,
    parts: { review: part('review'), new: part('new') },
    remaining,
    repeats,
    total: items.length,
    doneCount: items.length - remaining.length,
    progress: items.length === 0 ? 1 : (items.length - remaining.length) / items.length,
    rolledOver,
    timing,
    remainingSec: estimateSeconds(remaining, timing),
    totalSec: estimateSeconds(items, timing),
    courseChips: chipsOf(remaining.length > 0 ? remaining : items),
  };
}

/** Courses with cards in a list, in the list's order (the chips on a Home card). */
function chipsOf(list: readonly QueueItem[]): string[] {
  const out: string[] = [];
  for (const i of list) if (!out.includes(i.card.course_id)) out.push(i.card.course_id);
  return out;
}

/** How many cards one "Overhoor dit hoofdstuk / vak" round holds. */
export const STUDY_ROUND = 20;

export interface StudyScope {
  kind: 'hoofdstuk' | 'vak';
  id: string;
}

/**
 * A round of cards from one chapter or one course, at any moment (his wish,
 * 26/10: on days with more time he works through a chapter with the boxes, not
 * only through today's list). First the cards whose day has come (lowest box
 * first), then new cards in chapter order, then cards whose day has not come
 * yet, lowest box first: reviewing early still moves a card one box, exactly
 * like pulling a box out of a real Leitner system. Cards answered today are
 * left out, so "Nog een ronde" carries on where the last round stopped.
 *
 * This is extra practice (his wish, 29/10): the cards in today's lists are
 * never part of it, so today's lists stay exactly as planned. `inToday` says
 * how many cards of the scope still wait in today's lists.
 */
export function studyRound(
  input: QueueInput,
  scope: StudyScope,
  size: number = STUDY_ROUND,
): { items: QueueItem[]; left: number; inToday: number } {
  const done = answeredToday(input.reviews, input.today);
  const inScope = (c: Card) => (scope.kind === 'hoofdstuk' ? c.chapter_id === scope.id : c.course_id === scope.id);
  const todays = buildQueue(input).items.filter((i) => inScope(i.card));
  const inList = new Set(todays.map((i) => i.card.id));
  const live = input.cards.filter((c) => c.status === 'live' && inScope(c) && !done.has(c.id) && !inList.has(c.id));
  const states = foldAll(live.map((c) => c.id), input.reviews, { waits: input.defaults.wait_days });
  const chapterSort = new Map(input.chapters.map((c) => [c.id, c.sort]));
  const due: Ranked[] = [];
  const fresh: Ranked[] = [];
  const early: Ranked[] = [];
  for (const card of live) {
    const state = states.get(card.id)!;
    if (state.box === 0) fresh.push({ card, state, rank: 0 });
    else if (state.due !== null && state.due <= input.today) due.push({ card, state, rank: 0 });
    else early.push({ card, state, rank: 0 });
  }
  sortDue(due);
  fresh.sort(
    (a, b) =>
      (chapterSort.get(a.card.chapter_id) ?? 0) - (chapterSort.get(b.card.chapter_id) ?? 0) ||
      instant(a.card.created_at) - instant(b.card.created_at) ||
      a.card.sort - b.card.sort ||
      a.card.id.localeCompare(b.card.id),
  );
  early.sort(
    (a, b) => a.state.box - b.state.box || (a.state.due ?? '').localeCompare(b.state.due ?? '') || a.card.id.localeCompare(b.card.id),
  );
  const all: QueueItem[] = [
    ...due.map((r) => ({ card: r.card, state: r.state, kind: 'review' as const, done: false })),
    ...fresh.map((r) => ({ card: r.card, state: r.state, kind: 'new' as const, done: false })),
    ...early.map((r) => ({ card: r.card, state: r.state, kind: 'review' as const, done: false })),
  ];
  return { items: all.slice(0, size), left: Math.max(0, all.length - size), inToday: todays.filter((i) => !i.done).length };
}

/** Today's list limited to one course ("Verder studeren" on a course page). */
export function forCourse(queue: TodayQueue, courseId: string): QueueItem[] {
  return queue.remaining.filter((i) => i.card.course_id === courseId);
}

/**
 * One more round for a course once today's part of it is done: its rolled-over
 * due cards and new cards that did not make today's list, within the same cap
 * and new_max. Nothing answered today is offered again.
 */
export function extraRound(input: QueueInput, queue: TodayQueue, courseId: string): QueueItem[] {
  const inToday = new Set(queue.items.map((i) => i.card.id));
  const done = answeredToday(input.reviews, input.today);
  const live = input.cards.filter((c) => c.status === 'live' && c.course_id === courseId && !inToday.has(c.id) && !done.has(c.id));
  const start = foldAll(live.map((c) => c.id), input.reviews, { beforeDay: input.today, waits: input.defaults.wait_days });
  const due: Ranked[] = [];
  const fresh: Ranked[] = [];
  for (const card of live) {
    const state = start.get(card.id)!;
    if (state.box > 0 && state.due !== null && state.due <= input.today) due.push({ card, state, rank: 0 });
    else if (state.box === 0) fresh.push({ card, state, rank: 0 });
  }
  sortDue(due);
  fresh.sort(
    (a, b) =>
      instant(a.card.created_at) - instant(b.card.created_at) ||
      a.card.sort - b.card.sort ||
      a.card.id.localeCompare(b.card.id),
  );
  return [
    ...due.slice(0, queue.plan.cap).map((r) => ({ card: r.card, state: r.state, kind: 'review' as const, done: false })),
    ...fresh.slice(0, queue.plan.newMax).map((r) => ({ card: r.card, state: r.state, kind: 'new' as const, done: false })),
  ];
}

/** Tomorrow's list as things stand now ("Klaar voor vandaag ✓ · morgen ±12 min"). */
export function tomorrowQueue(input: QueueInput): TodayQueue {
  return buildQueue({ ...input, today: addDays(input.today, 1) });
}

/* ------------------------------------------------------------------ *
 * Time estimates
 * ------------------------------------------------------------------ */

/** Longer than this is a phone left on the table, not thinking time. */
const MAX_SAMPLE_MS = 300_000;
const MIN_SAMPLES = 10;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Seconds per review and per new card.
 *
 * The defaults (15 s and 30 s) until he has 14 days of history; then the
 * medians of his own session answers over the last 14 days, each kind on its
 * own once it has at least ten samples. A card's first answer ever is a
 * "new" sample; every later session answer a "review" sample.
 */
export function personalTiming(reviews: readonly Review[], today: string, defaults: Defaults): Timing {
  const fallback: Timing = { reviewSec: defaults.est_sec_review, newSec: defaults.est_sec_new, source: 'default' };
  const undone = undoneIds(reviews);
  const rows = reviews
    .filter((r) => (r.mode === 'sessie' || r.mode === 'extra') && r.result !== 'undo' && !undone.has(r.id))
    .sort(compareRows);
  if (rows.length === 0 || daysBetween(rows[0].day, today) < 14) return fallback;

  const seen = new Set<string>();
  const since = addDays(today, -14);
  const fresh: number[] = [];
  const again: number[] = [];
  for (const r of rows) {
    const first = !seen.has(r.card_id);
    seen.add(r.card_id);
    // Only the 14 days up to and including `today`: rows from a later day exist
    // when tomorrow's estimate is asked for, or after the phone's clock was wrong.
    if (r.day < since || r.day > today) continue;
    if (r.ms === null || r.ms <= 0 || r.ms > MAX_SAMPLE_MS) continue;
    (first ? fresh : again).push(r.ms / 1000);
  }
  const mReview = again.length >= MIN_SAMPLES ? median(again) : null;
  const mNew = fresh.length >= MIN_SAMPLES ? median(fresh) : null;
  if (mReview === null && mNew === null) return fallback;
  return {
    reviewSec: mReview ?? fallback.reviewSec,
    newSec: mNew ?? fallback.newSec,
    source: 'personal',
  };
}

export function estimateSeconds(items: readonly Pick<QueueItem, 'kind'>[], timing: Timing): number {
  let sec = 0;
  for (const i of items) sec += i.kind === 'new' ? timing.newSec : timing.reviewSec;
  return Math.round(sec);
}

/** '±18 min' (never '±0 min' for a list that is not empty). */
export function minutesLabel(seconds: number): string {
  return `±${seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60))} min`;
}

/** '1 kaartje' / '32 kaartjes'. */
export function cardsLabel(n: number): string {
  return n === 1 ? '1 kaartje' : `${n} kaartjes`;
}

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

export type SessionAnswer = 'gekend' | 'hint' | 'niet';

export interface SessionStep {
  item: QueueItem;
  /** What to log: 'sessie' for the first pass, 'herhaling' for a repeat. */
  mode: 'sessie' | 'herhaling';
  /** 0 on the first pass, 1..2 on a herhaling. */
  attempt: number;
}

export interface SessionSummary {
  /** Answers given in this session (repeats included). */
  answered: number;
  /** Cards answered on the first pass. */
  cards: number;
  /** Of those, right the first time (Gekend, or Gekend met hint). */
  firstTryRight: number;
  /** 0..1, or null before the first answer. */
  firstTryShare: number | null;
  /** Cards that were "Niet gekend" on the first pass, in order ("Moeilijkste vandaag"). */
  failed: string[];
}

interface SessionState {
  main: number;
  repeats: { item: QueueItem; attempt: number }[];
  answers: { cardId: string; mode: 'sessie' | 'herhaling'; answer: SessionAnswer }[];
}

/**
 * Works through a list: the first pass in order, then every failed card again
 * at the end, up to MAX_REPEATS times, until he gets it right.
 *
 * Pure bookkeeping: it says which card is next and which mode to log; writing
 * the review row is the caller's job (data.ts). Undo steps back exactly one
 * answer, matching the "Ongedaan maken" toast.
 */
export class ReviewSession {
  private items: QueueItem[];
  private state: SessionState;
  private history: SessionState[] = [];
  private maxRepeats: number;

  constructor(items: readonly QueueItem[], repeats: readonly RepeatItem[] = [], maxRepeats: number = MAX_REPEATS) {
    this.items = [...items];
    this.maxRepeats = maxRepeats;
    this.state = {
      main: 0,
      repeats: repeats.map((r) => ({ item: r.item, attempt: r.attempt })),
      answers: [],
    };
  }

  /** The card to show now, or null when the session is over. */
  get current(): SessionStep | null {
    const s = this.state;
    if (s.main < this.items.length) return { item: this.items[s.main], mode: 'sessie', attempt: 0 };
    const next = s.repeats[0];
    return next ? { item: next.item, mode: 'herhaling', attempt: next.attempt } : null;
  }

  /** For "12 / 32": answers given, and answers given + steps still ahead. */
  get position(): { done: number; total: number } {
    const done = this.state.answers.length;
    const ahead = this.items.length - this.state.main + this.state.repeats.length;
    return { done, total: done + ahead };
  }

  get finished(): boolean {
    return this.current === null;
  }

  /** Record an answer for the current card and move on. Returns the step answered. */
  answer(answer: SessionAnswer): SessionStep {
    const step = this.current;
    if (!step) throw new Error('The session is already finished.');
    this.history.push(structuredCloneState(this.state));
    const s = this.state;
    s.answers.push({ cardId: step.item.card.id, mode: step.mode, answer });

    if (step.mode === 'sessie') {
      s.main++;
      if (answer === 'niet' && this.maxRepeats > 0) s.repeats.push({ item: step.item, attempt: 1 });
    } else {
      const [head] = s.repeats.splice(0, 1);
      if (answer === 'niet' && head.attempt < this.maxRepeats) {
        s.repeats.push({ item: head.item, attempt: head.attempt + 1 });
      }
    }
    return step;
  }

  /** Step back one answer. Returns false when there is nothing to undo. */
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.state = previous;
    return true;
  }

  summary(): SessionSummary {
    const first = this.state.answers.filter((a) => a.mode === 'sessie');
    const right = first.filter((a) => a.answer !== 'niet').length;
    return {
      answered: this.state.answers.length,
      cards: first.length,
      firstTryRight: right,
      firstTryShare: first.length === 0 ? null : right / first.length,
      failed: first.filter((a) => a.answer === 'niet').map((a) => a.cardId),
    };
  }
}

function structuredCloneState(s: SessionState): SessionState {
  return {
    main: s.main,
    repeats: s.repeats.map((r) => ({ item: r.item, attempt: r.attempt })),
    answers: s.answers.map((a) => ({ ...a })),
  };
}
