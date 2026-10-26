/**
 * The box method, row by row, against SPEC-v3 §3 and SCHEMA.md "Leitner fold".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Review, ReviewMode, ReviewResult } from './model.ts';
import {
  type Box,
  boxCounts,
  boxLabel,
  foldAll,
  foldCard,
  greenResult,
  hintButtonLabel,
  newState,
  nextBox,
  previewButtons,
  reviewRow,
  step,
  undoRow,
  waitDays,
} from './leitner.ts';
import { addDays } from './dates.ts';

const CARD = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

let counter = 0;
/** A review row at 20:00 UTC (21:00/22:00 Brussels) on the given study day. */
function row(
  day: string,
  result: ReviewResult,
  extra: Partial<Review> = {},
): Review {
  counter++;
  return {
    id: extra.id ?? `10000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    card_id: extra.card_id ?? CARD,
    reviewed_at: extra.reviewed_at ?? `${day}T20:00:${String(counter % 60).padStart(2, '0')}.000Z`,
    day,
    result,
    hints_used: extra.hints_used ?? 0,
    mode: extra.mode ?? ('sessie' as ReviewMode),
    undoes: extra.undoes ?? null,
    ms: extra.ms ?? 4000,
  };
}

/* ---- the movement table (SPEC-v3 §3) ---- */

test('new card: Gekend -> Doos 2, Gekend met hint -> Doos 1, Niet gekend -> Doos 1', () => {
  assert.equal(nextBox(0, 'gekend'), 2);
  assert.equal(nextBox(0, 'hint'), 1);
  assert.equal(nextBox(0, 'niet'), 1);
  assert.equal(nextBox(0, 'opnieuw'), 1);
});

test('Doos n: Gekend -> n+1, hint -> stays, Niet gekend -> Doos 1', () => {
  for (const n of [1, 2, 3, 4] as Box[]) {
    assert.equal(nextBox(n, 'gekend'), n + 1, `Doos ${n} gekend`);
    assert.equal(nextBox(n, 'hint'), n, `Doos ${n} hint`);
    assert.equal(nextBox(n, 'niet'), 1, `Doos ${n} niet`);
  }
  assert.equal(nextBox(5, 'gekend'), 6, 'Doos 5 -> Gekend');
  assert.equal(nextBox(5, 'hint'), 5);
});

test('Gekend stays Gekend, except Niet gekend', () => {
  assert.equal(nextBox(6, 'gekend'), 6);
  assert.equal(nextBox(6, 'hint'), 6);
  assert.equal(nextBox(6, 'niet'), 1);
  assert.equal(nextBox(6, 'opnieuw'), 1);
});

test('quiz_fout never moves a box', () => {
  for (const b of [0, 1, 2, 3, 4, 5, 6] as Box[]) assert.equal(nextBox(b, 'quiz_fout'), b);
});

test('never more than one box up', () => {
  for (const b of [0, 1, 2, 3, 4, 5, 6] as Box[]) {
    for (const r of ['gekend', 'hint', 'niet', 'opnieuw', 'quiz_fout'] as ReviewResult[]) {
      const nb = nextBox(b, r);
      assert.ok(nb <= Math.max(b + 1, 2), `${b} ${r} -> ${nb}`);
    }
  }
});

test('waits are 1, 3, 7, 14, 28, 60 days', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((b) => waitDays(b as Box)), [1, 3, 7, 14, 28, 60]);
  assert.equal(waitDays(0), 1, 'a new card never gets a wait of its own; guard only');
});

/* ---- the fold ---- */

test('a card climbs one box per Gekend, with the matching waits', () => {
  const rows = [
    row('2026-10-01', 'gekend'), // -> 2, due +3
    row('2026-10-04', 'gekend'), // -> 3, due +7
    row('2026-10-11', 'gekend'), // -> 4, due +14
    row('2026-10-25', 'gekend'), // -> 5, due +28 (on the clock-change Sunday)
  ];
  const s = foldCard(CARD, rows);
  assert.equal(s.box, 5);
  assert.equal(s.due, '2026-11-22');
  assert.equal(s.n_reviews, 4);
  assert.equal(s.last_day, '2026-10-25');
  assert.equal(foldCard(CARD, [...rows, row('2026-11-22', 'gekend')]).box, 6);
  assert.equal(foldCard(CARD, [...rows, row('2026-11-22', 'gekend')]).due, '2027-01-21');
});

test('Gekend met hint keeps the box but still sets the next due day', () => {
  const s = foldCard(CARD, [row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend'), row('2026-10-11', 'hint')]);
  assert.equal(s.box, 3);
  assert.equal(s.due, '2026-10-18');
});

test('Niet gekend sends it back to Doos 1, due tomorrow, and counts a lapse', () => {
  const s = foldCard(CARD, [row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend'), row('2026-10-11', 'niet')]);
  assert.equal(s.box, 1);
  assert.equal(s.due, '2026-10-12');
  assert.equal(s.lapses, 1);
});

test('herhaling rows never change the box', () => {
  const s = foldCard(CARD, [
    row('2026-10-11', 'niet'),
    row('2026-10-11', 'gekend', { mode: 'herhaling' }),
    row('2026-10-11', 'gekend', { mode: 'herhaling' }),
  ]);
  assert.equal(s.box, 1);
  assert.equal(s.due, '2026-10-12');
  assert.equal(s.n_reviews, 1);
});

test('an undo row cancels the row it points at, and is itself skipped', () => {
  const first = row('2026-10-01', 'gekend');
  const oops = row('2026-10-04', 'niet');
  const undo = row('2026-10-04', 'undo', { undoes: oops.id });
  const redo = row('2026-10-04', 'gekend');
  const s = foldCard(CARD, [first, oops, undo, redo]);
  assert.equal(s.box, 3);
  assert.equal(s.due, '2026-10-11');
  assert.equal(s.n_reviews, 2);
  assert.equal(s.lapses, 0);
});

test('undoRow points at its target and keeps its mode', () => {
  const target = row('2026-10-04', 'niet', { mode: 'sessie' });
  const u = undoRow(target, new Date('2026-10-04T20:00:10Z'), 'u-1');
  assert.equal(u.result, 'undo');
  assert.equal(u.undoes, target.id);
  assert.equal(u.card_id, CARD);
  assert.equal(u.mode, 'sessie');
  assert.equal(foldCard(CARD, [target, u]).box, 0);
});

test('quiz_fout: box unchanged, due = the quiz day + 1 (also for a new card)', () => {
  const climbed = [row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend'), row('2026-10-11', 'gekend')];
  const s = foldCard(CARD, [...climbed, row('2026-10-13', 'quiz_fout', { mode: 'quiz' })]);
  assert.equal(s.box, 4);
  assert.equal(s.due, '2026-10-14');

  const fresh = foldCard(CARD, [row('2026-10-13', 'quiz_fout', { mode: 'quiz' })]);
  assert.equal(fresh.box, 0);
  assert.equal(fresh.due, '2026-10-14');
  assert.equal(fresh.n_reviews, 1, 'card_states() counts it as well');
});

test('"Opnieuw leren" (handmatig) puts any card in Doos 1', () => {
  const rows = [row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend'), row('2026-10-11', 'gekend')];
  const s = foldCard(CARD, [...rows, row('2026-10-12', 'opnieuw', { mode: 'handmatig' })]);
  assert.equal(s.box, 1);
  assert.equal(s.due, '2026-10-13');
});

test('rows are replayed by reviewed_at, whatever the string format, then by id', () => {
  // The same instant written by the phone and echoed by the server differ as strings.
  const a = row('2026-10-11', 'niet', { reviewed_at: '2026-10-11T20:00:00.500+00:00' });
  const b = row('2026-10-11', 'gekend', { reviewed_at: '2026-10-11T20:00:00.900123+00:00' });
  const c = row('2026-10-11', 'gekend', { reviewed_at: '2026-10-11T20:00:00.700Z' });
  // a (niet) -> c (gekend: 1 -> 2) -> b (gekend: 2 -> 3)
  assert.equal(foldCard(CARD, [b, c, a]).box, 3);
  assert.equal(foldCard(CARD, [c, a, b]).box, 3);

  const t = '2026-10-12T20:00:00.000Z';
  const x = row('2026-10-12', 'niet', { id: 'aaaa', reviewed_at: t });
  const y = row('2026-10-12', 'gekend', { id: 'bbbb', reviewed_at: t });
  assert.equal(foldCard(CARD, [y, x]).box, 2, 'same instant: id aaaa (niet) before bbbb');
});

test('beforeDay gives the state at the start of the day; undo of any day still counts', () => {
  const y1 = row('2026-10-24', 'gekend');
  const y2 = row('2026-10-24', 'niet', { reviewed_at: '2026-10-25T01:59:00.000Z' }); // 03:59, still the 24th
  const undoNextDay = row('2026-10-25', 'undo', { undoes: y2.id, reviewed_at: '2026-10-25T03:00:05.000Z' });
  const today = row('2026-10-25', 'gekend');
  const rows = [y1, y2, undoNextDay, today];
  const start = foldCard(CARD, rows, { beforeDay: '2026-10-25' });
  assert.equal(start.box, 2);
  assert.equal(start.due, '2026-10-27');
  assert.equal(foldCard(CARD, rows).box, 3);
});

test('foldAll agrees with foldCard and returns new cards for cards without rows', () => {
  const rows = [
    row('2026-10-01', 'gekend'),
    row('2026-10-01', 'hint', { card_id: OTHER }),
    row('2026-10-02', 'niet', { card_id: OTHER }),
    row('2026-10-04', 'gekend'),
  ];
  const all = foldAll([CARD, OTHER, 'none'], rows);
  assert.deepEqual(all.get(CARD), foldCard(CARD, rows));
  assert.deepEqual(all.get(OTHER), foldCard(OTHER, rows));
  assert.deepEqual(all.get('none'), newState('none'));
  assert.equal(all.get(OTHER)!.box, 1);
});

test('custom wait days from settings are used', () => {
  const waits = [2, 4, 8, 16, 32, 64];
  const s = foldCard(CARD, [row('2026-10-01', 'gekend')], { waits });
  assert.equal(s.due, '2026-10-05');
});

/**
 * A straight transcription of private.leitner_step (0003_functions.sql), state
 * {box, due, n}. Random histories must fold to the same result, so the app and
 * card_states() can never disagree about a card.
 */
function sqlFold(rows: Review[], waits = [1, 3, 7, 14, 28, 60]) {
  const undone = new Set(rows.filter((r) => r.result === 'undo').map((r) => r.undoes));
  const eff = rows
    .filter((r) => r.result !== 'undo' && r.mode !== 'herhaling' && !undone.has(r.id))
    .sort((a, b) => Date.parse(a.reviewed_at) - Date.parse(b.reviewed_at) || (a.id < b.id ? -1 : 1));
  let s: [number, string | null, number] = [0, null, 0];
  for (const r of eff) {
    const nb =
      r.result === 'gekend' ? (s[0] === 0 ? 2 : Math.min(s[0] + 1, 6))
      : r.result === 'hint' ? (s[0] === 0 ? 1 : s[0])
      : r.result === 'niet' || r.result === 'opnieuw' ? 1
      : s[0];
    const due = addDays(r.day, r.result === 'quiz_fout' ? 1 : waits[Math.max(nb, 1) - 1]);
    s = [nb, due, s[2] + 1];
  }
  return s;
}

test('random histories fold exactly like the SQL step function', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const results: ReviewResult[] = ['gekend', 'gekend', 'gekend', 'hint', 'niet', 'opnieuw', 'quiz_fout'];
  for (let trial = 0; trial < 300; trial++) {
    const rows: Review[] = [];
    let day = '2026-09-21';
    const n = 1 + Math.floor(rand() * 14);
    for (let i = 0; i < n; i++) {
      day = addDays(day, Math.floor(rand() * 10));
      const result = results[Math.floor(rand() * results.length)];
      const mode: ReviewMode = result === 'quiz_fout' ? 'quiz' : rand() < 0.15 ? 'herhaling' : 'sessie';
      rows.push(row(day, result, { mode }));
      if (rand() < 0.1) rows.push(row(day, 'undo', { undoes: rows[rows.length - 1].id, mode }));
    }
    const shuffled = [...rows].sort(() => rand() - 0.5);
    const mine = foldCard(CARD, shuffled);
    const theirs = sqlFold(rows);
    assert.deepEqual([mine.box, mine.due, mine.n_reviews], theirs, `trial ${trial}`);
  }
});

/* ---- previews for the two buttons ---- */

test('button previews: a new card', () => {
  const p = previewButtons({ box: 0 }, 0, '2026-10-25');
  assert.deepEqual(
    [p.red.label, p.red.sub, p.red.box, p.red.due],
    ['Niet gekend', 'terug naar Doos 1', 1, '2026-10-26'],
  );
  assert.deepEqual(
    [p.green.label, p.green.sub, p.green.box, p.green.due, p.green.result],
    ['Gekend', 'naar Doos 2', 2, '2026-10-28', 'gekend'],
  );
  const h = previewButtons({ box: 0 }, 1, '2026-10-25');
  assert.deepEqual([h.green.label, h.green.sub, h.green.box, h.green.result], ['Gekend met hint', 'naar Doos 1', 1, 'hint']);
});

test('button previews: Doos 3 without and with a hint (the mockup)', () => {
  const p = previewButtons({ box: 3 }, 0, '2026-10-25');
  assert.deepEqual([p.green.label, p.green.sub, p.green.days, p.green.due], ['Gekend', 'naar Doos 4', 14, '2026-11-08']);
  for (const hints of [1, 2, 3]) {
    const h = previewButtons({ box: 3 }, hints, '2026-10-25');
    assert.deepEqual([h.green.label, h.green.sub, h.green.box, h.green.days], ['Gekend met hint', 'blijft in Doos 3', 3, 7]);
  }
});

test('button previews: Doos 5 and Gekend', () => {
  assert.equal(previewButtons({ box: 5 }, 0, '2026-10-25').green.sub, 'naar Gekend');
  assert.equal(previewButtons({ box: 5 }, 0, '2026-10-25').green.days, 60);
  assert.equal(previewButtons({ box: 6 }, 0, '2026-10-25').green.sub, 'blijft Gekend');
  assert.equal(previewButtons({ box: 6 }, 2, '2026-10-25').green.sub, 'blijft Gekend');
  assert.equal(previewButtons({ box: 6 }, 0, '2026-10-25').red.sub, 'terug naar Doos 1');
});

test('every preview matches what the fold then does', () => {
  const today = '2027-03-27';
  for (const box of [0, 1, 2, 3, 4, 5, 6] as Box[]) {
    for (const hints of [0, 1, 2, 3]) {
      const p = previewButtons({ box }, hints, today);
      const start = { ...newState(CARD), box };
      for (const b of [p.red, p.green]) {
        const after = step(start, { result: b.result, day: today });
        assert.equal(after.box, b.box, `box ${box}, hints ${hints}, ${b.label}`);
        assert.equal(after.due, b.due, `due ${box}, hints ${hints}, ${b.label}`);
      }
    }
  }
});

test('greenResult and the hint ladder', () => {
  assert.equal(greenResult(0), 'gekend');
  assert.equal(greenResult(2), 'hint');
  assert.equal(hintButtonLabel(0), 'Hint (1/3)');
  assert.equal(hintButtonLabel(1), 'Nog een hint (2/3)');
  assert.equal(hintButtonLabel(2), 'Laatste hint (3/3)');
  assert.equal(hintButtonLabel(3), null);
});

test('box labels and counts', () => {
  assert.deepEqual([0, 1, 5, 6].map((b) => boxLabel(b as Box)), ['Nieuw', 'Doos 1', 'Doos 5', 'Gekend']);
  const states = foldAll([CARD, OTHER, 'x'], [row('2026-10-01', 'gekend'), row('2026-10-01', 'niet', { card_id: OTHER })]);
  assert.deepEqual(boxCounts([CARD, OTHER, 'x'], states), { 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 });
});

/* ---- making rows ---- */

test('reviewRow stamps the study day with the 04:00 rollover and clamps values', () => {
  const r = reviewRow(
    { card_id: CARD, result: 'hint', mode: 'sessie', hints_used: 7, ms: -5 },
    new Date('2026-10-25T02:30:00Z'), // 03:30 CET on the long night
    'id-1',
  );
  assert.equal(r.day, '2026-10-24');
  assert.equal(r.hints_used, 3);
  assert.equal(r.ms, 0);
  assert.equal(r.undoes, null);
  assert.equal(r.reviewed_at, '2026-10-25T02:30:00.000Z');
  assert.match(reviewRow({ card_id: CARD, result: 'gekend', mode: 'sessie' }).id, /^[0-9a-f-]{36}$/);
});

/* ---- edge cases from the adversarial review (26/10) ---- */

test('a herhaling "Niet gekend" never sends a card back to Doos 1', () => {
  const rows = [row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend'), row('2026-10-11', 'gekend')]; // Doos 4
  const s = foldCard(CARD, [...rows, row('2026-10-25', 'niet', { mode: 'herhaling' })]);
  assert.equal(s.box, 4);
  assert.equal(s.due, '2026-10-25', 'due stays as the last counting row set it');
  assert.equal(s.lapses, 0);
});

test('after a quiz_fout the next Gekend climbs one box with the normal wait', () => {
  const rows = [
    row('2026-10-01', 'gekend'), // Doos 2
    row('2026-10-04', 'gekend'), // Doos 3, due 11/10
    row('2026-10-05', 'quiz_fout', { mode: 'quiz' }), // due 06/10, still Doos 3
    row('2026-10-06', 'gekend'), // Doos 4, due 20/10
  ];
  const s = foldCard(CARD, rows);
  assert.equal(s.box, 4);
  assert.equal(s.due, '2026-10-20');
});

test('a quiz_fout pulls a far due day forward to tomorrow, and an earlier due day back to tomorrow', () => {
  const far = foldCard(CARD, [...[row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend')], row('2026-10-05', 'quiz_fout', { mode: 'quiz' })]);
  assert.equal(far.due, '2026-10-06');
  const overdue = foldCard(CARD, [row('2026-10-01', 'niet'), row('2026-10-09', 'quiz_fout', { mode: 'quiz' })]);
  assert.equal(overdue.box, 1);
  assert.equal(overdue.due, '2026-10-10');
});

test('undoing a "Niet gekend" restores the box and the lapse count; the redo then counts', () => {
  const up = [row('2026-10-01', 'gekend'), row('2026-10-04', 'gekend')]; // Doos 3
  const oops = row('2026-10-11', 'niet');
  const undo = row('2026-10-11', 'undo', { undoes: oops.id });
  const s = foldCard(CARD, [...up, oops, undo]);
  assert.equal(s.box, 3);
  assert.equal(s.lapses, 0);
  assert.equal(s.due, '2026-10-11', 'back to the due day before the mistake');
  const hint = row('2026-10-11', 'hint');
  assert.equal(foldCard(CARD, [...up, oops, undo, hint]).box, 3);
});

test('undo rows only cancel their own target, even for another card with the same day', () => {
  const mine = row('2026-10-11', 'gekend');
  const theirs = row('2026-10-11', 'gekend', { card_id: OTHER });
  const undoTheirs = row('2026-10-11', 'undo', { card_id: OTHER, undoes: theirs.id });
  const all = [mine, theirs, undoTheirs];
  const states = foldAll([CARD, OTHER], all);
  assert.equal(states.get(CARD)!.box, 2);
  assert.equal(states.get(OTHER)!.box, 0);
});
