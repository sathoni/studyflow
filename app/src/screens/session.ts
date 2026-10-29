/**
 * The review session (SPEC-v3 §2 R4–R6).
 *
 *   front   Doos badge, ☆, "…", the question, three hints one by one,
 *           "Tik om het antwoord te zien"
 *   back    the answer core (key term bold), the visual (tap: full screen),
 *           the source chip, "Meer uitleg" (opens by itself after a lapse)
 *   bottom  the box row (cards per box in this session, the card's box lit)
 *           and the two big buttons with what each one does to the card:
 *           "Niet gekend · terug naar Doos 1", "Gekend · naar Doos 4",
 *           "Gekend met hint · blijft in Doos 3"
 *
 * Swipe right = green, left = red (after revealing). "Ongedaan maken" stays
 * 6 s. Failed cards come back at the end (herhaling, at most 2 extra tries,
 * no box change). Every answer is saved the moment it is given, so ✕ never
 * loses anything. Laptop keys: space, H, 1/←, 2/→, U, Esc.
 */

import { h, fill } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { hideToast, toast } from '../ui/overlay.ts';
import { boxBadge, buzz, chip, iconButton, reducedMotion, rich } from '../ui/parts.ts';
import { sounds } from '../ui/sound.ts';
import { visualFrame } from '../ui/visual.ts';
import type { Card, Review } from '../lib/model.ts';
import { queueInput } from '../lib/data.ts';
import {
  MAX_REPEATS,
  ReviewSession,
  buildQueue,
  cardsLabel,
  extraRound,
  forCourse,
  studyRound,
  type StudyScope,
  type QueueItem,
  type QueuePart,
  type RepeatItem,
} from '../lib/queue.ts';
import { type Box, type CardState, boxCounts, boxLabel, foldAll, hintButtonLabel, previewButtons } from '../lib/leitner.ts';
import { courseQuizList, homeQuizSuggestion } from '../lib/quiz.ts';
import { addDays } from '../lib/dates.ts';
import type { ModeHandle, PageEnv } from './shell.ts';
import { openCardMenu, tomorrowLine as tomorrowText } from './common.ts';
import { openCardPreview } from './preview.ts';

const SWIPE_COMMIT = 96;

/** How long "Ongedaan maken" stays possible after an answer (the toast's 6 s, plus a little slack). */
const UNDO_MS = 6500;

export function sessionMode(env: PageEnv): ModeHandle {
  const { ctx, s, d, params } = env;
  // sessie/herhaling and sessie/nieuw: the morning and the evening list.
  // sessie/hoofdstuk/<id>/<round> or sessie/vak/<id>/<round>: a round with the boxes
  // over one chapter or course, at any moment. sessie/<course>: today's lists for one
  // course; sessie/<course>/extra: one more round of it.
  const study: StudyScope | null =
    params[0] === 'hoofdstuk' || params[0] === 'vak' ? { kind: params[0], id: params[1] ?? '' } : null;
  const list = params[0] === 'herhaling' ? 'review' : params[0] === 'nieuw' ? 'new' : null;
  // sessie/vandaag/<chapter>: today's lists, only that chapter's cards (chapter page).
  const todayChapter = params[0] === 'vandaag' ? (params[1] ?? '') : null;
  const round = Number(params[2] ?? '1') || 1;
  const courseId = study || list || todayChapter !== null ? null : (params[0] ?? null);
  const extra = !study && todayChapter === null && params[1] === 'extra';
  // Rounds outside today's lists are extra practice: logged as 'extra', so they
  // never take a place in today's lists (his wish, 29/10).
  const practice = study !== null || extra;
  const waits = s.defaults.wait_days;

  let items: QueueItem[];
  let repeats: RepeatItem[];
  if (study) {
    items = studyRound(queueInput(s), study).items;
    repeats = [];
  } else if (list) {
    items = d.queue.parts[list].remaining;
    repeats = d.queue.parts[list].repeats;
  } else if (todayChapter !== null) {
    items = d.queue.remaining.filter((i) => i.card.chapter_id === todayChapter);
    repeats = d.queue.repeats.filter((r) => r.item.card.chapter_id === todayChapter);
  } else if (!courseId) {
    items = d.queue.remaining;
    repeats = d.queue.repeats;
  } else if (extra) {
    items = extraRound(queueInput(s), d.queue, courseId);
    repeats = [];
  } else {
    items = forCourse(d.queue, courseId);
    repeats = d.queue.repeats.filter((r) => r.item.card.course_id === courseId);
  }

  const session = new ReviewSession(items, repeats);
  const ids = [...new Set([...items, ...repeats.map((r) => r.item)].map((i) => i.card.id))];
  const reviews: Review[] = [...s.reviews];
  let states: Map<string, CardState> = foldAll(ids, reviews, { waits });
  const starred = new Set(d.starred);
  const startedAt = Date.now();

  // Per card on screen.
  let revealed = false;
  let hints = 0;
  let shownAt = performance.now();
  let restoreHints: number | null = null;
  let busy = false;
  let lastAnswer: { row: Review; hints: number; at: number } | null = null;
  let cardEl: HTMLElement | null = null;

  /* ---------------- frame ---------------- */

  const title = h('span', { class: 'mode-title' });
  const counter = h('span', { class: 'mode-count' });
  const progress = h('i');
  const header = h(
    'header',
    { class: 'mode-head' },
    iconButton('close', 'Sluiten', () => env.back(''), 'mode-close'),
    title,
    counter,
    h('span', { class: 'mode-progress', 'aria-hidden': 'true' }, progress),
  );
  const body = h('div', { class: 'mode-body' });
  const foot = h('div', { class: 'mode-foot' });
  const root = h('div', { class: 'mode session' }, header, body, foot);

  function stateOf(cardId: string): CardState | undefined {
    return states.get(cardId);
  }

  function updateHeader(card: Card | null): void {
    const pos = session.position;
    if (card) {
      const chapter = d.chapters.get(card.chapter_id);
      const course = d.courses.get(card.course_id);
      title.replaceChildren(
        h('i', { class: 'dot', style: `--cc:${course?.color ?? '#2F6BFF'}` }),
        h('span', { class: 'mode-title-text', text: `${card.course_id} – ${chapter?.title ?? card.chapter_id}` }),
      );
      counter.textContent = `${Math.min(pos.done + 1, pos.total)} / ${pos.total}`;
    } else {
      title.replaceChildren(
        h('span', { class: 'mode-title-text', text: list === 'review' ? 'Herhaling' : list === 'new' ? 'Nieuwe kaartjes' : practice ? 'Extra oefenen' : 'Vandaag overhoren' }),
      );
      counter.textContent = `${pos.total} / ${pos.total}`;
    }
    progress.style.width = `${pos.total === 0 ? 100 : Math.round((pos.done / pos.total) * 100)}%`;
  }

  /* ---------------- one card ---------------- */

  function show(): void {
    const step = session.current;
    if (!step) return showEnd();
    document.documentElement.classList.remove('mode-end');
    const card = step.item.card;
    const state = stateOf(card.id);
    const box: Box = state?.box ?? 0;
    revealed = false;
    hints = restoreHints ?? 0;
    restoreHints = null;
    shownAt = performance.now();
    updateHeader(card);

    const visEnv = { images: ctx.images, slides: d.slides };
    const hintBox = h('div', { class: 'rv-hints', hidden: hints === 0 });
    const renderHints = () => {
      hintBox.replaceChildren(
        ...card.hints.slice(0, hints).map((text, i) => h('p', { class: 'rv-hint' }, h('b', { text: `Hint ${i + 1}` }), ' ', ...rich(text))),
      );
      hintBox.hidden = hints === 0;
    };
    renderHints();

    const starBtn = h('button', {
      class: `icon-btn star-btn${starred.has(card.id) ? ' on' : ''}`,
      type: 'button',
      'aria-pressed': String(starred.has(card.id)),
      'aria-label': 'Markeer als moeilijk',
      html: icon(starred.has(card.id) ? 'starOn' : 'star', 22),
      on: {
        click: async (event: Event) => {
          event.stopPropagation();
          const on = !starred.has(card.id);
          if (on) starred.add(card.id);
          else starred.delete(card.id);
          starBtn.classList.toggle('on', on);
          starBtn.setAttribute('aria-pressed', String(on));
          starBtn.innerHTML = icon(on ? 'starOn' : 'star', 22);
          buzz();
          await ctx.actions.star(card.id, on);
          if (on) toast('Gemarkeerd als moeilijk', { icon: 'starOn' });
        },
      },
    });
    const menuBtn = iconButton('more', 'Meer', (event) => {
      event.stopPropagation();
      openCardMenu(ctx, card);
    });

    const lapsed = step.mode === 'herhaling' || state?.last_result === 'niet';
    const more = card.answer.more
      ? h('details', { class: 'rv-more', open: false }, h('summary', {}, h('span', { class: 'chev', html: icon('chevronRight', 16) }), 'Meer uitleg'), h('p', {}, ...rich(card.answer.more)))
      : null;
    const back = h(
      'div',
      { class: 'rv-back', hidden: true },
      h('div', { class: 'rv-divider', 'aria-hidden': 'true' }),
      h('p', { class: 'rv-core' }, ...rich(card.answer.core)),
      visualFrame(card.answer.visual, visEnv),
      h('div', { class: 'rv-meta' }, chip(card.source.label, 'chip-source')),
      more,
      h('p', { class: 'rv-tap rv-tap-back', text: 'Tik om alleen de vraag te zien' }),
    );
    const tap = h('p', { class: 'rv-tap', text: 'Tik om het antwoord te zien' });

    cardEl = h(
      'article',
      { class: 'rv-card enter', 'aria-live': 'polite' },
      h('div', { class: 'swipe-tint good', 'aria-hidden': 'true' }, h('span', { html: icon('check', 28) })),
      h('div', { class: 'swipe-tint bad', 'aria-hidden': 'true' }, h('span', { html: icon('wrong', 28) })),
      h(
        'div',
        { class: 'rv-top' },
        boxBadge(box),
        step.mode === 'herhaling' ? h('span', { class: 'badge badge-repeat', text: 'Herhaling' }) : null,
        h('span', { class: 'grow' }),
        starBtn,
        menuBtn,
      ),
      h('div', { class: 'rv-front' }, h('p', { class: 'rv-q' }, ...rich(card.front.text)), visualFrame(card.front.visual, visEnv), hintBox),
      tap,
      back,
    );

    const hintBtn = h('button', { class: 'hint-btn', type: 'button' });
    const updateHintBtn = () => {
      const label = hintButtonLabel(hints);
      hintBtn.hidden = revealed || label === null || card.hints.length === 0;
      hintBtn.replaceChildren(h('span', { html: icon(hints > 0 ? 'hintOn' : 'hint', 18) }), label ?? '');
    };
    hintBtn.addEventListener('click', () => {
      if (hints >= Math.min(3, card.hints.length)) return;
      hints++;
      renderHints();
      updateHintBtn();
      renderFoot();
    });
    updateHintBtn();

    const reveal = () => {
      if (revealed || !cardEl) return;
      revealed = true;
      tap.hidden = true;
      back.hidden = false;
      if (more && lapsed) (more as HTMLDetailsElement).open = true;
      cardEl.classList.add('revealed');
      updateHintBtn();
      renderFoot();
    };

    // After the first reveal a tap flips between the question alone and the answer
    // (his wish, 26/10). The two answer buttons stay available on both sides.
    const flip = () => {
      if (!cardEl) return;
      if (!revealed) return reveal();
      const toQuestion = !back.hidden;
      back.hidden = toQuestion;
      tap.hidden = !toQuestion;
      cardEl.classList.toggle('revealed', !toQuestion);
    };

    attachGestures(cardEl, flip);
    fill(body, cardEl, hintBtn);
    body.scrollTop = 0;
    requestAnimationFrame(() => cardEl?.classList.remove('enter'));

    // The footer reads the current state each time.
    function renderFoot(): void {
      const st = stateOf(card.id);
      const curBox: Box = st?.box ?? 0;
      const counts = boxCounts(ids, states);
      const row = h(
        'div',
        { class: 'box-row', role: 'list', 'aria-label': 'Kaartjes per doos in deze sessie' },
        ([1, 2, 3, 4, 5, 6] as Box[]).map((b) =>
          h(
            'span',
            { class: `box-chip${b === curBox ? ' current' : ''}`, role: 'listitem', 'aria-current': b === curBox ? 'true' : null },
            h('b', { text: b === 6 ? 'Gekend' : `Doos ${b}` }),
            h('small', {}, String(counts[b]), h('span', { class: 'box-chip-word', text: counts[b] === 1 ? ' kaartje' : ' kaartjes' })),
          ),
        ),
      );
      let actions: HTMLElement;
      if (!revealed) {
        actions = h(
          'div',
          { class: 'answer-row' },
          h('button', { class: 'btn btn-primary btn-reveal', type: 'button', on: { click: reveal } }, 'Toon antwoord'),
        );
      } else {
        const step = session.current!;
        let red = { label: 'Niet gekend', sub: 'terug naar Doos 1' };
        let green = { label: 'Gekend', sub: '' };
        if (step.mode === 'sessie') {
          const p = previewButtons({ box: curBox }, hints, s.today, waits);
          red = { label: p.red.label, sub: p.red.sub };
          green = { label: p.green.label, sub: p.green.sub };
        } else {
          red.sub = step.attempt < MAX_REPEATS ? 'straks nog een keer' : 'morgen opnieuw';
          green = { label: hints > 0 ? 'Gekend met hint' : 'Gekend', sub: curBox === 6 ? 'blijft Gekend' : `blijft in ${boxLabel(curBox)}` };
        }
        actions = h(
          'div',
          { class: 'answer-row' },
          h(
            'button',
            { class: 'answer-btn bad', type: 'button', on: { click: () => void rate('niet') } },
            h('span', { class: 'answer-icon', html: icon('wrong', 22) }),
            h('b', { text: red.label }),
            h('small', { text: red.sub }),
          ),
          h(
            'button',
            { class: 'answer-btn good', type: 'button', on: { click: () => void rate('gekend') } },
            h('span', { class: 'answer-icon', html: icon('check', 22) }),
            h('b', { text: green.label }),
            h('small', { text: green.sub }),
          ),
        );
      }
      fill(foot, row, actions);
    }
    renderFoot();
  }

  /* ---------------- answering ---------------- */

  async function rate(answer: 'gekend' | 'niet', flyFrom?: number): Promise<void> {
    const step = session.current;
    if (busy || !revealed || !step) return;
    busy = true;
    const card = step.item.card;
    const used = hints;
    const before = stateOf(card.id)?.box ?? 0;
    const preview = previewButtons({ box: before }, used, s.today, waits);
    buzz(answer === 'gekend' ? 8 : 16);
    try {
      const mode = step.mode === 'sessie' && practice ? 'extra' : step.mode;
      const row = await ctx.actions.rate(card.id, answer, mode, used, Math.round(performance.now() - shownAt));
      reviews.push(row);
      states = foldAll(ids, reviews, { waits });
      session.answer(answer === 'gekend' && used > 0 ? 'hint' : answer);
      if (answer === 'gekend') sounds.tick();
      else sounds.wrong();
      lastAnswer = { row, hints: used, at: Date.now() };
      const what =
        step.mode === 'herhaling'
          ? answer === 'niet' ? (step.attempt < MAX_REPEATS ? 'Komt straks nog een keer' : 'Morgen opnieuw') : 'Goed zo!'
          : capitalize(answer === 'niet' ? preview.red.sub : preview.green.sub);
      toast(what, { action: { label: 'Ongedaan maken', run: undoLast } });
      await flyOut(answer === 'gekend' ? 1 : -1, flyFrom);
    } finally {
      busy = false;
    }
    show();
  }

  async function undoLast(): Promise<void> {
    const last = lastAnswer;
    // Only while the "Ongedaan maken" toast is up (6 s), also for the U key.
    if (!last || Date.now() - last.at > UNDO_MS) return;
    // Tapped while the card is still flying out: do it right after.
    if (busy) {
      setTimeout(() => void undoLast(), 120);
      return;
    }
    busy = true;
    try {
      lastAnswer = null;
      const row = await ctx.actions.undo(last.row);
      reviews.push(row);
      states = foldAll(ids, reviews, { waits });
      session.undo();
      restoreHints = last.hints;
    } finally {
      busy = false;
    }
    show();
  }

  function flyOut(direction: 1 | -1, from = 0): Promise<void> {
    const el = cardEl;
    if (!el || reducedMotion()) return Promise.resolve();
    return new Promise((resolve) => {
      el.style.transition = 'transform 220ms cubic-bezier(0.4, 0, 1, 1), opacity 220ms';
      el.style.transform = `translateX(${direction * Math.max(window.innerWidth, 420) + from}px) rotate(${direction * 12}deg)`;
      el.style.opacity = '0';
      setTimeout(resolve, 200);
    });
  }

  /* ---------------- gestures ---------------- */

  function attachGestures(el: HTMLElement, onTap: () => void): void {
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let decided: 'none' | 'swipe' | 'scroll' = 'none';
    let swiped = false;
    const good = el.querySelector<HTMLElement>('.swipe-tint.good')!;
    const bad = el.querySelector<HTMLElement>('.swipe-tint.bad')!;
    const interactive = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, a, summary, details, .visual-frame');

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!e.isPrimary || interactive(e.target)) return;
      // Not from the very edge: that is the system's back gesture.
      if (e.clientX < 20 || e.clientX > window.innerWidth - 20) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      tracking = true;
      decided = 'none';
      swiped = false;
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (!tracking || !revealed) return;
      const mx = e.clientX - startX;
      const my = e.clientY - startY;
      if (decided === 'none') {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        decided = Math.abs(mx) > Math.abs(my) * 1.2 ? 'swipe' : 'scroll';
        if (decided === 'swipe') el.setPointerCapture(e.pointerId);
      }
      if (decided !== 'swipe') return;
      dx = mx;
      swiped = true;
      el.style.transition = 'none';
      el.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
      const k = Math.min(1, Math.abs(dx) / SWIPE_COMMIT);
      good.style.opacity = dx > 0 ? String(k) : '0';
      bad.style.opacity = dx < 0 ? String(k) : '0';
    });
    const end = (e: PointerEvent) => {
      if (!tracking) return;
      tracking = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (decided !== 'swipe') return;
      if (Math.abs(dx) >= SWIPE_COMMIT) {
        void rate(dx > 0 ? 'gekend' : 'niet', dx);
      } else {
        el.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
        good.style.opacity = '0';
        bad.style.opacity = '0';
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => {
      if (swiped || interactive(e.target)) return;
      onTap();
    });
  }

  /* ---------------- the end ---------------- */

  function showEnd(): void {
    updateHeader(null);
    document.documentElement.classList.add('mode-end');
    const sum = session.summary();
    const after = buildQueue({ ...queueInput(s), reviews });
    const allDone = after.remaining.length === 0 && after.repeats.length === 0;
    const leftIn = (p: QueuePart) => p.remaining.length + p.repeats.length;
    const mineLeft = list ? leftIn(after.parts[list]) : after.remaining.length + after.repeats.length;
    const otherLeft = list === 'new' ? leftIn(after.parts.review) : list === 'review' ? leftIn(after.parts.new) : 0;
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    const pct = sum.firstTryShare === null ? null : Math.round(sum.firstTryShare * 100);

    const suggestion = homeQuizSuggestion(d.qdata);
    let quiz: { label: string; path: string } | null = null;
    if (suggestion?.kind === 'sessie') quiz = { label: 'Mini-quiz', path: `quizrun/sessie/${suggestion.entry.quiz.id}` };
    else if (suggestion?.kind === 'hoofdstuk') quiz = { label: 'Hoofdstukquiz', path: `quizrun/hoofdstuk/${suggestion.entry.chapter.id}` };
    else {
      const courses = new Set(ids.map((id) => d.cardById.get(id)?.course_id));
      const mixed = courseQuizList(d.qdata).find((e) => courses.has(e.course.id));
      if (mixed) quiz = { label: `Quiz · ${mixed.course.id}`, path: `quizrun/vak/${mixed.course.id}` };
    }

    const failed = sum.failed.map((id) => d.cardById.get(id)).filter((c): c is Card => !!c);
    const nothing = sum.cards === 0 && items.length === 0 && repeats.length === 0;
    if (!nothing) {
      if (allDone) sounds.fanfare();
      else sounds.done();
    }

    // A round over one chapter or course: say what is left there and offer the next round.
    const next = study ? studyRound({ ...queueInput(s), reviews }, study) : null;
    const leftInScope = next ? next.items.length + next.left : 0;
    const scopeName = study
      ? study.kind === 'hoofdstuk'
        ? `dit hoofdstuk`
        : `${d.courses.get(study.id)?.name ?? study.id}`
      : '';

    fill(
      body,
      h(
        'div',
        { class: 'end' },
        h('span', { class: 'end-check', html: icon('checkCircle', 64) }),
        study
          ? h('h1', { class: 'end-title', text: nothing ? 'Alles overlopen' : leftInScope > 0 ? 'Ronde klaar' : 'Alles overlopen' })
          : h('h1', { class: 'end-title', text: nothing ? 'Niets meer te overhoren' : allDone ? 'Klaar voor vandaag' : 'Goed gedaan' }),
        study
          ? h('p', {
              class: 'end-sub',
              text:
                leftInScope > 0
                  ? `Nog ${cardsLabel(leftInScope)} in ${scopeName}. Doe gerust nog een ronde.`
                  : next && next.inToday > 0
                    ? next.inToday === 1
                      ? 'Het laatste kaartje staat in je lijst van vandaag: dat doe je daar.'
                      : `De laatste ${next.inToday} kaartjes staan in je lijst van vandaag: die doe je daar.`
                    : `Je hebt vandaag alle kaartjes van ${scopeName} overlopen.`,
            })
          : h('p', {
              class: 'end-sub',
              text: nothing
                ? 'Alles voor vandaag is al gedaan.'
                : allDone
                  ? 'Alles voor vandaag is gedaan. Tot morgen!'
                  : list === 'new' && mineLeft === 0
                    ? `Je nieuwe kaartjes zijn klaar. Nog ${cardsLabel(otherLeft)} in je herhaling van vandaag.`
                    : list === 'review' && mineLeft === 0
                      ? `Je herhaling is klaar. Vanavond: ${otherLeft === 1 ? '1 nieuw kaartje' : `${otherLeft} nieuwe kaartjes`}.`
                      : `Nog ${cardsLabel(mineLeft)} voor vandaag.`,
            }),
        nothing
          ? null
          : h(
              'div',
              { class: 'stat-grid three' },
              statTile(String(sum.cards), sum.cards === 1 ? 'kaartje' : 'kaartjes'),
              statTile(pct === null ? '–' : `${pct}%`, 'juist in één keer'),
              statTile(`${minutes}`, minutes === 1 ? 'minuut' : 'minuten'),
            ),
        failed.length > 0
          ? h(
              'section',
              { class: 'card end-hard' },
              h('h2', { class: 'card-title', text: 'Moeilijkste vandaag' }),
              failed.slice(0, 6).map((c) =>
                h(
                  'button',
                  {
                    class: 'card-row',
                    type: 'button',
                    on: { click: () => openCardPreview({ ctx, s, d: { ...d, states } }, c) },
                  },
                  h('span', { class: 'card-row-q' }, ...rich(c.front.text)),
                  h('span', { class: 'chev', html: icon('chevronRight', 16) }),
                ),
              ),
            )
          : null,
        allDone && !nothing ? h('p', { class: 'end-note', text: tomorrowLine() }) : null,
      ),
    );
    fill(
      foot,
      h(
        'div',
        { class: 'end-actions' },
        study && leftInScope > 0
          ? h(
              'button',
              { class: 'btn btn-soft btn-big', type: 'button', on: { click: () => env.go(`sessie/${study.kind}/${study.id}/${round + 1}`, { replace: true }) } },
              h('span', { html: icon('play', 18) }),
              `Nog een ronde · ${Math.min(leftInScope, next!.items.length)}`,
            )
          : quiz
            ? h('button', { class: 'btn btn-soft btn-big', type: 'button', on: { click: () => env.go(quiz!.path, { replace: true }) } }, h('span', { html: icon('quiz', 18) }), quiz.label)
            : null,
        h('button', { class: 'btn btn-primary btn-big', type: 'button', text: 'Klaar', on: { click: () => env.back('') } }),
      ),
    );
    body.scrollTop = 0;
  }

  function tomorrowLine(): string {
    return tomorrowText(buildQueue({ ...queueInput(s), reviews, today: addDays(s.today, 1) }));
  }

  /* ---------------- keys ---------------- */

  const onKey = (e: KeyboardEvent) => {
    if (document.documentElement.classList.contains('sheet-open') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') return env.back('');
    if (!session.current) return;
    if ((k === ' ' || k === 'enter') && !revealed) {
      e.preventDefault();
      root.querySelector<HTMLElement>('.btn-reveal')?.click();
    } else if (k === 'h' && !revealed) root.querySelector<HTMLElement>('.hint-btn:not([hidden])')?.click();
    else if ((k === '1' || k === 'arrowleft') && revealed) void rate('niet');
    else if ((k === '2' || k === 'arrowright') && revealed) void rate('gekend');
    else if (k === 'u') void undoLast();
  };
  document.addEventListener('keydown', onKey);

  show();
  return {
    el: root,
    dispose: () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('mode-end');
      hideToast();
    },
  };
}

function statTile(value: string, label: string): HTMLElement {
  return h('div', { class: 'stat' }, h('b', { text: value }), h('span', { text: label }));
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
