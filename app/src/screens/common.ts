/**
 * Pieces shared by several screens: the course row (Home and Vakken), the one
 * banner, the card list row, the instrument score sheet and the card menu.
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { openSheet, toast } from '../ui/overlay.ts';
import { boxBadge, chaptersLabel, courseTile, pctLabel, progressBar, rich } from '../ui/parts.ts';
import type { Card, Course, FlagReason } from '../lib/model.ts';
import { cardsLabel } from '../lib/queue.ts';
import { SCORE_LABELS, scorePreview, type DueInstrument, type InstrumentState } from '../lib/instruments.ts';
import type { InstrumentScore } from '../lib/model.ts';
import { relativeDay } from '../lib/dates.ts';
import { plainText } from '../lib/text.ts';
import type { AppContext } from '../context.ts';
import type { PageEnv } from './shell.ts';
import { chaptersOf, shareOf } from './derive.ts';

/** One course: tile, name, "61 kaartjes · 3 hoofdstukken", bar and %. */
export function courseRow(env: PageEnv, course: Course, extra?: Node | null): HTMLElement {
  const cards = env.d.byCourse.get(course.id) ?? [];
  const chapters = chaptersOf(env.s, course.id).filter((ch) => (env.d.byChapter.get(ch.id)?.length ?? 0) > 0);
  const share = shareOf(env.d, cards);
  const meta = cards.length === 0 ? 'Nog geen kaartjes' : `${cardsLabel(cards.length)} · ${chaptersLabel(chapters.length)}`;
  return h(
    'button',
    {
      class: 'row-card course-row',
      type: 'button',
      on: { click: () => env.go(`vak/${course.id}`) },
    },
    courseTile(course, 'md'),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-title', text: course.name }),
      h('span', { class: 'row-sub' }, meta, extra ?? null),
      progressBar(share),
    ),
    h('span', { class: 'row-pct', text: pctLabel(share) }),
  );
}

/**
 * At most one banner (SPEC-v3 §2 Home): offline first, then "new cards not in
 * yet" when the evening intake has not run for more than 26 hours.
 */
export function banner(env: PageEnv): HTMLElement | null {
  const { ctx, s } = env;
  if (ctx.mode === 'demo') return null;
  if (ctx.syncer?.state === 'offline') {
    return h('div', { class: 'banner banner-offline', role: 'status' }, h('span', { html: icon('offline', 18) }), h('span', { text: 'Offline: alles wordt bewaard' }));
  }
  const last = s.pipeline?.last_intake_at ? Date.parse(s.pipeline.last_intake_at) : NaN;
  if (Number.isFinite(last) && Date.now() - last > 26 * 3600 * 1000) {
    const when = new Date(last).toLocaleString('nl-BE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    return h('div', { class: 'banner', role: 'status' }, h('span', { html: icon('info', 18) }), h('span', { text: `Nieuwe kaartjes nog niet binnen (laatste update ${when})` }));
  }
  if (ctx.degraded) {
    return h('div', { class: 'banner', role: 'status' }, h('span', { html: icon('info', 18) }), h('span', { text: 'Opslag op de iPhone werkt even niet: verstuur je antwoorden voor je de app sluit.' }));
  }
  return null;
}

/** A card in a list: the question (two lines) and its Doos badge. */
export function cardRow(env: PageEnv, card: Card, onOpen: (card: Card) => void): HTMLElement {
  const box = env.d.states.get(card.id)?.box ?? 0;
  return h(
    'button',
    { class: 'card-row', type: 'button', on: { click: () => onOpen(card) } },
    h('span', { class: 'card-row-q' }, ...rich(card.front.text)),
    h(
      'span',
      { class: 'card-row-side' },
      env.d.starred.has(card.id) ? h('span', { class: 'card-row-star', html: icon('starOn', 14), 'aria-label': 'moeilijk' }) : null,
      boxBadge(box),
    ),
  );
}

/** "Gedaan" on an instrument: Alles juist / Bijna / Veel fout, each with when it comes back. */
export function openScoreSheet(ctx: AppContext, due: { instrument: DueInstrument['instrument']; state: InstrumentState }, onDone: () => void): void {
  const days = (score: InstrumentScore) => {
    const n = scorePreview(due.state, score);
    return n === 1 ? 'morgen opnieuw' : `over ${n} dagen opnieuw`;
  };
  const choice = (score: InstrumentScore, tone: string, iconName: string) =>
    h(
      'button',
      {
        class: `score-choice score-${tone}`,
        type: 'button',
        on: {
          click: async () => {
            sheet.close();
            await ctx.actions.scoreInstrument(due.instrument.id, score);
            toast(`${SCORE_LABELS[score]} · ${days(score)}`, { icon: 'checkCircle' });
            onDone();
          },
        },
      },
      h('span', { class: 'score-icon', html: icon(iconName, 22) }),
      h('span', { class: 'score-text' }, h('b', { text: SCORE_LABELS[score] }), h('small', { text: days(score) })),
    );
  const sheet = openSheet(
    { title: 'Hoe ging het?' },
    h('p', { class: 'sheet-lead', text: due.instrument.title }),
    h(
      'div',
      { class: 'score-list' },
      choice('alles', 'good', 'checkCircle'),
      choice('bijna', 'mid', 'target'),
      choice('veel_fout', 'bad', 'wrongCircle'),
    ),
  );
}

/** "Volgende keer: morgen" for an instrument. */
export function instrumentNext(state: InstrumentState, today: string): string {
  if (state.due === null) return 'Nog niet geoefend';
  if (state.due <= today) return state.last_day === today ? 'Vandaag gedaan' : 'Vandaag aan de beurt';
  return `Volgende keer ${relativeDay(state.due, today)}`;
}

const FLAG_REASONS: { id: FlagReason; label: string }[] = [
  { id: 'fout', label: 'Fout' },
  { id: 'onduidelijk', label: 'Onduidelijk' },
  { id: 'te_lang', label: 'Te lang' },
  { id: 'beeld', label: 'Afbeelding mist/fout' },
  { id: 'dubbel', label: 'Dubbel' },
];

/** The card menu "…": Meld een probleem · Kopieer voor Claude. */
export function openCardMenu(ctx: AppContext, card: Card): void {
  const menu = openSheet(
    { title: 'Dit kaartje' },
    h(
      'div',
      { class: 'menu-list' },
      h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          on: {
            click: () => {
              menu.close();
              setTimeout(() => openFlagSheet(ctx, card), 260);
            },
          },
        },
        h('span', { class: 'menu-icon', html: icon('flag', 20) }),
        h('span', { class: 'menu-text' }, h('b', { text: 'Meld een probleem' }), h('small', { text: 'Claude kijkt het vanavond na' })),
      ),
      h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          on: {
            click: async () => {
              menu.close();
              await copyForClaude(card);
            },
          },
        },
        h('span', { class: 'menu-icon', html: icon('copy', 20) }),
        h('span', { class: 'menu-text' }, h('b', { text: 'Kopieer voor Claude' }), h('small', { text: 'Plak het in je vakproject voor meer uitleg' })),
      ),
    ),
  );
}

function openFlagSheet(ctx: AppContext, card: Card): void {
  let reason: FlagReason | null = null;
  const send = h('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Melden', disabled: true });
  const note = h('textarea', { class: 'field', rows: '3', maxlength: '500', placeholder: 'Wat klopt er niet? (mag leeg blijven)', 'aria-label': 'Uitleg' });
  const chips = h(
    'div',
    { class: 'choice-chips', role: 'radiogroup', 'aria-label': 'Wat is het probleem?' },
    FLAG_REASONS.map((r) =>
      h('button', {
        class: 'choice-chip',
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        text: r.label,
        on: {
          click: (event: MouseEvent) => {
            reason = r.id;
            for (const el of chips.querySelectorAll('.choice-chip')) el.setAttribute('aria-checked', 'false');
            (event.currentTarget as HTMLElement).setAttribute('aria-checked', 'true');
            send.disabled = false;
          },
        },
      }),
    ),
  );
  send.addEventListener('click', async () => {
    if (!reason) return;
    send.disabled = true;
    await ctx.actions.flag(card.id, reason, note.value);
    sheet.close();
    toast('Gemeld. Bedankt!', { icon: 'checkCircle' });
  });
  const sheet = openSheet(
    { title: 'Meld een probleem' },
    h('p', { class: 'sheet-lead clamp-2', text: plainText(card.front.text) }),
    chips,
    note,
    send,
  );
}

/** 'Leg uit: <vraag> / <antwoord> / <bron>' on the clipboard. */
export async function copyForClaude(card: Card): Promise<void> {
  const text = [
    `Leg uit: ${plainText(card.front.text)}`,
    `Antwoord: ${plainText(card.answer.core)}`,
    card.answer.more ? `Meer: ${plainText(card.answer.more)}` : '',
    `Bron: ${card.source.label}`,
  ]
    .filter(Boolean)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd. Plak het in je vakproject.', { icon: 'copy' });
  } catch {
    // Older Safari without clipboard access: a selectable text field.
    const area = h('textarea', { class: 'field', rows: '5', readonly: true });
    area.value = text;
    openSheet({ title: 'Kopieer deze tekst' }, area);
    setTimeout(() => area.select(), 300);
  }
}

/** '±5 min' for a quiz of n questions (about 30 s per question). */
export function quizMinutes(n: number): string {
  return `±${Math.max(1, Math.round((n * 30) / 60))} min`;
}
