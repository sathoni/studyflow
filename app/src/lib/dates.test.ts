/**
 * Study days and calendar maths, across both clock changes.
 *
 *   25/10/2026  03:00 CEST -> 02:00 CET  (at 01:00 UTC; the night has 25 hours)
 *   28/03/2027  02:00 CET  -> 03:00 CEST (at 01:00 UTC; the night has 23 hours)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  brusselsClock,
  daysBetween,
  greeting,
  isDay,
  isSunday,
  longDate,
  minDay,
  relativeDay,
  shortDate,
  studyDay,
  weekDays,
  weekStart,
  weekday,
} from './dates.ts';

test('the study day rolls over at 04:00 Brussels on an ordinary day', () => {
  // 23/10/2026 is CEST (UTC+2).
  assert.equal(studyDay('2026-10-23T22:30:00Z'), '2026-10-23'); // 00:30 on the 24th counts for the 23rd
  assert.equal(studyDay('2026-10-23T01:59:00Z'), '2026-10-22'); // 03:59
  assert.equal(studyDay('2026-10-23T02:01:00Z'), '2026-10-23'); // 04:01
  assert.equal(studyDay('2026-10-23T19:00:00Z'), '2026-10-23'); // 21:00
});

test('00:30 belongs to the evening before', () => {
  // 00:30 CEST on the 24th = 22:30 UTC on the 23rd.
  assert.equal(brusselsClock('2026-10-23T22:30:00Z').date, '2026-10-24');
  assert.equal(studyDay('2026-10-23T22:30:00Z'), '2026-10-23');
});

test('the long night of 25/10/2026 keeps the rollover at 04:00 wall clock', () => {
  assert.equal(studyDay('2026-10-24T23:30:00Z'), '2026-10-24'); // 01:30 CEST
  assert.equal(studyDay('2026-10-25T00:30:00Z'), '2026-10-24'); // 02:30 CEST (first time)
  assert.equal(studyDay('2026-10-25T01:30:00Z'), '2026-10-24'); // 02:30 CET (second time)
  assert.equal(studyDay('2026-10-25T02:30:00Z'), '2026-10-24'); // 03:30 CET: "t - 4h" would say the 25th
  assert.equal(studyDay('2026-10-25T02:59:00Z'), '2026-10-24'); // 03:59 CET
  assert.equal(studyDay('2026-10-25T03:01:00Z'), '2026-10-25'); // 04:01 CET
  assert.equal(brusselsClock('2026-10-25T03:01:00Z').hour, 4);
});

test('the short night of 28/03/2027 keeps the rollover at 04:00 wall clock', () => {
  assert.equal(studyDay('2027-03-28T00:30:00Z'), '2027-03-27'); // 01:30 CET
  assert.equal(studyDay('2027-03-28T01:30:00Z'), '2027-03-27'); // 03:30 CEST
  assert.equal(studyDay('2027-03-28T01:59:00Z'), '2027-03-27'); // 03:59 CEST
  assert.equal(studyDay('2027-03-28T02:01:00Z'), '2027-03-28'); // 04:01 CEST
  assert.equal(studyDay('2027-03-28T02:30:00Z'), '2027-03-28'); // 04:30 CEST: "t - 4h" would say the 27th
});

test('addDays is calendar arithmetic, never milliseconds', () => {
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(addDays('2026-10-20', 14), '2026-11-03'); // Doos 4 across the change
  assert.equal(addDays('2026-10-01', 60), '2026-11-30'); // Gekend across the change
  assert.equal(addDays('2027-03-27', 1), '2027-03-28');
  assert.equal(addDays('2027-03-20', 14), '2027-04-03');
  assert.equal(addDays('2027-03-01', 28), '2027-03-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-11-03', -14), '2026-10-20');
  assert.equal(addDays('2026-10-25', 0), '2026-10-25');
});

test('daysBetween counts calendar days across both changes', () => {
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(daysBetween('2026-10-26', '2026-10-24'), -2);
  assert.equal(daysBetween('2027-03-27', '2027-03-29'), 2);
  assert.equal(daysBetween('2026-09-21', '2027-01-31'), 132);
});

test('a review late in the evening gets the right due date across the change', () => {
  // 22:00 on Tuesday 20/10 (CEST), Doos 4 waits 14 days.
  const day = studyDay('2026-10-20T20:00:00Z');
  assert.equal(day, '2026-10-20');
  assert.equal(addDays(day, 14), '2026-11-03');
  // 23:50 on Saturday 27/03/2027 (CET), Doos 1 waits 1 day: Sunday the 28th.
  const late = studyDay('2027-03-27T22:50:00Z');
  assert.equal(late, '2027-03-27');
  assert.equal(addDays(late, 1), '2027-03-28');
});

test('weeks run Monday to Sunday', () => {
  assert.equal(weekday('2026-10-25'), 6); // the change is on a Sunday
  assert.equal(weekday('2027-03-28'), 6);
  assert.equal(weekday('2026-10-26'), 0);
  assert.equal(weekday('2026-10-23'), 4);
  assert.ok(isSunday('2026-10-25'));
  assert.equal(weekStart('2026-10-25'), '2026-10-19');
  assert.equal(weekStart('2026-10-26'), '2026-10-26');
  assert.deepEqual(weekDays('2026-10-21'), [
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
  ]);
});

test('isDay rejects impossible dates and other shapes', () => {
  assert.ok(isDay('2026-10-25'));
  assert.ok(!isDay('2026-02-30'));
  assert.ok(!isDay('25/10/2026'));
  assert.ok(!isDay(20261025));
});

test('Dutch words for days', () => {
  assert.equal(shortDate('2026-10-23'), 'vr 23/10');
  assert.equal(longDate('2026-11-18'), 'woensdag 18 november');
  assert.equal(relativeDay('2026-10-25', '2026-10-25'), 'vandaag');
  assert.equal(relativeDay('2026-10-26', '2026-10-25'), 'morgen');
  assert.equal(relativeDay('2026-10-27', '2026-10-25'), 'overmorgen');
  assert.equal(relativeDay('2026-11-08', '2026-10-25'), 'over 14 dagen');
  assert.equal(relativeDay('2026-10-24', '2026-10-25'), 'gisteren');
  assert.equal(relativeDay('2026-10-20', '2026-10-25'), '5 dagen geleden');
  assert.equal(minDay(null, '2026-10-25'), '2026-10-25');
  assert.equal(minDay('2026-10-24', '2026-10-25'), '2026-10-24');
});

test('the greeting follows the Brussels clock', () => {
  assert.equal(greeting(Date.parse('2026-10-23T06:00:00Z')), 'Goedemorgen'); // 08:00
  assert.equal(greeting(Date.parse('2026-10-23T12:00:00Z')), 'Goedemiddag'); // 14:00
  assert.equal(greeting(Date.parse('2026-10-23T19:00:00Z')), 'Goedenavond'); // 21:00
  assert.equal(greeting(Date.parse('2026-10-23T23:30:00Z')), 'Goedenavond'); // 01:30
});
