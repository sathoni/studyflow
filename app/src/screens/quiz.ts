/**
 * The Quiz tab (SPEC-v3 §2 R7): "Na je studie" (open session quizzes first,
 * then the done ones with their score), "Per hoofdstuk" grouped per course
 * with finished chapters marked, "Gemengd per vak", and the last scores.
 * Business English never appears: it has no mini-quizzes.
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { courseTile, courseVars, emptyState, pageTitle, pctLabel, questionsLabel, sectionTitle } from '../ui/parts.ts';
import { chapterQuizList, courseQuizList, parseScope, runScores, sessionQuizList, type RunScore } from '../lib/quiz.ts';
import { relativeDay } from '../lib/dates.ts';
import type { PageEnv } from './shell.ts';
import { quizMinutes } from './common.ts';
import { chapterCode } from './derive.ts';

export function renderQuiz(env: PageEnv): Node {
  const { s, d } = env;
  const sessions = sessionQuizList(d.qdata);
  const chapters = chapterQuizList(d.qdata);
  const mixed = courseQuizList(d.qdata);
  const scores = runScores(d.qdata).slice(0, 6);

  if (sessions.length === 0 && chapters.length === 0 && mixed.length === 0) {
    return h('div', { class: 'quiz-page' }, pageTitle('Quiz'), emptyState('quiz', 'Nog geen quizzen', 'Na je volgende les of zelfstudie staat hier meteen een mini-quiz klaar.'));
  }

  // "Per hoofdstuk", grouped per course.
  const byCourse = new Map<string, typeof chapters>();
  for (const e of chapters) {
    let list = byCourse.get(e.chapter.course_id);
    if (!list) byCourse.set(e.chapter.course_id, (list = []));
    list.push(e);
  }

  return h(
    'div',
    { class: 'quiz-page' },
    pageTitle('Quiz'),
    h('p', { class: 'page-lead', text: 'Korte quizzen over wat je leerde. Fouten komen morgen terug in je kaartjes.' }),

    sessions.length > 0 ? sectionTitle('Na je studie') : null,
    sessions.length > 0
      ? h(
          'div',
          { class: 'list' },
          sessions.slice(0, 8).map((e) => {
            const course = d.courses.get(e.quiz.course_id);
            const n = e.questions;
            return h(
              'button',
              {
                class: `row-card quiz-row${e.done ? '' : ' fresh'}`,
                type: 'button',
                style: courseVars(course),
                on: { click: () => env.go(`quizrun/sessie/${e.quiz.id}`) },
              },
              h('span', { class: 'quiz-row-icon', html: icon(e.done ? 'quiz' : 'sparkle', 20) }),
              h(
                'span',
                { class: 'row-main' },
                h('span', { class: 'row-title', text: e.quiz.title }),
                h(
                  'span',
                  { class: 'row-sub' },
                  e.done ? null : h('span', { class: 'new-tag', text: 'Nieuw' }),
                  e.done && e.last ? `${e.last.correct}/${e.last.total} · ${relativeDay(e.last.day, s.today)}` : `${questionsLabel(n)} · ${quizMinutes(n)}`,
                ),
              ),
              e.done ? h('span', { class: 'score-pill', text: e.last ? `${e.last.correct}/${e.last.total}` : '' }) : h('span', { class: 'btn btn-primary btn-small', text: 'Start' }),
            );
          }),
        )
      : null,

    byCourse.size > 0 ? sectionTitle('Per hoofdstuk') : null,
    [...byCourse.entries()].map(([courseId, list]) => {
      const course = d.courses.get(courseId);
      return h(
        'section',
        { class: 'quiz-group', style: courseVars(course) },
        h('h3', { class: 'group-title with-tile' }, courseTile(course, 'sm'), course?.name ?? courseId),
        h(
          'div',
          { class: 'card list-card' },
          list.map((e) =>
            h(
              'button',
              { class: `quiz-line${e.highlighted ? ' highlight' : ''}`, type: 'button', on: { click: () => env.go(`quizrun/hoofdstuk/${e.chapter.id}`) } },
              h(
                'span',
                { class: 'row-main' },
                h('span', { class: 'row-title', text: `${e.chapter.code} · ${e.chapter.title}` }),
                h(
                  'span',
                  { class: 'row-sub' },
                  e.finished ? h('span', { class: 'done-tag' }, h('span', { html: icon('sealCheck', 12) }), e.highlighted ? 'Hoofdstuk af · doe de hoofdstukquiz' : 'Hoofdstuk af') : null,
                  `${questionsLabel(e.questions)} uit ${e.pool}`,
                ),
              ),
              e.last ? h('span', { class: 'score-pill', text: `${e.last.correct}/${e.last.total}` }) : null,
              h('span', { class: 'chev', html: icon('chevronRight', 18) }),
            ),
          ),
        ),
      );
    }),

    mixed.length > 0 ? sectionTitle('Gemengd per vak') : null,
    mixed.length > 0
      ? h(
          'div',
          { class: 'list' },
          mixed.map((e) =>
            h(
              'button',
              { class: 'row-card quiz-row', type: 'button', style: courseVars(e.course), on: { click: () => env.go(`quizrun/vak/${e.course.id}`) } },
              courseTile(e.course, 'md'),
              h(
                'span',
                { class: 'row-main' },
                h('span', { class: 'row-title', text: e.course.name }),
                h('span', { class: 'row-sub', text: `Gemengde quiz · ${questionsLabel(e.questions)} uit ${e.pool}${e.average !== null ? ` · gemiddeld ${pctLabel(e.average)}` : ''}` }),
              ),
              h('span', { class: 'chev', html: icon('chevronRight', 18) }),
            ),
          ),
        )
      : null,

    scores.length > 0 ? sectionTitle('Laatste scores') : null,
    scores.length > 0 ? h('div', { class: 'card list-card' }, scores.map((r) => scoreLine(env, r))) : null,
  );
}

function scoreLine(env: PageEnv, r: RunScore): HTMLElement {
  const { s, d } = env;
  const scope = parseScope(r.scope);
  let label = 'Quiz';
  if (scope?.kind === 'sessie') label = d.qdata.quizzes.find((q) => q.id === scope.id)?.title ?? 'Na je studie';
  else if (scope?.kind === 'hoofdstuk') {
    const ch = d.chapters.get(scope.id);
    label = ch ? `Hoofdstukquiz ${chapterCode(ch)}` : 'Hoofdstukquiz';
  } else if (scope?.kind === 'vak') label = `Gemengde quiz ${scope.id}`;
  const share = r.total ? r.correct / r.total : 0;
  return h(
    'div',
    { class: 'score-line' },
    h('span', { class: `score-dot ${share >= 0.8 ? 'good' : share >= 0.5 ? 'mid' : 'bad'}` }),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: label }), h('span', { class: 'row-sub', text: relativeDay(r.day, s.today) })),
    h('b', { class: 'score-value', text: `${r.correct}/${r.total}` }),
  );
}
