/**
 * The read-only card preview (Vakken → Kaartjes, Moeilijkste, quiz mistakes):
 * tap to flip, and "Opnieuw leren" puts the card back in Doos 1.
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { openSheet, toast } from '../ui/overlay.ts';
import { boxBadge, chip, rich } from '../ui/parts.ts';
import { visualFrame } from '../ui/visual.ts';
import type { Card } from '../lib/model.ts';
import type { Box } from '../lib/leitner.ts';
import { relativeDay } from '../lib/dates.ts';
import type { PageEnv } from './shell.ts';
import { chapterCode } from './derive.ts';
import { openCardMenu } from './common.ts';

export function openCardPreview(env: Pick<PageEnv, 'ctx' | 's' | 'd'>, card: Card, onChanged?: () => void): void {
  const { ctx, s, d } = env;
  const visEnv = { images: ctx.images, slides: d.slides };
  let state = d.states.get(card.id);
  let box: Box = state?.box ?? 0;
  let starred = d.starred.has(card.id);
  let flipped = false;

  const badgeSlot = h('span', { class: 'pv-badge' }, boxBadge(box));
  const starBtn = h('button', {
    class: `icon-btn star-btn${starred ? ' on' : ''}`,
    type: 'button',
    'aria-label': starred ? 'Niet meer moeilijk' : 'Markeer als moeilijk',
    'aria-pressed': String(starred),
    html: icon(starred ? 'starOn' : 'star', 22),
    on: {
      click: async (event: Event) => {
        event.stopPropagation();
        starred = !starred;
        starBtn.classList.toggle('on', starred);
        starBtn.innerHTML = icon(starred ? 'starOn' : 'star', 22);
        starBtn.setAttribute('aria-pressed', String(starred));
        await ctx.actions.star(card.id, starred);
        onChanged?.();
      },
    },
  });

  const front = h(
    'div',
    { class: 'pv-face pv-front' },
    h('p', { class: 'pv-q' }, ...rich(card.front.text)),
    visualFrame(card.front.visual, visEnv),
    h('p', { class: 'pv-tap' }, h('span', { html: icon('sync', 16) }), 'Tik om om te draaien'),
  );
  const back = h(
    'div',
    { class: 'pv-face pv-back', 'aria-hidden': 'true' },
    h('p', { class: 'pv-q-small' }, ...rich(card.front.text)),
    h('p', { class: 'pv-core' }, ...rich(card.answer.core)),
    visualFrame(card.answer.visual, visEnv),
    card.answer.more ? h('p', { class: 'pv-more' }, ...rich(card.answer.more)) : null,
    h('div', { class: 'pv-meta' }, chip(card.source.label, 'chip-source')),
  );
  const flipper = h(
    'div',
    {
      class: 'pv-card',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Draai het kaartje om',
      on: {
        click: () => flip(),
        keydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            flip();
          }
        },
      },
    },
    h('div', { class: 'pv-top' }, badgeSlot, starBtn),
    h('div', { class: 'pv-faces' }, front, back),
  );

  function flip(): void {
    flipped = !flipped;
    flipper.classList.toggle('flipped', flipped);
    front.setAttribute('aria-hidden', String(flipped));
    back.setAttribute('aria-hidden', String(!flipped));
  }

  const nextLine = h('p', { class: 'pv-next' });
  const relearn = h(
    'button',
    { class: 'btn btn-soft btn-block', type: 'button' },
    h('span', { html: icon('undo', 18) }),
    'Opnieuw leren',
  );
  function updateFoot(): void {
    nextLine.textContent =
      box === 0
        ? 'Nog niet geleerd: komt vanzelf in je overhoorlijst.'
        : state?.due
          ? `Volgende keer: ${relativeDay(state.due, s.today)}`
          : '';
    relearn.hidden = box < 2;
  }
  relearn.addEventListener('click', async () => {
    relearn.disabled = true;
    await ctx.actions.relearn(card.id);
    box = 1;
    state = state ? { ...state, box: 1, due: null } : state;
    badgeSlot.replaceChildren(boxBadge(1));
    nextLine.textContent = 'Terug in Doos 1: komt morgen terug.';
    relearn.hidden = true;
    relearn.disabled = false;
    toast('Terug naar Doos 1 · morgen opnieuw', { icon: 'undo' });
    onChanged?.();
  });
  updateFoot();

  const chapter = d.chapters.get(card.chapter_id);
  openSheet(
    { title: chapter ? `${chapterCode(chapter)} · ${chapter.title}` : 'Kaartje', className: 'preview-sheet' },
    flipper,
    nextLine,
    h(
      'div',
      { class: 'pv-actions' },
      relearn,
      h('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => openCardMenu(ctx, card) } }, h('span', { html: icon('more', 18) }), 'Meer'),
    ),
  );
}
