/**
 * When a reminder is due, and what it says. Pure: no database, no sending, so
 * any moment of the year can be tested (the night the clocks change too).
 *
 * Two reminders a day, Brussels time (his wish, 30/10):
 *   ochtend  7:00   the morning list, 🌅 Herhaling (cards whose day has come)
 *   avond    21:00  the evening list, 🌙 Nieuwe kaartjes (today's study first)
 *
 * Each has a window: a timer that was down at 7:00 still reminds him at 9:30,
 * but never at noon; the evening one runs until midnight. A reminder with
 * nothing to say is logged as skipped, so it is not looked at again that day.
 */

export type ReminderKind = 'ochtend' | 'avond';

/** Minutes after midnight, Brussels time: from (inclusive) until (exclusive). */
export const WINDOWS: Record<ReminderKind, { from: number; until: number }> = {
  ochtend: { from: 7 * 60, until: 11 * 60 },
  avond: { from: 21 * 60, until: 24 * 60 },
};

/** What sf_reminder_counts(day) returns. */
export interface Counts {
  morning: number;
  evening_fresh: number;
  evening_courses: string[];
  new_max: number;
  new_done_today: number;
}

export interface Reminder {
  /** 'ochtend:2026-10-31': the log refuses a second copy of a key. */
  key: string;
  kind: ReminderKind;
  /** Nothing to do: logged, never sent. */
  skip: boolean;
  title: string;
  body: string;
  /** A newer notification with the same tag replaces the older one. */
  tag: string;
}

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The Brussels calendar date and the minutes after midnight there. */
export function brussels(now: number): { date: string; minutes: number } {
  const parts = clock.formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/** The study day, as in the app: before 04:00 it is still the previous day. */
export function studyDayOf(now: number): string {
  const { date, minutes } = brussels(now);
  if (minutes >= 4 * 60) return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The reminders whose window is open now and that were not logged yet that day. */
export function openKinds(now: number, logged: ReadonlySet<string>): ReminderKind[] {
  const { minutes } = brussels(now);
  const day = studyDayOf(now);
  return (Object.keys(WINDOWS) as ReminderKind[]).filter(
    (k) => minutes >= WINDOWS[k].from && minutes < WINDOWS[k].until && !logged.has(`${k}:${day}`),
  );
}

const cardsLabel = (n: number) => (n === 1 ? '1 kaartje' : `${n} kaartjes`);
const minutesFor = (n: number, secondsEach: number) => Math.max(1, Math.round((n * secondsEach) / 60));

/** 'BR', 'BR en OR', 'BR, OR en SCM'. */
export function courseList(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  if (sorted.length <= 1) return sorted.join('');
  return `${sorted.slice(0, -1).join(', ')} en ${sorted[sorted.length - 1]}`;
}

/** Every reminder due now, with its text; `skip` when there is nothing to do. */
export function dueReminders(now: number, logged: ReadonlySet<string>, counts: Counts): Reminder[] {
  const day = studyDayOf(now);
  return openKinds(now, logged).map((kind): Reminder => {
    const key = `${kind}:${day}`;
    if (kind === 'ochtend') {
      const n = counts.morning;
      return {
        key,
        kind,
        skip: n === 0,
        title: '🌅 Herhaling in StudyFlow',
        body: `${cardsLabel(n)} uit je dozen ${n === 1 ? 'wacht' : 'wachten'} op je (±${minutesFor(n, 15)} min).`,
        tag: 'studyflow-ochtend',
      };
    }
    const fresh = counts.evening_fresh;
    if (fresh > 0) {
      const courses = courseList(counts.evening_courses);
      return {
        key,
        kind,
        skip: false,
        title: '🌙 Nieuwe kaartjes in StudyFlow',
        body: `${cardsLabel(fresh)} van wat je studeerde ${fresh === 1 ? 'staat' : 'staan'} vooraan${courses ? ` (${courses})` : ''}.`,
        tag: 'studyflow-avond',
      };
    }
    // Nothing studied lately: remind him of the catch-up only if he has not started.
    const catchUp = counts.new_max > 0 && counts.new_done_today === 0;
    return {
      key,
      kind,
      skip: !catchUp,
      title: '🌙 Nieuwe kaartjes in StudyFlow',
      body: `Je inhaalkaartjes staan klaar (±${minutesFor(counts.new_max, 30)} min).`,
      tag: 'studyflow-avond',
    };
  });
}
