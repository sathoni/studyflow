/**
 * Home (SPEC-v3 §2 R1): the greeting with today's ring and the week's bars,
 * a new session quiz, today's two lists (🌅 Herhaling at 7:00 and 🌙 Nieuwe
 * kaartjes in the evening, the one for now on top, his wish of 29/10), the
 * instruments for the daytime and a chapter-quiz suggestion. The course list
 * lives only on the Vakken tab (his wish, 26/10: Home must feel calm).
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { emptyState, questionsLabel, ring } from '../ui/parts.ts';
import { ROLLOVER_HOUR, brusselsClock, greeting } from '../lib/dates.ts';
import { readProfile } from '../lib/model.ts';
import { cardsLabel, minutesLabel, tomorrowQueue, type QueuePart } from '../lib/queue.ts';
import { queueInput } from '../lib/data.ts';
import { homeQuizSuggestion } from '../lib/quiz.ts';
import { dueInstruments } from '../lib/instruments.ts';
import { streak, weekBars } from '../lib/stats.ts';
import type { PageEnv } from './shell.ts';
import { banner, openScoreSheet, quizMinutes, tomorrowLine } from './common.ts';

/** "Overdag" stays open or closed while the app is open. */
let overdagOpen = false;

export function renderHome(env: PageEnv): Node {
  const { ctx, s, d } = env;
  const suggestion = homeQuizSuggestion(d.qdata);

  return h(
    'div',
    { class: 'home' },
    h(
      'header',
      { class: 'home-head' },
      h('span', { class: 'brand' }, h('span', { class: 'brand-logo', 'aria-hidden': 'true' }), h('span', { class: 'brand-name', text: 'StudyFlow' })),
      ctx.mode === 'demo' ? h('span', { class: 'demo-pill', text: 'Demo' }) : null,
    ),
    banner(env),
    greetingCard(env),
    suggestion?.kind === 'sessie' ? sessionQuizCard(env, suggestion.entry.quiz.id, suggestion.entry.quiz.title, suggestion.entry.questions) : null,
    todayLists(env),
    overdag(env),
    suggestion?.kind === 'hoofdstuk' ? chapterQuizRow(env, suggestion.entry.chapter.id, suggestion.label, suggestion.entry.questions) : null,
    s.courses.length > 0
      ? null
      : emptyState('cloudCheck', 'Nog niets binnen', 'Je vakken en kaartjes komen vanzelf binnen zodra je iPhone online is.'),
  );
}

function greetingCard(env: PageEnv): HTMLElement {
  const { s, d } = env;
  const q = d.queue;
  const name = readProfile(s.settings).name;
  const days = streak(s.reviews, s.today);
  let line = 'Kleine stappen, grote resultaten.';
  if (q.total > 0 && q.remaining.length === 0) line = 'Klaar voor vandaag. Knap gedaan!';
  else if (q.doneCount > 0) line = `Nog ${q.remaining.length} te gaan. Je bent goed bezig.`;
  else if (days >= 2) line = `${days} dagen op rij. Hou vol!`;

  const bars = weekBars(s.reviews, s.today);
  const max = Math.max(1, ...bars.map((b) => b.count));
  return h(
    'section',
    { class: 'card greet' },
    h(
      'div',
      { class: 'greet-top' },
      h('div', { class: 'greet-text' }, h('h2', { class: 'greet-title', text: `${greeting()}, ${name} 👋` }), h('p', { class: 'greet-sub', text: line })),
      ring(d.live.length === 0 ? 0 : q.progress, 66),
    ),
    h(
      'div',
      { class: 'week-bars', role: 'img', 'aria-label': `Kaartjes per dag deze week: ${bars.map((b) => `${b.label} ${b.count}`).join(', ')}` },
      bars.map((b) =>
        h(
          'span',
          { class: `wbar${b.isToday ? ' today' : ''}${b.future ? ' future' : ''}${b.count > 0 ? ' on' : ''}` },
          h('span', { class: 'wbar-track' }, h('i', { style: `height:${b.count > 0 ? Math.max(22, Math.round((b.count / max) * 100)) : 0}%` })),
          h('span', { class: 'wbar-label', text: b.label }),
        ),
      ),
    ),
  );
}

function sessionQuizCard(env: PageEnv, quizId: string, title: string, n: number): HTMLElement {
  const start = () => env.go(`quizrun/sessie/${quizId}`);
  return h(
    'section',
    { class: 'card quiz-new', role: 'button', tabindex: '0', on: { click: start, keydown: (e: KeyboardEvent) => (e.key === 'Enter' ? start() : undefined) } },
    h('span', { class: 'quiz-new-icon', html: icon('sparkle', 22) }),
    h(
      'span',
      { class: 'quiz-new-text' },
      h('span', { class: 'quiz-new-label', text: 'Nieuwe quiz' }),
      h('span', { class: 'quiz-new-title', text: title }),
      h('span', { class: 'quiz-new-meta', text: `${questionsLabel(n)} · ${quizMinutes(n)}` }),
    ),
    h('span', { class: 'btn btn-primary btn-small', text: 'Start' }),
  );
}

type ListKind = 'review' | 'new';

/** The two lists of the day: 'review' = 🌅 Herhaling at 7:00, 'new' = 🌙 Nieuwe kaartjes in the evening. */
const LISTS: Record<ListKind, { route: string; kicker: string; title: string; icon: string; reason: string; empty: string }> = {
  review: {
    route: 'sessie/herhaling',
    kicker: '🌅 Ochtend · 7:00',
    title: 'Herhaling',
    icon: 'sun',
    reason: 'Kaartjes uit doos 1 en hoger die vandaag terugkomen.',
    empty: 'Geen herhaling vandaag',
  },
  new: {
    route: 'sessie/nieuw',
    kicker: '🌙 Avond · tot je gaat slapen',
    title: 'Nieuwe kaartjes',
    icon: 'moon',
    reason: 'Eerst wat je vandaag en gisteren studeerde.',
    empty: 'Geen nieuwe kaartjes vandaag',
  },
};

const isOpen = (p: QueuePart) => p.remaining.length + p.repeats.length > 0;

/**
 * Today's two lists, the one for now on top: before noon the morning list,
 * after noon the evening list. Both stay open all day; a finished list
 * shrinks to one line.
 */
function todayLists(env: PageEnv): HTMLElement[] {
  const { s, d } = env;
  const q = d.queue;

  if (d.live.length === 0) {
    return [
      h(
        'section',
        { class: 'card hero' },
        h('div', { class: 'hero-head' }, h('h2', { text: 'Vandaag overhoren' }), h('span', { class: 'hero-icon', html: icon('courses', 20) })),
        h('p', { class: 'hero-meta', text: 'Nog geen kaartjes' }),
        h('p', { class: 'hero-reason', text: 'Na je volgende les of zelfstudie komen ze hier vanzelf binnen.' }),
      ),
    ];
  }

  // Both lists done (or nothing at all today).
  if (!isOpen(q.parts.review) && !isOpen(q.parts.new)) {
    return [
      h(
        'section',
        { class: 'card hero hero-done' },
        h('div', { class: 'hero-head' }, h('h2', { text: 'Vandaag overhoren' }), h('span', { class: 'hero-icon', html: icon('courses', 20) })),
        h('p', { class: 'hero-done-title' }, h('span', { class: 'hero-check', html: icon('checkCircle', 26) }), q.total > 0 ? 'Klaar voor vandaag' : 'Niets te overhoren vandaag'),
        h('p', { class: 'hero-reason', text: tomorrowLine(tomorrowQueue(queueInput(s))) }),
        h(
          'div',
          { class: 'hero-actions' },
          h('button', { class: 'btn btn-soft', type: 'button', on: { click: () => env.go('quiz') } }, h('span', { html: icon('quiz', 18) }), 'Quiz'),
          h('button', { class: 'btn btn-soft', type: 'button', on: { click: () => env.go('vakken') } }, h('span', { html: icon('courses', 18) }), 'Extra oefenen'),
        ),
      ),
    ];
  }

  const hour = brusselsClock(Date.now()).hour;
  const order: ListKind[] = hour >= ROLLOVER_HOUR && hour < 12 ? ['review', 'new'] : ['new', 'review'];
  const open = order.filter((k) => isOpen(q.parts[k]));
  const closed = order.filter((k) => !isOpen(q.parts[k]));
  return [...open.map((k, i) => listCard(env, k, i === 0)), ...closed.map((k) => listDone(k, q.parts[k].items.length > 0))];
}

function listCard(env: PageEnv, kind: ListKind, primary: boolean): HTMLElement {
  const { d } = env;
  const q = d.queue;
  const part = q.parts[kind];
  const meta = LISTS[kind];
  const counts = new Map<string, number>();
  for (const i of part.remaining) counts.set(i.card.course_id, (counts.get(i.card.course_id) ?? 0) + 1);
  const left = part.remaining.length;
  const repeats = part.repeats.length;
  const label = left === 0 ? `Opnieuw · nog ${repeats}` : part.doneCount > 0 ? `Ga verder · nog ${left}` : 'Start';
  // The day plan's reason ("BR en OR (vandaag gestudeerd)") belongs to the evening list.
  const reason = kind === 'new' && q.plan.reason ? q.plan.reason : meta.reason;

  return h(
    'section',
    { class: `card hero${primary ? '' : ' hero-second'}` },
    h('p', { class: 'hero-kicker', text: meta.kicker }),
    h('div', { class: 'hero-head' }, h('h2', { text: meta.title }), h('span', { class: 'hero-icon', html: icon(meta.icon, 20) })),
    h('p', { class: 'hero-meta', text: `${minutesLabel(part.remainingSec || repeats * q.timing.reviewSec)} · ${cardsLabel(left || repeats)}` }),
    left > 0
      ? h(
          'div',
          { class: 'chips' },
          part.courseChips
            .filter((id) => counts.has(id))
            .map((id) => {
              const course = d.courses.get(id);
              return h(
                'span',
                { class: 'course-chip', style: `--cc:${course?.color ?? '#2F6BFF'}` },
                h('i', { class: 'dot' }),
                `${id} ${counts.get(id)}`,
              );
            }),
        )
      : null,
    h('p', { class: 'hero-reason', text: reason }),
    part.doneCount > 0 && left > 0 ? h('div', { class: 'hero-progress' }, h('i', { style: `width:${Math.round(part.progress * 100)}%` })) : null,
    h(
      'button',
      { class: `btn ${primary ? 'btn-primary' : 'btn-soft'} btn-big btn-block`, type: 'button', on: { click: () => env.go(meta.route) } },
      h('span', { html: icon('play', 18) }),
      label,
    ),
  );
}

/** A finished (or empty) list: one quiet line. */
function listDone(kind: ListKind, had: boolean): HTMLElement {
  const meta = LISTS[kind];
  return h(
    'section',
    { class: 'card list-done' },
    h('span', { class: 'list-done-icon', html: icon('checkCircle', 22) }),
    h('span', { class: 'list-done-text' }, h('b', { text: had ? `${meta.title} klaar` : meta.empty }), h('small', { text: meta.kicker })),
  );
}

function overdag(env: PageEnv): HTMLElement | null {
  const { ctx, s, d } = env;
  const due = dueInstruments(s.instruments, s.instrumentReviews, s.today, d.queue.plan.courseOrder);
  if (due.length === 0 || due.every((x) => x.doneToday)) return null;
  const open = due.filter((x) => !x.doneToday);
  const minutes = open.reduce((sum, x) => sum + (x.instrument.minutes || 10), 0);

  const list = h(
    'div',
    { class: 'overdag-list', hidden: !overdagOpen },
    due.map((x) => {
      const course = d.courses.get(x.instrument.course_id);
      return h(
        'div',
        { class: `overdag-item${x.doneToday ? ' done' : ''}` },
        h('span', { class: 'dot', style: `--cc:${course?.color ?? '#2F6BFF'}` }),
        h(
          'span',
          { class: 'overdag-main' },
          h('span', { class: 'overdag-title', text: x.instrument.title }),
          h('span', { class: 'overdag-sub', text: `${x.instrument.course_id} · ±${x.instrument.minutes || 10} min` }),
        ),
        x.instrument.notion_url
          ? h('a', { class: 'link-pill', href: x.instrument.notion_url, target: '_blank', rel: 'noopener' }, 'Notion', h('span', { html: icon('external', 13) }))
          : null,
        x.doneToday
          ? h('span', { class: 'done-pill' }, h('span', { html: icon('check', 13) }), 'Gedaan')
          : h('button', { class: 'btn btn-soft btn-small', type: 'button', text: 'Gedaan', on: { click: () => openScoreSheet(ctx, x, () => env.redraw()) } }),
      );
    }),
  );

  const toggle = h(
    'button',
    {
      class: 'overdag-head',
      type: 'button',
      'aria-expanded': String(overdagOpen),
      on: {
        click: () => {
          overdagOpen = !overdagOpen;
          list.hidden = !overdagOpen;
          toggle.setAttribute('aria-expanded', String(overdagOpen));
        },
      },
    },
    h('span', { class: 'overdag-icon', html: icon('sun', 20) }),
    h(
      'span',
      { class: 'overdag-head-text' },
      h('b', { text: 'Overdag' }),
      h('small', { text: `${open.length === 1 ? '1 instrument' : `${open.length} instrumenten`} · ±${minutes} min · op papier` }),
    ),
    h('span', { class: 'chev', html: icon('chevronDown', 18) }),
  );
  return h('section', { class: 'card overdag' }, toggle, list);
}

function chapterQuizRow(env: PageEnv, chapterId: string, label: string, n: number): HTMLElement {
  return h(
    'section',
    { class: 'card suggest', role: 'button', tabindex: '0', on: { click: () => env.go(`quizrun/hoofdstuk/${chapterId}`) } },
    h('span', { class: 'suggest-icon', html: icon('sealCheck', 22) }),
    h('span', { class: 'suggest-text' }, h('small', { text: 'Hoofdstuk af' }), h('b', { text: label }), h('span', { class: 'suggest-meta', text: quizMinutes(n) })),
    h('span', { class: 'btn btn-primary btn-small', text: 'Quiz' }),
  );
}
