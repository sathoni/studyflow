/**
 * The box method, exactly as Mathieu knows it (SPEC-v3 §3, SCHEMA.md "Leitner fold").
 *
 *   Gekend           one box up (new -> Doos 2, Doos 5 -> Gekend)
 *   Gekend met hint  stays in its box (new -> Doos 1)
 *   Niet gekend      back to Doos 1
 *
 * Never several boxes at once, no FSRS, no hidden maths.
 *
 * A card's state is not stored anywhere: it is a fold over the append-only
 * `reviews` log, replayed in order. That makes undo trivial (an undo row
 * cancels an earlier row), makes two devices agree without merging, and means
 * the SQL function public.card_states() can mirror this file line for line.
 * If you change a rule here, change private.leitner_step with it.
 *
 * Box numbers: 0 = new ("Nieuw"), 1–5 = Doos 1–5, 6 = Gekend.
 */

import { DEFAULTS, type Day, type Review, type ReviewMode, type ReviewResult } from './model.ts';
import { addDays, instant, studyDay } from './dates.ts';

export type Box = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const NEW: Box = 0;
export const GEKEND: Box = 6;
export const BOXES: readonly Box[] = [0, 1, 2, 3, 4, 5, 6];

export interface CardState {
  card_id: string;
  box: Box;
  /** The study day it is due, or null when it has never been reviewed. */
  due: Day | null;
  /** Rows that counted (quiz_fout included), like card_states().n_reviews. */
  n_reviews: number;
  /** Day of the last row that counted. */
  last_day: Day | null;
  /** How often it went back to Doos 1 with "Niet gekend". Feeds "Moeilijkste". */
  lapses: number;
  last_result: ReviewResult | null;
}

export function newState(cardId: string): CardState {
  return { card_id: cardId, box: NEW, due: null, n_reviews: 0, last_day: null, lapses: 0, last_result: null };
}

/* ------------------------------------------------------------------ *
 * One step
 * ------------------------------------------------------------------ */

/** The box after one row. quiz_fout and undo leave the box alone. */
export function nextBox(box: Box, result: ReviewResult): Box {
  switch (result) {
    case 'gekend':
      return box === NEW ? 2 : (Math.min(box + 1, GEKEND) as Box);
    case 'hint':
      return box === NEW ? 1 : box;
    case 'niet':
    case 'opnieuw':
      return 1;
    default:
      return box;
  }
}

/** Days to wait after a review that left the card in this box. */
export function waitDays(box: Box, waits: readonly number[] = DEFAULTS.wait_days): number {
  return waits[Math.max(box, 1) - 1] ?? DEFAULTS.wait_days[Math.max(box, 1) - 1];
}

/** Apply one row that counts. */
export function step(
  state: CardState,
  row: Pick<Review, 'result' | 'day'>,
  waits: readonly number[] = DEFAULTS.wait_days,
): CardState {
  const box = nextBox(state.box, row.result);
  const due = row.result === 'quiz_fout' ? addDays(row.day, 1) : addDays(row.day, waitDays(box, waits));
  return {
    card_id: state.card_id,
    box,
    due,
    n_reviews: state.n_reviews + 1,
    last_day: row.day,
    lapses: state.lapses + (row.result === 'niet' ? 1 : 0),
    last_result: row.result,
  };
}

/* ------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------ */

export interface FoldOptions {
  /** Wait days for boxes 1..6 (settings.defaults.wait_days). */
  waits?: readonly number[];
  /**
   * Only rows from study days before this one. Gives the state "at the start
   * of the day", which keeps today's queue stable while he works through it.
   * Undo rows of any day still cancel what they undo.
   */
  beforeDay?: Day;
}

/** Same order as the SQL: reviewed_at, then id. */
export function compareRows(a: Review, b: Review): number {
  return instant(a.reviewed_at) - instant(b.reviewed_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The ids cancelled by undo rows. */
export function undoneIds(rows: readonly Review[]): Set<string> {
  const undone = new Set<string>();
  for (const row of rows) if (row.result === 'undo' && row.undoes) undone.add(row.undoes);
  return undone;
}

/** Does this row change the card's state? */
export function counts(row: Review, undone: ReadonlySet<string>, beforeDay?: Day): boolean {
  if (row.result === 'undo' || undone.has(row.id) || row.mode === 'herhaling') return false;
  return beforeDay === undefined || row.day < beforeDay;
}

/**
 * The state of one card from its rows (any order; other cards' rows ignored).
 *
 * Pass `undone` when folding many cards so the undo set is built once.
 */
export function foldCard(
  cardId: string,
  rows: readonly Review[],
  options: FoldOptions = {},
  undone: ReadonlySet<string> = undoneIds(rows),
): CardState {
  const mine = rows
    .filter((r) => r.card_id === cardId && counts(r, undone, options.beforeDay))
    .sort(compareRows);
  let state = newState(cardId);
  for (const row of mine) state = step(state, row, options.waits);
  return state;
}

/** The state of every card in one pass. Cards with no rows come back as new. */
export function foldAll(
  cardIds: Iterable<string>,
  reviews: readonly Review[],
  options: FoldOptions = {},
): Map<string, CardState> {
  const undone = undoneIds(reviews);
  const byCard = new Map<string, Review[]>();
  for (const row of reviews) {
    if (!counts(row, undone, options.beforeDay)) continue;
    let list = byCard.get(row.card_id);
    if (!list) byCard.set(row.card_id, (list = []));
    list.push(row);
  }

  const states = new Map<string, CardState>();
  for (const id of cardIds) {
    const rows = (byCard.get(id) ?? []).sort(compareRows);
    let state = newState(id);
    for (const row of rows) state = step(state, row, options.waits);
    states.set(id, state);
  }
  return states;
}

/* ------------------------------------------------------------------ *
 * Words and previews for the screen
 * ------------------------------------------------------------------ */

/** 'Nieuw', 'Doos 1' … 'Doos 5', 'Gekend'. */
export function boxLabel(box: Box): string {
  if (box === NEW) return 'Nieuw';
  if (box === GEKEND) return 'Gekend';
  return `Doos ${box}`;
}

/** How a box shows up in the small line under the green button. */
function boxPhrase(box: Box): string {
  return box === GEKEND ? 'Gekend' : `Doos ${box}`;
}

/** What tapping the green button records: 'gekend', or 'hint' after any hint. */
export function greenResult(hintsUsed: number): 'gekend' | 'hint' {
  return hintsUsed > 0 ? 'hint' : 'gekend';
}

export interface ButtonPreview {
  result: 'niet' | 'gekend' | 'hint';
  /** 'Niet gekend', 'Gekend', 'Gekend met hint'. */
  label: string;
  /** 'terug naar Doos 1', 'naar Doos 4', 'blijft in Doos 3', … */
  sub: string;
  /** Where the card would land. */
  box: Box;
  /** When it would come back. */
  due: Day;
  days: number;
}

/**
 * The two big buttons, with what each one would do to this card.
 *
 * The green button turns into "Gekend met hint" as soon as one hint was
 * opened, and its line then says the card stays where it is: the honest
 * consequence of needing help, without a penalty back to Doos 1.
 */
export function previewButtons(
  state: Pick<CardState, 'box'>,
  hintsUsed: number,
  today: Day,
  waits: readonly number[] = DEFAULTS.wait_days,
): { red: ButtonPreview; green: ButtonPreview } {
  const redDays = waitDays(1, waits);
  const red: ButtonPreview = {
    result: 'niet',
    label: 'Niet gekend',
    sub: 'terug naar Doos 1',
    box: 1,
    due: addDays(today, redDays),
    days: redDays,
  };

  const result = greenResult(hintsUsed);
  const box = nextBox(state.box, result);
  const days = waitDays(box, waits);
  let sub: string;
  if (result === 'gekend') {
    sub = box === state.box ? 'blijft Gekend' : `naar ${boxPhrase(box)}`;
  } else if (state.box === NEW) {
    sub = 'naar Doos 1';
  } else {
    sub = state.box === GEKEND ? 'blijft Gekend' : `blijft in Doos ${state.box}`;
  }
  const green: ButtonPreview = {
    result,
    label: result === 'gekend' ? 'Gekend' : 'Gekend met hint',
    sub,
    box,
    due: addDays(today, days),
    days,
  };
  return { red, green };
}

/** 'Hint (1/3)' → 'Nog een hint (2/3)' → 'Laatste hint (3/3)'; null when all are shown. */
export function hintButtonLabel(hintsShown: number): string | null {
  if (hintsShown <= 0) return 'Hint (1/3)';
  if (hintsShown === 1) return 'Nog een hint (2/3)';
  if (hintsShown === 2) return 'Laatste hint (3/3)';
  return null;
}

/** How many of these cards sit in each box (the box row in a session). */
export function boxCounts(
  cardIds: Iterable<string>,
  states: ReadonlyMap<string, CardState>,
): Record<Box, number> {
  const out: Record<Box, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const id of cardIds) out[states.get(id)?.box ?? NEW]++;
  return out;
}

/* ------------------------------------------------------------------ *
 * Making log rows
 * ------------------------------------------------------------------ */

export interface ReviewDraft {
  card_id: string;
  result: Exclude<ReviewResult, 'undo'>;
  mode: ReviewMode;
  hints_used?: number;
  ms?: number | null;
}

/**
 * A new row for the reviews log. The id is made here, on the phone, so
 * sending it twice is harmless (the server ignores the duplicate).
 */
export function reviewRow(draft: ReviewDraft, now: Date = new Date(), id: string = crypto.randomUUID()): Review {
  return {
    id,
    card_id: draft.card_id,
    reviewed_at: now.toISOString(),
    day: studyDay(now),
    result: draft.result,
    hints_used: Math.max(0, Math.min(3, Math.round(draft.hints_used ?? 0))),
    mode: draft.mode,
    undoes: null,
    ms: draft.ms === null || draft.ms === undefined
      ? null
      : Math.max(0, Math.min(86_400_000, Math.round(draft.ms))),
  };
}

/** The row that cancels an earlier one (the "Ongedaan maken" toast). */
export function undoRow(target: Review, now: Date = new Date(), id: string = crypto.randomUUID()): Review {
  return {
    id,
    card_id: target.card_id,
    reviewed_at: now.toISOString(),
    day: studyDay(now),
    result: 'undo',
    hints_used: 0,
    mode: target.mode,
    undoes: target.id,
    ms: null,
  };
}
