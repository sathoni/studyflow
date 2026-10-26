/**
 * Overhoor-instrumenten (R9): the daytime schedule (SPEC-v3 §7).
 *
 * Practising one means recalling a whole table on paper, so it lives in a
 * daytime study block, not in the evening card session. The app only keeps
 * the rhythm, folded from the instrument_reviews log like the cards are:
 *
 *   Alles juist   the next step: 1 → 3 → 7 → 14 days (14 stays 14)
 *   Bijna         the same step again
 *   Veel fout     back to 1 day
 *
 * The first practice starts on the 1-day step, so "Alles juist" the first
 * time means: again in 3 days. An instrument never practised is due today.
 */

import type { Day, Instrument, InstrumentReview, InstrumentScore } from './model.ts';
import { addDays } from './dates.ts';

export const INSTRUMENT_STEPS: readonly number[] = [1, 3, 7, 14];

export const SCORE_LABELS: Record<InstrumentScore, string> = {
  alles: 'Alles juist',
  bijna: 'Bijna',
  veel_fout: 'Veel fout',
};

export interface InstrumentState {
  instrument_id: string;
  /** Index in INSTRUMENT_STEPS of the step it is on now. */
  step: number;
  /** null: never practised (due at once). */
  due: Day | null;
  last_day: Day | null;
  last_score: InstrumentScore | null;
  times: number;
}

export function nextStep(step: number, score: InstrumentScore): number {
  if (score === 'alles') return Math.min(step + 1, INSTRUMENT_STEPS.length - 1);
  if (score === 'bijna') return step;
  return 0;
}

/** The state of one instrument from its log (any order; other instruments ignored). */
export function foldInstrument(id: string, rows: readonly InstrumentReview[]): InstrumentState {
  const mine = rows
    .filter((r) => r.instrument_id === id)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.created_at ?? '').localeCompare(b.created_at ?? '')));
  let state: InstrumentState = { instrument_id: id, step: 0, due: null, last_day: null, last_score: null, times: 0 };
  for (const row of mine) {
    const step = state.times === 0 ? nextStep(0, row.score) : nextStep(state.step, row.score);
    state = {
      instrument_id: id,
      step,
      due: addDays(row.day, INSTRUMENT_STEPS[step]),
      last_day: row.day,
      last_score: row.score,
      times: state.times + 1,
    };
  }
  return state;
}

/** The preview on the three score buttons: "over 3 dagen". */
export function scorePreview(state: InstrumentState, score: InstrumentScore): number {
  return INSTRUMENT_STEPS[nextStep(state.step, score)];
}

export interface DueInstrument {
  instrument: Instrument;
  state: InstrumentState;
  /** Scored today already: shown as done in "Overdag". */
  doneToday: boolean;
}

/** At most this many instruments are offered per day: it is a short daytime block. */
export const MAX_INSTRUMENTS_PER_DAY = 2;

/**
 * The "Overdag" row on Home: the ones already scored today (so the row does not
 * jump), then at most two open ones. First those whose next date has come; then
 * never-practised ones, but only from the courses today's plan names first, in
 * that order. Only active instruments.
 */
export function dueInstruments(
  instruments: readonly Instrument[],
  reviews: readonly InstrumentReview[],
  today: Day,
  courseOrder: readonly string[] = [],
): DueInstrument[] {
  const done: DueInstrument[] = [];
  const started: DueInstrument[] = [];
  const fresh: DueInstrument[] = [];
  for (const instrument of instruments) {
    if (instrument.status && !['actief', 'active', 'live'].includes(instrument.status)) continue;
    const state = foldInstrument(instrument.id, reviews);
    if (state.last_day === today) done.push({ instrument, state, doneToday: true });
    else if (state.due !== null && state.due <= today) started.push({ instrument, state, doneToday: false });
    else if (state.due === null && courseOrder.includes(instrument.course_id)) fresh.push({ instrument, state, doneToday: false });
  }
  started.sort((a, b) => (a.state.due ?? '').localeCompare(b.state.due ?? ''));
  fresh.sort((a, b) => courseOrder.indexOf(a.instrument.course_id) - courseOrder.indexOf(b.instrument.course_id));
  const open = [...started, ...fresh].slice(0, Math.max(0, MAX_INSTRUMENTS_PER_DAY - done.length));
  return [...open, ...done];
}

/** The instrument_reviews row for a score (uuid made here; a resend is harmless). */
export function instrumentReviewRow(
  instrumentId: string,
  score: InstrumentScore,
  day: Day,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): InstrumentReview {
  return { id, instrument_id: instrumentId, day, score, created_at: now.toISOString() };
}
