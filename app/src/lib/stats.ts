/**
 * The numbers on Home, Voortgang and Profiel: the seven bars, the streak,
 * minutes and cards this week, % right first time, the box spread per course,
 * "Moeilijkste", and the three goals.
 *
 * Pure functions over the snapshot, so they are tested without a browser.
 * The box rules themselves stay in leitner.ts; this only counts.
 */

import type { Card, Day, Goal, Review } from './model.ts';
import { type Box, type CardState, foldAll, undoneIds } from './leitner.ts';
import { addDays, weekDays, WEEKDAYS_BAR } from './dates.ts';
import type { TodayQueue } from './queue.ts';
import type { RunScore } from './quiz.ts';

/* ------------------------------------------------------------------ *
 * Activity
 * ------------------------------------------------------------------ */

/**
 * Answers given in a review session (first pass or herhaling), minus the ones
 * he undid. Manual "Opnieuw leren" and quiz rows are not studying cards.
 */
export function sessionRows(reviews: readonly Review[]): Review[] {
  const undone = undoneIds(reviews);
  return reviews.filter(
    (r) => (r.mode === 'sessie' || r.mode === 'herhaling') && r.result !== 'undo' && !undone.has(r.id),
  );
}

/** Different cards answered per study day. */
export function cardsByDay(reviews: readonly Review[]): Map<Day, number> {
  const sets = new Map<Day, Set<string>>();
  for (const r of sessionRows(reviews)) {
    let set = sets.get(r.day);
    if (!set) sets.set(r.day, (set = new Set()));
    set.add(r.card_id);
  }
  const out = new Map<Day, number>();
  for (const [day, set] of sets) out.set(day, set.size);
  return out;
}

export interface DayBar {
  day: Day;
  /** 'Ma' … 'Zo'. */
  label: string;
  count: number;
  isToday: boolean;
  future: boolean;
}

/** Monday to Sunday of this week, with the cards reviewed each day (the bars on Home). */
export function weekBars(reviews: readonly Review[], today: Day): DayBar[] {
  const perDay = cardsByDay(reviews);
  return weekDays(today).map((day, i) => ({
    day,
    label: WEEKDAYS_BAR[i],
    count: perDay.get(day) ?? 0,
    isToday: day === today,
    future: day > today,
  }));
}

/**
 * Days in a row with at least one card reviewed. Today still counts as "not
 * over yet": without a review today the streak runs up to yesterday.
 */
export function streak(reviews: readonly Review[], today: Day): number {
  const perDay = cardsByDay(reviews);
  let day = (perDay.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  let n = 0;
  while ((perDay.get(day) ?? 0) > 0) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

/** Cards reviewed this week (Monday up to today), counted once per day. */
export function weekCards(reviews: readonly Review[], today: Day): number {
  return weekBars(reviews, today).reduce((sum, b) => sum + b.count, 0);
}

/**
 * Minutes spent reviewing this week. Each answer's own time (ms), capped at
 * five minutes so a phone left on the table does not count; answers without a
 * time count as `fallbackSec`.
 */
export function weekMinutes(reviews: readonly Review[], today: Day, fallbackSec = 15): number {
  const days = new Set(weekDays(today).filter((d) => d <= today));
  let ms = 0;
  for (const r of sessionRows(reviews)) {
    if (!days.has(r.day)) continue;
    ms += r.ms !== null && r.ms > 0 ? Math.min(r.ms, 300_000) : fallbackSec * 1000;
  }
  return Math.round(ms / 60_000);
}

/**
 * Share right the first time over the last `days` study days (today
 * included): first-pass answers that were Gekend or Gekend met hint. Null
 * before any answer.
 */
export function firstTryShare(reviews: readonly Review[], today: Day, days = 14): number | null {
  const since = addDays(today, -(days - 1));
  let right = 0;
  let all = 0;
  for (const r of sessionRows(reviews)) {
    if (r.mode !== 'sessie' || r.day < since || r.day > today) continue;
    all++;
    if (r.result === 'gekend' || r.result === 'hint') right++;
  }
  return all === 0 ? null : right / all;
}

/* ------------------------------------------------------------------ *
 * Boxes
 * ------------------------------------------------------------------ */

/** Every live card's state right now (today's answers included). */
export function currentStates(
  cards: readonly Card[],
  reviews: readonly Review[],
  waits?: readonly number[],
): Map<string, CardState> {
  return foldAll(
    cards.filter((c) => c.status === 'live').map((c) => c.id),
    reviews,
    { waits },
  );
}

/** How many of these cards sit in Nieuw, Doos 1 … 5 and Gekend. */
export function boxSpread(cardIds: Iterable<string>, states: ReadonlyMap<string, CardState>): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const id of cardIds) out[states.get(id)?.box ?? 0]++;
  return out;
}

/**
 * The course and chapter %: the share of the cards in Doos 3 or higher
 * (Gekend included). Null when there are no cards.
 */
export function masteredShare(cardIds: readonly string[], states: ReadonlyMap<string, CardState>): number | null {
  if (cardIds.length === 0) return null;
  let n = 0;
  for (const id of cardIds) if ((states.get(id)?.box ?? 0) >= 3) n++;
  return n / cardIds.length;
}

/**
 * "Moeilijkste": the cards he marked ☆ first, then the ones that went back to
 * Doos 1 most often. Cards that never lapsed and are not starred are left out.
 */
export function hardestCards(
  cards: readonly Card[],
  states: ReadonlyMap<string, CardState>,
  starred: ReadonlySet<string>,
  limit = 3,
): Card[] {
  return cards
    .filter((c) => c.status === 'live' && (starred.has(c.id) || (states.get(c.id)?.lapses ?? 0) > 0))
    .map((c) => ({ c, star: starred.has(c.id) ? 1 : 0, lapses: states.get(c.id)?.lapses ?? 0, box: states.get(c.id)?.box ?? 0 }))
    .sort((a, b) => b.star - a.star || b.lapses - a.lapses || a.box - b.box || a.c.sort - b.c.sort)
    .slice(0, limit)
    .map((x) => x.c);
}

/** Box labels for the stacked bar legend. */
export const SPREAD_LABELS = ['Nieuw', 'D1', 'D2', 'D3', 'D4', 'D5', 'Gekend'] as const;

export function isBox(n: number): n is Box {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

/* ------------------------------------------------------------------ *
 * Quizzes and goals
 * ------------------------------------------------------------------ */

/** Quiz runs finished (or started) this week, Monday up to today. */
export function quizzesThisWeek(scores: readonly RunScore[], today: Day): number {
  const monday = weekDays(today)[0];
  return scores.filter((s) => s.day >= monday && s.day <= today).length;
}

export interface GoalProgress {
  goal: Goal;
  /** '12 / 32', '76% / 80%', '2 / 3'. */
  label: string;
  /** 0..1 for the bar. */
  share: number;
  reached: boolean;
}

export interface GoalInput {
  queue: Pick<TodayQueue, 'doneCount' | 'total' | 'progress'>;
  accuracy: number | null;
  quizzesWeek: number;
}

const pctText = (share: number) => `${Math.round(share * 100)}%`;

/**
 * One goal from settings.goals, measured. Goals with an id the app does not
 * know are left out (null) rather than shown with a made-up number.
 */
export function goalProgress(goal: Goal, input: GoalInput): GoalProgress | null {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  switch (goal.id) {
    case 'daily_queue': {
      const { doneCount, total } = input.queue;
      const share = total === 0 ? 1 : clamp(doneCount / total);
      return { goal, label: `${doneCount} / ${total}`, share, reached: share >= (goal.target || 1) };
    }
    case 'accuracy': {
      const target = goal.target || 0.8;
      if (input.accuracy === null) return { goal, label: `– / ${pctText(target)}`, share: 0, reached: false };
      return {
        goal,
        label: `${pctText(input.accuracy)} / ${pctText(target)}`,
        share: clamp(input.accuracy / target),
        reached: input.accuracy >= target,
      };
    }
    case 'quizzes_week': {
      const target = Math.max(1, goal.target || 3);
      return {
        goal,
        label: `${input.quizzesWeek} / ${target}`,
        share: clamp(input.quizzesWeek / target),
        reached: input.quizzesWeek >= target,
      };
    }
    default:
      return null;
  }
}
