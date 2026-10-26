/**
 * Voortgang (SPEC-v3 §2 R3): streak, cards and minutes this week, % right
 * first time (14 days); per course the box spread, % in Doos 3 or higher,
 * the quiz average with its trend, and "Moeilijkste". No backlog counter.
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { courseTile, courseVars, emptyState, pageTitle, pctLabel, rich } from '../ui/parts.ts';
import { courseQuizList } from '../lib/quiz.ts';
import { boxSpread, firstTryShare, hardestCards, streak, weekCards, weekMinutes } from '../lib/stats.ts';
import { cardsLabel } from '../lib/queue.ts';
import type { Card } from '../lib/model.ts';
import type { PageEnv } from './shell.ts';
import { shareOf } from './derive.ts';
import { spreadBar } from './courses.ts';
import { openCardPreview } from './preview.ts';

export function renderProgress(env: PageEnv): Node {
  const { s, d } = env;
  const days = streak(s.reviews, s.today);
  const acc = firstTryShare(s.reviews, s.today);
  const quiz = new Map(courseQuizList(d.qdata).map((e) => [e.course.id, e]));

  const courses = s.courses.filter((c) => (d.byCourse.get(c.id)?.length ?? 0) > 0);

  return h(
    'div',
    { class: 'progress-page' },
    pageTitle('Voortgang'),
    h(
      'div',
      { class: 'stat-grid' },
      bigStat('streak', 'warm', `${days}`, days === 1 ? 'dag' : 'dagen', 'Studiereeks'),
      bigStat('courses', 'blue', String(weekCards(s.reviews, s.today)), 'kaartjes', 'Deze week'),
      bigStat('timer', 'purple', String(weekMinutes(s.reviews, s.today, s.defaults.est_sec_review)), 'min', 'Tijd deze week'),
      bigStat('target', 'green', acc === null ? '–' : `${Math.round(acc * 100)}%`, '', 'Juist in één keer (14 d)'),
    ),
    courses.length === 0 ? emptyState('progress', 'Nog niets om te tonen', 'Na je eerste kaartjes zie je hier hoe je vooruitgaat.') : null,
    courses.map((course) => {
      const cards = d.byCourse.get(course.id) ?? [];
      const spread = boxSpread(cards.map((c) => c.id), d.states);
      const share = shareOf(d, cards);
      const q = quiz.get(course.id);
      const hard = hardestCards(cards, d.states, d.starred, 3);
      return h(
        'section',
        { class: 'card prog-course', style: courseVars(course) },
        h(
          'div',
          { class: 'prog-head' },
          courseTile(course, 'sm'),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: course.name }), h('span', { class: 'row-sub', text: cardsLabel(cards.length) })),
          h('span', { class: 'prog-pct' }, h('b', { text: pctLabel(share) }), h('small', { text: 'gekend' })),
        ),
        spreadBar(spread),
        h(
          'div',
          { class: 'spread-legend compact' },
          ['Nieuw', 'D1', 'D2', 'D3', 'D4', 'D5', 'Gekend'].map((label, box) =>
            spread[box] > 0 ? h('span', { class: 'legend-item' }, h('i', { class: `sw box-bg-${box}` }), `${label} ${spread[box]}`) : null,
          ),
        ),
        q && q.runs > 0
          ? h(
              'div',
              { class: 'prog-quiz' },
              h('span', { class: 'prog-quiz-label', text: 'Quiz gemiddeld' }),
              h('b', { text: pctLabel(q.average) }),
              q.trend.length >= 2 ? trendLine(q.trend) : null,
              trendWord(q.trend),
            )
          : course.id === 'BE'
            ? null
            : h('div', { class: 'prog-quiz muted' }, h('span', { class: 'prog-quiz-label', text: 'Nog geen quiz gedaan' })),
        hard.length > 0
          ? h(
              'div',
              { class: 'prog-hard' },
              h('span', { class: 'prog-hard-title', text: 'Moeilijkste' }),
              hard.map((c) => hardRow(env, c)),
            )
          : null,
      );
    }),
  );
}

function bigStat(iconName: string, tone: string, value: string, unit: string, label: string): HTMLElement {
  return h(
    'div',
    { class: `stat big tone-${tone}` },
    h('span', { class: 'stat-icon', html: icon(iconName, 18) }),
    h('b', {}, value, unit ? h('small', { text: ` ${unit}` }) : null),
    h('span', { text: label }),
  );
}

/** The last five quiz scores as a small line. */
function trendLine(trend: number[]): HTMLElement {
  const w = 72;
  const hgt = 24;
  const el = h('span', { class: 'sparkline', 'aria-hidden': 'true' });
  if (trend.length === 0) return el;
  const pts = trend.map((v, i) => {
    const x = trend.length === 1 ? w / 2 : (i / (trend.length - 1)) * (w - 6) + 3;
    const y = hgt - 3 - v * (hgt - 6);
    return [x, y];
  });
  el.innerHTML =
    `<svg viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}">` +
    `<polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts.map((p) => p.join(',')).join(' ')}"/>` +
    pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.4" fill="currentColor"/>`).join('') +
    '</svg>';
  return el;
}

function trendWord(trend: number[]): HTMLElement | null {
  if (trend.length < 2) return null;
  const diff = trend[trend.length - 1] - trend[0];
  if (Math.abs(diff) < 0.05) return h('span', { class: 'trend flat', text: 'stabiel' });
  return h('span', { class: `trend ${diff > 0 ? 'up' : 'down'}` }, h('span', { html: icon(diff > 0 ? 'trendUp' : 'trendDown', 14) }), diff > 0 ? 'beter' : 'lager');
}

function hardRow(env: PageEnv, card: Card): HTMLElement {
  return h(
    'button',
    { class: 'hard-row', type: 'button', on: { click: () => openCardPreview(env, card, () => env.redraw()) } },
    env.d.starred.has(card.id) ? h('span', { class: 'card-row-star', html: icon('starOn', 14) }) : h('span', { class: 'hard-dot' }),
    h('span', { class: 'hard-q' }, ...rich(card.front.text)),
    h('span', { class: 'chev', html: icon('chevronRight', 16) }),
  );
}
