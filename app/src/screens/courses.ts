/**
 * Vakken (SPEC-v3 §2 R2): the list of courses, a course page with the tabs
 * Hoofdstukken · Kaartjes · Mini-quiz · Instrumenten and "Verder studeren",
 * and a chapter page with its cards and its chapter quiz.
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { chaptersLabel, courseTile, courseVars, emptyState, iconButton, pageTitle, pctLabel, progressBar, questionsLabel } from '../ui/parts.ts';
import type { Card, Chapter, Course } from '../lib/model.ts';
import { hasQuizzes } from '../lib/model.ts';
import { cardsLabel, forCourse, studyRound } from '../lib/queue.ts';
import { queueInput } from '../lib/data.ts';
import { chapterQuizList, courseQuizList, isFinished } from '../lib/quiz.ts';
import { foldInstrument } from '../lib/instruments.ts';
import { boxSpread, SPREAD_LABELS } from '../lib/stats.ts';
import type { PageEnv } from './shell.ts';
import { cardRow, courseRow, instrumentNext, openScoreSheet, quizMinutes } from './common.ts';
import { chapterCode, chaptersOf, shareOf } from './derive.ts';
import { openCardPreview } from './preview.ts';

/* ------------------------------------------------------------------ *
 * Vakken
 * ------------------------------------------------------------------ */

export function renderVakken(env: PageEnv): Node {
  const { s, d } = env;
  const today = new Map<string, number>();
  for (const i of d.queue.remaining) today.set(i.card.course_id, (today.get(i.card.course_id) ?? 0) + 1);
  return h(
    'div',
    { class: 'vakken' },
    pageTitle('Vakken'),
    h('p', { class: 'page-lead', text: `${s.courses.length} vakken · ${cardsLabel(d.live.length)}` }),
    h(
      'div',
      { class: 'list' },
      s.courses.map((c) => courseRow(env, c, today.get(c.id) ? h('span', { class: 'today-tag', text: `${today.get(c.id)} vandaag` }) : null)),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Course page
 * ------------------------------------------------------------------ */

type CourseTab = 'hoofdstukken' | 'kaartjes' | 'quiz' | 'instrumenten';

const TAB_LABELS: Record<CourseTab, string> = {
  hoofdstukken: 'Hoofdstukken',
  kaartjes: 'Kaartjes',
  quiz: 'Mini-quiz',
  instrumenten: 'Instrumenten',
};

export function renderCourse(env: PageEnv): Node {
  const { s, d, params } = env;
  const course = d.courses.get(params[0] ?? '');
  if (!course) return notFound(env, 'Dit vak bestaat niet (meer).');

  const tabs: CourseTab[] = hasQuizzes(course.id)
    ? ['hoofdstukken', 'kaartjes', 'quiz', 'instrumenten']
    : ['hoofdstukken', 'kaartjes', 'instrumenten'];
  const tab = (tabs.includes(params[1] as CourseTab) ? params[1] : 'hoofdstukken') as CourseTab;
  const cards = d.byCourse.get(course.id) ?? [];
  const chapters = chaptersOf(s, course.id);
  const withCards = chapters.filter((ch) => (d.byChapter.get(ch.id)?.length ?? 0) > 0);
  const share = shareOf(d, cards);

  let body: Node;
  if (tab === 'kaartjes') body = cardsTab(env, chapters);
  else if (tab === 'quiz') body = quizTab(env, course);
  else if (tab === 'instrumenten') body = instrumentsTab(env, course);
  else body = chaptersTab(env, chapters);

  return h(
    'div',
    { class: 'course-page', style: courseVars(course) },
    subnav(env, 'vakken'),
    h(
      'header',
      { class: 'course-head' },
      courseTile(course, 'lg'),
      h(
        'div',
        { class: 'course-head-main' },
        h('h1', { class: 'course-title', text: course.name }),
        h('p', { class: 'course-meta', text: cards.length ? `${cardsLabel(cards.length)} · ${chaptersLabel(withCards.length)}` : 'Nog geen kaartjes' }),
        h('div', { class: 'bar-row' }, progressBar(share), h('span', { class: 'bar-pct', text: pctLabel(share) })),
      ),
    ),
    h(
      'div',
      { class: 'segmented', role: 'tablist', 'aria-label': 'Onderdelen van het vak' },
      tabs.map((t) =>
        h('button', {
          class: `seg${t === tab ? ' active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': String(t === tab),
          text: TAB_LABELS[t],
          on: { click: () => env.replace(`vak/${course.id}/${t}`) },
        }),
      ),
    ),
    h('div', { class: 'tab-body', role: 'tabpanel' }, body),
    studyButton(env, course),
  );
}

function chaptersTab(env: PageEnv, chapters: Chapter[]): Node {
  const { d } = env;
  if (chapters.length === 0) return emptyState('book', 'Nog geen hoofdstukken', 'Ze verschijnen zodra je eerste kaartjes binnen zijn.');
  return h(
    'div',
    { class: 'list' },
    chapters.map((ch, i) => {
      const cards = d.byChapter.get(ch.id) ?? [];
      const share = shareOf(d, cards);
      return h(
        'button',
        { class: 'row-card chapter-row', type: 'button', on: { click: () => env.go(`hoofdstuk/${ch.id}`) } },
        chapterSquare(ch, i),
        h(
          'span',
          { class: 'row-main' },
          h('span', { class: 'row-title', text: ch.title }),
          h(
            'span',
            { class: 'row-sub' },
            `${ch.code} · ${cards.length ? cardsLabel(cards.length) : 'nog geen kaartjes'}`,
            isFinished(ch) ? h('span', { class: 'done-tag' }, h('span', { html: icon('sealCheck', 12) }), 'Hoofdstuk af') : null,
          ),
        ),
        h('span', { class: 'row-pct', text: pctLabel(share) }),
        h('span', { class: 'chev', html: icon('chevronRight', 18) }),
      );
    }),
  );
}

function cardsTab(env: PageEnv, chapters: Chapter[]): Node {
  const { d } = env;
  const groups = chapters
    .map((ch) => ({ ch, cards: d.byChapter.get(ch.id) ?? [] }))
    .filter((g) => g.cards.length > 0);
  if (groups.length === 0) return emptyState('courses', 'Nog geen kaartjes', 'Na je volgende les of zelfstudie komen ze hier vanzelf.');
  const open = (card: Card) => openCardPreview(env, card, () => env.redraw());
  return h(
    'div',
    { class: 'card-groups' },
    groups.map((g) =>
      h(
        'section',
        { class: 'card-group' },
        h('h3', { class: 'group-title', text: `${g.ch.code} · ${g.ch.title}` }),
        h('div', { class: 'card list-card' }, g.cards.map((c) => cardRow(env, c, open))),
      ),
    ),
  );
}

function quizTab(env: PageEnv, course: Course): Node {
  const { d } = env;
  const chapters = chapterQuizList(d.qdata).filter((e) => e.chapter.course_id === course.id);
  const mixed = courseQuizList(d.qdata).find((e) => e.course.id === course.id);
  if (!mixed && chapters.length === 0) return emptyState('quiz', 'Nog geen quizvragen', 'Ze komen samen met je kaartjes binnen.');
  return h(
    'div',
    { class: 'list' },
    mixed
      ? h(
          'button',
          { class: 'row-card quiz-row mixed', type: 'button', on: { click: () => env.go(`quizrun/vak/${course.id}`) } },
          h('span', { class: 'quiz-row-icon', html: icon('lightning', 20) }),
          h(
            'span',
            { class: 'row-main' },
            h('span', { class: 'row-title', text: 'Gemengde quiz (heel het vak)' }),
            h('span', { class: 'row-sub', text: `${questionsLabel(mixed.questions)} uit ${mixed.pool} · alle hoofdstukken door elkaar` }),
          ),
          h('span', { class: 'chev', html: icon('chevronRight', 18) }),
        )
      : null,
    chapters.map((e) =>
      h(
        'button',
        {
          class: `row-card quiz-row${e.highlighted ? ' highlight' : ''}`,
          type: 'button',
          on: { click: () => env.go(`quizrun/hoofdstuk/${e.chapter.id}`) },
        },
        h('span', { class: 'quiz-row-icon', html: icon(e.finished ? 'sealCheck' : 'quiz', 20) }),
        h(
          'span',
          { class: 'row-main' },
          h('span', { class: 'row-title', text: `Quiz ${e.chapter.code} · ${e.chapter.title}` }),
          h(
            'span',
            { class: 'row-sub' },
            e.highlighted ? h('span', { class: 'done-tag', text: 'Hoofdstuk af · doe de hoofdstukquiz' }) : null,
            `${questionsLabel(e.questions)} · ${quizMinutes(e.questions)}${e.last ? ` · laatst ${e.last.correct}/${e.last.total}` : ''}`,
          ),
        ),
        h('span', { class: 'chev', html: icon('chevronRight', 18) }),
      ),
    ),
  );
}

function instrumentsTab(env: PageEnv, course: Course): Node {
  const { ctx, s } = env;
  const list = s.instruments.filter((i) => i.course_id === course.id);
  if (list.length === 0) return emptyState('clipboard', 'Geen overhoor-instrumenten', 'Instrumenten (tabellen en schema’s op papier) staan in Notion bij het hoofdstuk.');
  return h(
    'div',
    { class: 'card list-card' },
    list.map((ins) => {
      const state = foldInstrument(ins.id, s.instrumentReviews);
      const due = state.due === null || state.due <= s.today;
      const doneToday = state.last_day === s.today;
      return h(
        'div',
        { class: 'ins-row' },
        h('span', { class: 'ins-icon', html: icon('clipboard', 20) }),
        h(
          'span',
          { class: 'row-main' },
          h('span', { class: 'row-title', text: ins.title }),
          h('span', { class: `row-sub${due && !doneToday ? ' due' : ''}`, text: `${instrumentNext(state, s.today)} · ±${ins.minutes || 10} min` }),
        ),
        ins.notion_url ? h('a', { class: 'link-pill', href: ins.notion_url, target: '_blank', rel: 'noopener' }, 'Notion', h('span', { html: icon('external', 13) })) : null,
        due && !doneToday
          ? h('button', { class: 'btn btn-soft btn-small', type: 'button', text: 'Gedaan', on: { click: () => openScoreSheet(ctx, { instrument: ins, state }, () => env.redraw()) } })
          : null,
      );
    }),
  );
}

/**
 * The buttons at the bottom of a course page: today's cards of this course
 * ("Verder studeren"), and always a round with the boxes over the whole course
 * ("Overhoor heel het vak"), for days with more time (his wish, 26/10).
 */
function studyButton(env: PageEnv, course: Course): HTMLElement {
  const { s, d } = env;
  const today = forCourse(d.queue, course.id).length + d.queue.repeats.filter((r) => r.item.card.course_id === course.id).length;
  const round = studyRound(queueInput(s), { kind: 'vak', id: course.id });
  const available = round.items.length + round.left;
  const buttons: HTMLElement[] = [];
  if (today > 0) {
    buttons.push(h('button', { class: 'btn btn-primary btn-big btn-block', type: 'button', on: { click: () => env.go(`sessie/${course.id}`) } }, h('span', { html: icon('play', 18) }), `Verder studeren · nog ${today}`));
  }
  if (available > 0) {
    buttons.push(
      h(
        'button',
        { class: `btn ${today > 0 ? 'btn-soft' : 'btn-primary'} btn-big btn-block`, type: 'button', on: { click: () => env.go(`sessie/vak/${course.id}/1`) } },
        h('span', { html: icon('courses', 18) }),
        `Overhoor heel het vak · ${cardsLabel(available)}`,
      ),
    );
  }
  if (buttons.length === 0) {
    buttons.push(h('button', { class: 'btn btn-big btn-block btn-done', type: 'button', disabled: true }, h('span', { html: icon('checkCircle', 18) }), (d.byCourse.get(course.id)?.length ?? 0) > 0 ? 'Alles overlopen voor vandaag' : 'Nog geen kaartjes'));
  }
  return h('div', { class: 'sticky-cta' }, ...buttons);
}

/* ------------------------------------------------------------------ *
 * Chapter page
 * ------------------------------------------------------------------ */

export function renderChapter(env: PageEnv): Node {
  const { s, d, params } = env;
  const chapter = d.chapters.get(params[0] ?? '');
  if (!chapter) return notFound(env, 'Dit hoofdstuk bestaat niet (meer).');
  const course = d.courses.get(chapter.course_id);
  const cards = d.byChapter.get(chapter.id) ?? [];
  const share = shareOf(d, cards);
  const index = chaptersOf(s, chapter.course_id).findIndex((c) => c.id === chapter.id);
  const quiz = chapterQuizList(d.qdata).find((e) => e.chapter.id === chapter.id);
  const spread = boxSpread(cards.map((c) => c.id), d.states);
  const open = (card: Card) => openCardPreview(env, card, () => env.redraw());

  return h(
    'div',
    { class: 'chapter-page', style: courseVars(course) },
    subnav(env, `vak/${chapter.course_id}`),
    h(
      'header',
      { class: 'course-head' },
      chapterSquare(chapter, index, true),
      h(
        'div',
        { class: 'course-head-main' },
        h('h1', { class: 'course-title', text: chapter.title }),
        h('p', { class: 'course-meta', text: `${chapterCode(chapter)} · ${cards.length ? cardsLabel(cards.length) : 'nog geen kaartjes'}` }),
        h('div', { class: 'bar-row' }, progressBar(share), h('span', { class: 'bar-pct', text: pctLabel(share) })),
      ),
    ),
    quiz?.highlighted
      ? h(
          'button',
          { class: 'card suggest', type: 'button', on: { click: () => env.go(`quizrun/hoofdstuk/${chapter.id}`) } },
          h('span', { class: 'suggest-icon', html: icon('sealCheck', 22) }),
          h('span', { class: 'suggest-text' }, h('small', { text: 'Hoofdstuk af' }), h('b', { text: 'Doe de hoofdstukquiz' })),
          h('span', { class: 'chev', html: icon('chevronRight', 18) }),
        )
      : null,
    cards.length > 0 ? spreadCard(spread) : null,
    cards.length > 0
      ? h('div', { class: 'card list-card' }, cards.map((c) => cardRow(env, c, open)))
      : emptyState('courses', 'Nog geen kaartjes in dit hoofdstuk'),
    chapterButtons(env, chapter, quiz && hasQuizzes(chapter.course_id) ? quiz.questions : 0),
  );
}

/**
 * The bottom of a chapter page: overhoren with the boxes (any time, in rounds of
 * 20) and the chapter quiz.
 */
function chapterButtons(env: PageEnv, chapter: Chapter, questions: number): HTMLElement | null {
  const round = studyRound(queueInput(env.s), { kind: 'hoofdstuk', id: chapter.id });
  const available = round.items.length + round.left;
  const buttons: HTMLElement[] = [];
  if (available > 0) {
    buttons.push(
      h(
        'button',
        { class: 'btn btn-primary btn-big btn-block', type: 'button', on: { click: () => env.go(`sessie/hoofdstuk/${chapter.id}/1`) } },
        h('span', { html: icon('courses', 18) }),
        `Overhoor dit hoofdstuk · ${cardsLabel(available)}`,
      ),
    );
  }
  if (questions > 0) {
    buttons.push(
      h(
        'button',
        { class: `btn ${available > 0 ? 'btn-soft' : 'btn-primary'} btn-big btn-block`, type: 'button', on: { click: () => env.go(`quizrun/hoofdstuk/${chapter.id}`) } },
        h('span', { html: icon('quiz', 18) }),
        `Quiz dit hoofdstuk · ${questionsLabel(questions)}`,
      ),
    );
  }
  return buttons.length ? h('div', { class: 'sticky-cta' }, ...buttons) : null;
}

/** The stacked bar Nieuw · D1–D5 · Gekend with its legend. */
export function spreadCard(spread: number[]): HTMLElement {
  const total = spread.reduce((a, b) => a + b, 0) || 1;
  return h(
    'div',
    { class: 'card spread-card' },
    spreadBar(spread),
    h(
      'div',
      { class: 'spread-legend' },
      spread.map((n, box) =>
        n > 0 ? h('span', { class: 'legend-item' }, h('i', { class: `sw box-bg-${box}` }), `${SPREAD_LABELS[box]} ${n}`) : null,
      ),
    ),
    h('span', { class: 'sr-only', text: `${Math.round(((spread[2] + spread[3] + spread[4] + spread[5] + spread[6]) / total) * 100)}% gekend (Doos 2 of hoger)` }),
  );
}

export function spreadBar(spread: number[]): HTMLElement {
  const total = spread.reduce((a, b) => a + b, 0);
  return h(
    'div',
    { class: 'spread-bar', 'aria-hidden': 'true' },
    total === 0 ? null : spread.map((n, box) => (n > 0 ? h('i', { class: `box-bg-${box}`, style: `flex:${n}` }) : null)),
  );
}

function chapterSquare(ch: Chapter, index: number, large = false): HTMLElement {
  const digits = /\d+/.exec(ch.code)?.[0];
  return h('span', { class: `num-square${large ? ' large' : ''}`, text: digits ?? String(index + 1), 'aria-hidden': 'true' });
}

function subnav(env: PageEnv, fallback: string): HTMLElement {
  return h('nav', { class: 'subnav' }, iconButton('chevronLeft', 'Terug', () => env.back(fallback), 'back-btn'));
}

function notFound(env: PageEnv, text: string): Node {
  return h('div', {}, subnav(env, 'vakken'), emptyState('info', text));
}
