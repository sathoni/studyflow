/**
 * Days, the way a study schedule needs them.
 *
 * Two rules carry everything here:
 *
 *  1. A study day is a Brussels calendar date that rolls over at 04:00, not at
 *     midnight. Reviewing at 01:30 after a late shift still counts for the
 *     evening before, which is how Mathieu thinks about "today".
 *  2. Day arithmetic is calendar arithmetic on 'YYYY-MM-DD'. Adding 86 400 000
 *     milliseconds is wrong twice a year (Lessons learned: "Dates that quietly
 *     go wrong"), and a Leitner due date that drifts by a day is exactly the
 *     kind of bug nobody notices. So days never pass through local midnight:
 *     they go through UTC noon-free integer maths and come straight back.
 *
 * The clocks change on 25/10/2026 and 28/03/2027; the tests cross both.
 */

import type { Day } from './model.ts';

/** The hour (Brussels wall clock) at which a new study day starts. */
export const ROLLOVER_HOUR = 4;

const TIME_ZONE = 'Europe/Brussels';

/**
 * One formatter, made once. Creating an Intl formatter is slow, and the queue
 * asks for the study day of every review row.
 */
let wallClock: Intl.DateTimeFormat | null = null;

function formatter(): Intl.DateTimeFormat {
  if (!wallClock) {
    wallClock = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  return wallClock;
}

export interface WallClock {
  /** The Brussels calendar date, 'YYYY-MM-DD'. */
  date: Day;
  hour: number;
  minute: number;
}

/** What a clock on a wall in Brussels shows at this instant. */
export function brusselsClock(at: Date | number | string): WallClock {
  const parts = formatter().formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // Some engines write midnight as "24" even with h23; normalise it.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/**
 * The study day an instant belongs to.
 *
 * Read the Brussels wall clock; before 04:00 it still counts as the previous
 * date. Deliberately not "the Brussels date of (t − 4 h)": on the two nights
 * the clocks change that shortcut moves the rollover to 03:00 or 05:00.
 */
export function studyDay(at: Date | number | string = Date.now()): Day {
  const clock = brusselsClock(at);
  return clock.hour < ROLLOVER_HOUR ? addDays(clock.date, -1) : clock.date;
}

/**
 * A server or phone timestamp as milliseconds.
 *
 * The phone writes '2026-10-24T19:00:00.123Z'; the server sends the same
 * instant back as '2026-10-24T19:00:00.123+00:00', sometimes with six
 * fractional digits. Those strings do not sort the same way, so ordering is
 * always done on this number. The fraction is cut to milliseconds first,
 * because engines disagree about parsing more than three digits.
 */
export function instant(ts: string): number {
  const ms = Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? 0 : ms;
}

/* ------------------------------------------------------------------ *
 * Calendar arithmetic on 'YYYY-MM-DD'
 * ------------------------------------------------------------------ */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 for a calendar date. Pure integer maths. */
export function dayNumber(day: Day): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Not a day: ${day}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** The calendar date for a day number. */
export function fromDayNumber(n: number): Day {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function isDay(value: unknown): value is Day {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  return fromDayNumber(dayNumber(value)) === value; // rejects 2026-02-30
}

/** day + n calendar days (n may be negative). */
export function addDays(day: Day, n: number): Day {
  return fromDayNumber(dayNumber(day) + n);
}

/** Whole calendar days from a to b (b later = positive). */
export function daysBetween(a: Day, b: Day): number {
  return dayNumber(b) - dayNumber(a);
}

/** 0 = Monday … 6 = Sunday, the way a Belgian week runs. */
export function weekday(day: Day): number {
  // 1970-01-01 was a Thursday (3 in this numbering).
  return (((dayNumber(day) + 3) % 7) + 7) % 7;
}

export function isSunday(day: Day): boolean {
  return weekday(day) === 6;
}

/** The Monday of the week the day is in. */
export function weekStart(day: Day): Day {
  return addDays(day, -weekday(day));
}

/** Monday … Sunday of the day's week. Drives the seven bars on Home. */
export function weekDays(day: Day): Day[] {
  const monday = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The earlier of two days, ignoring nulls. */
export function minDay(a: Day | null, b: Day | null): Day | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/* ------------------------------------------------------------------ *
 * Words for days (Flemish Dutch)
 * ------------------------------------------------------------------ */

export const WEEKDAYS_SHORT = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
export const WEEKDAYS_BAR = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
export const WEEKDAYS_LONG = [
  'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
];
export const MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

/** 'vr 23/10', as in his Notion day plan. */
export function shortDate(day: Day): string {
  const [, m, d] = day.split('-');
  return `${WEEKDAYS_SHORT[weekday(day)]} ${Number(d)}/${Number(m)}`;
}

/** 'vrijdag 23 oktober'. */
export function longDate(day: Day): string {
  const [, m, d] = day.split('-');
  return `${WEEKDAYS_LONG[weekday(day)]} ${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** 'vandaag', 'morgen', 'overmorgen', 'over 6 dagen', 'gisteren', '3 dagen geleden'. */
export function relativeDay(day: Day, today: Day): string {
  const n = daysBetween(today, day);
  if (n === 0) return 'vandaag';
  if (n === 1) return 'morgen';
  if (n === 2) return 'overmorgen';
  if (n === -1) return 'gisteren';
  if (n > 0) return `over ${n} dagen`;
  return `${-n} dagen geleden`;
}

/** 'Goedemorgen' / 'Goedemiddag' / 'Goedenavond', by the Brussels clock. */
export function greeting(at: Date | number = Date.now()): string {
  const { hour } = brusselsClock(at);
  if (hour >= 5 && hour < 12) return 'Goedemorgen';
  if (hour >= 12 && hour < 18) return 'Goedemiddag';
  return 'Goedenavond';
}
