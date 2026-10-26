/**
 * A quiz run (SPEC-v3 §2 R7): up to 10 questions, A–D rows for multiple
 * choice and juist/fout, a text field for invullen and rekenen, one hint per
 * question, then a feedback panel with the explanation, every option's
 * "waarom", the source and "Volgende vraag". The end screen shows the score,
 * the mistakes, and "Deze 2 kaartjes komen morgen terug".
 */

import { h, fill } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { openSheet } from '../ui/overlay.ts';
import { buzz, chip, iconButton, ring } from '../ui/parts.ts';
import type { NumericAnswer } from '../lib/model.ts';
import {
  buildRun,
  scopeCourse,
  type Grade,
  type QuizAnswer,
  type QuizKind,
  type QuizQuestion,
  type QuizRun,
  type RunResult,
} from '../lib/quiz.ts';
import { clozeParts } from '../lib/text.ts';
import type { ModeHandle, PageEnv } from './shell.ts';

export function quizRunMode(env: PageEnv): ModeHandle {
  const { ctx, d, params } = env;
  const kind = params[0] as QuizKind;
  const scope = { kind, id: params[1] ?? '' };

  const title = h('span', { class: 'mode-title' });
  const counter = h('span', { class: 'mode-count' });
  const progress = h('i');
  const header = h(
    'header',
    { class: 'mode-head' },
    iconButton('close', 'Sluiten', () => close(), 'mode-close'),
    title,
    counter,
    h('span', { class: 'mode-progress', 'aria-hidden': 'true' }, progress),
  );
  const body = h('div', { class: 'mode-body' });
  const foot = h('div', { class: 'mode-foot' });
  const root = h('div', { class: 'mode quizrun' }, header, body, foot);

  let run: QuizRun | null = null;
  let index = 0;
  let grades = new Map<number, Grade>();
  let answered = false;
  let hintUsed = false;
  let finished = false;
  let busy = false;

  function start(): void {
    run = ['sessie', 'hoofdstuk', 'vak'].includes(kind) ? buildRun(scope, d.qdata) : null;
    index = 0;
    grades = new Map();
    finished = false;
    if (!run) return showNothing();
    const course = d.courses.get(run.course_id);
    const chapter = run.chapter_id ? d.chapters.get(run.chapter_id) : null;
    const label = run.scope.kind === 'vak' ? `${run.course_id} – Gemengde quiz` : chapter ? `${run.course_id} – ${chapter.title}` : run.title;
    title.replaceChildren(h('i', { class: 'dot', style: `--cc:${course?.color ?? '#2F6BFF'}` }), h('span', { class: 'mode-title-text', text: label }));
    showQuestion();
  }

  function updateCounter(): void {
    if (!run) return;
    const total = run.questions.length;
    counter.textContent = `${Math.min(index + 1, total)} / ${total}`;
    progress.style.width = `${Math.round(((index + (answered ? 1 : 0)) / total) * 100)}%`;
  }

  /* ---------------- a question ---------------- */

  function showQuestion(): void {
    if (!run) return;
    const q = run.questions[index];
    answered = false;
    hintUsed = false;
    updateCounter();

    const hintBox = h('p', { class: 'qz-hint', hidden: true });
    const hintLink = q.item.hint
      ? h(
          'button',
          {
            class: 'qz-hint-link',
            type: 'button',
            on: {
              click: () => {
                hintUsed = true;
                hintBox.replaceChildren(h('b', { text: 'Hint ' }), q.item.hint ?? '');
                hintBox.hidden = false;
                hintLink!.hidden = true;
              },
            },
          },
          h('span', { html: icon('hint', 16) }),
          'Hint',
        )
      : null;

    const parts = q.format === 'cloze' ? clozeParts(q.item.stem) : null;
    const stem = h(
      'p',
      { class: 'qz-stem' },
      parts ? [parts[0], h('span', { class: 'blank', 'aria-label': 'open plek' }), parts[1]] : q.item.stem,
    );

    let answerArea: HTMLElement;
    let submit: HTMLButtonElement | null = null;
    if (q.options) {
      answerArea = h(
        'div',
        { class: 'qz-options', role: 'list' },
        q.options.map((opt, i) =>
          h(
            'button',
            {
              class: 'qz-opt',
              type: 'button',
              role: 'listitem',
              dataset: { i: String(i) },
              on: {
                click: (event: MouseEvent) => {
                  const btn = event.currentTarget as HTMLElement;
                  if (answered) {
                    btn.classList.toggle('show-why');
                    return;
                  }
                  void answer(q, { option: i });
                },
              },
            },
            h('span', { class: 'qz-letter', text: opt.letter }),
            h('span', { class: 'qz-opt-main' }, h('span', { class: 'qz-opt-text', text: opt.text }), opt.why ? h('span', { class: 'qz-why', text: opt.why }) : null),
          ),
        ),
      );
    } else {
      const numeric = q.format === 'numeric';
      const unit = numeric ? ((q.item.answer as NumericAnswer | null)?.unit ?? '') : '';
      const input = h('input', {
        class: 'field qz-field',
        type: 'text',
        inputmode: numeric ? 'decimal' : 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        enterkeyhint: 'done',
        placeholder: numeric ? 'Je uitkomst' : 'Typ je antwoord',
        'aria-label': 'Je antwoord',
      });
      submit = h('button', { class: 'btn btn-primary btn-big btn-block', type: 'button', text: 'Controleer', disabled: true });
      input.addEventListener('input', () => {
        submit!.disabled = input.value.trim() === '';
      });
      const go = () => {
        if (input.value.trim() === '' || answered) return;
        input.blur();
        void answer(q, { text: input.value });
      };
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          go();
        }
      });
      submit.addEventListener('click', go);
      answerArea = h('div', { class: 'qz-typed' }, h('div', { class: 'qz-input-wrap' }, input, unit ? h('span', { class: 'qz-unit', text: unit }) : null));
      setTimeout(() => input.focus({ preventScroll: true }), 250);
    }

    const card = h(
      'article',
      { class: 'qz-card enter' },
      h('div', { class: 'qz-top' }, h('span', { class: 'qz-num', text: String(q.n) }), h('span', { class: 'qz-format', text: q.formatLabel })),
      stem,
      answerArea,
      hintBox,
      hintLink,
    );
    fill(body, card);
    fill(foot, submit ?? h('p', { class: 'qz-foot-help', text: 'Tik op het antwoord dat jij denkt' }));
    body.scrollTop = 0;
    requestAnimationFrame(() => card.classList.remove('enter'));
  }

  async function answer(q: QuizQuestion, given: QuizAnswer): Promise<void> {
    if (!run || answered || busy) return;
    busy = true;
    answered = true;
    try {
      const { grade } = await ctx.actions.answerQuiz(run, q, given, hintUsed);
      grades.set(q.n, grade);
      buzz(grade.correct ? 8 : 18);
      showFeedback(q, grade);
    } finally {
      busy = false;
    }
  }

  function showFeedback(q: QuizQuestion, grade: Grade): void {
    if (!run) return;
    updateCounter();
    // Mark the rows: the right one green, a wrong choice red, their "waarom" open.
    for (const row of body.querySelectorAll<HTMLElement>('.qz-opt')) {
      const opt = q.options?.[Number(row.dataset.i)];
      if (!opt) continue;
      row.classList.add('locked');
      if (opt.correct) row.classList.add('correct', 'show-why');
      if (grade.chosen && grade.chosen.index === opt.index) row.classList.add('chosen', 'show-why', opt.correct ? 'right' : 'wrong');
    }
    const field = body.querySelector<HTMLInputElement>('.qz-field');
    if (field) {
      field.readOnly = true;
      field.classList.add(grade.correct ? 'right' : 'wrong');
    }

    const panel = h(
      'section',
      { class: `feedback ${grade.correct ? 'good' : 'bad'}`, role: 'status' },
      h(
        'div',
        { class: 'feedback-head' },
        h('span', { class: 'feedback-icon', html: icon(grade.correct ? 'checkCircle' : 'wrongCircle', 26) }),
        h('b', { text: grade.correct ? 'Juist!' : 'Niet juist' }),
      ),
      !grade.correct && grade.expected
        ? q.format === 'tf'
          ? h('p', { class: 'feedback-expected' }, 'Deze uitspraak is ', h('strong', { text: grade.expected.toLowerCase() }), '.')
          : h('p', { class: 'feedback-expected' }, 'Juist antwoord: ', h('strong', { text: grade.expected }))
        : null,
      grade.correction ? h('p', { text: grade.correction }) : null,
      grade.explanation && !grade.steps.includes(grade.explanation) ? h('p', { text: grade.explanation }) : null,
      grade.steps.length > 0 ? h('ol', { class: 'feedback-steps' }, grade.steps.map((st) => h('li', { text: st }))) : null,
      q.options && q.options.some((o) => o.why) ? h('p', { class: 'feedback-tip', text: 'Tik op een antwoord om te zien waarom.' }) : null,
      q.item.source_label ? h('div', { class: 'feedback-meta' }, chip(q.item.source_label, 'chip-source')) : null,
    );
    body.querySelector('.qz-card')?.appendChild(panel);
    body.querySelector('.qz-hint-link')?.remove();
    const last = index >= run.questions.length - 1;
    const next = h(
      'button',
      { class: 'btn btn-primary btn-big btn-block', type: 'button', on: { click: () => void nextQuestion() } },
      last ? 'Bekijk je score' : 'Volgende vraag',
      h('span', { html: icon('arrowRight', 18) }),
    );
    fill(foot, next);
    requestAnimationFrame(() => panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    setTimeout(() => next.focus({ preventScroll: true }), 50);
  }

  async function nextQuestion(): Promise<void> {
    if (!run || busy) return;
    if (index < run.questions.length - 1) {
      index++;
      showQuestion();
      return;
    }
    busy = true;
    try {
      finished = true;
      const result = await ctx.actions.finishQuiz(run, grades);
      showEnd(result);
    } finally {
      busy = false;
    }
  }

  /* ---------------- the end ---------------- */

  function showEnd(result: RunResult): void {
    if (!run) return;
    counter.textContent = `${run.questions.length} / ${run.questions.length}`;
    progress.style.width = '100%';
    const share = result.total ? result.correct / result.total : 0;
    const message = share >= 0.8 ? 'Sterk gedaan!' : share >= 0.5 ? 'Goed bezig' : 'Nog even oefenen';
    fill(
      body,
      h(
        'div',
        { class: 'end quiz-end' },
        ring(share, 132, result.score),
        h('h1', { class: 'end-title', text: message }),
        h('p', { class: 'end-sub', text: `${run.kind_label} · ${run.title}` }),
        result.mistakes.length > 0
          ? h(
              'section',
              { class: 'card end-hard' },
              h('h2', { class: 'card-title', text: result.mistakes.length === 1 ? 'Je fout' : `Je ${result.mistakes.length} fouten` }),
              result.mistakes.map((m) =>
                h(
                  'button',
                  { class: 'card-row', type: 'button', on: { click: () => openMistake(m.question, m.grade) } },
                  h('span', { class: 'mistake-text' }, h('span', { class: 'mistake-q', text: m.question.item.stem }), h('small', { class: 'mistake-a', text: expectedLine(m.question, m.grade) })),
                  h('span', { class: 'chev', html: icon('chevronRight', 16) }),
                ),
              ),
            )
          : h('p', { class: 'end-note', text: 'Alles juist. Niets komt extra terug.' }),
        result.backLabel ? h('p', { class: 'back-tomorrow' }, h('span', { html: icon('calendar', 18) }), result.backLabel) : null,
      ),
    );
    fill(
      foot,
      h(
        'div',
        { class: 'end-actions' },
        h('button', { class: 'btn btn-soft btn-big', type: 'button', on: { click: () => start() } }, h('span', { html: icon('sync', 18) }), run.scope.kind === 'sessie' ? 'Opnieuw' : 'Nog een quiz'),
        h('button', { class: 'btn btn-primary btn-big', type: 'button', text: 'Klaar', on: { click: () => env.back('quiz') } }),
      ),
    );
    body.scrollTop = 0;
  }

  function openMistake(q: QuizQuestion, grade: Grade): void {
    openSheet(
      { title: `Vraag ${q.n} · ${q.formatLabel}` },
      h('p', { class: 'sheet-lead', text: q.item.stem }),
      grade.chosen ? h('p', { class: 'mistake-line wrong' }, h('span', { html: icon('wrongCircle', 18) }), `Jij: ${grade.chosen.text}`, grade.chosen.why ? h('small', { text: grade.chosen.why }) : null) : null,
      h('p', { class: 'mistake-line right' }, h('span', { html: icon('checkCircle', 18) }), expectedLine(q, grade), q.options?.find((o) => o.correct)?.why ? h('small', { text: q.options.find((o) => o.correct)!.why! }) : null),
      grade.correction ? h('p', { text: grade.correction }) : null,
      grade.explanation ? h('p', { class: 'muted', text: grade.explanation }) : null,
      q.item.source_label ? chip(q.item.source_label, 'chip-source') : null,
    );
  }

  function showNothing(): void {
    title.replaceChildren(h('span', { class: 'mode-title-text', text: 'Mini-quiz' }));
    counter.textContent = '';
    progress.style.width = '0';
    // Business English never has a quiz, whatever the address asked for (vak or hoofdstuk).
    const be = (['sessie', 'hoofdstuk', 'vak'].includes(kind) ? scopeCourse(scope, d.qdata) : null) === 'BE';
    fill(
      body,
      h(
        'div',
        { class: 'end' },
        h('span', { class: 'end-check muted', html: icon('quiz', 56) }),
        h('h1', { class: 'end-title', text: be ? 'Geen quiz voor Business English' : 'Nog geen vragen' }),
        h('p', { class: 'end-sub', text: be ? 'Business English heeft geen mini-quizzen; de kaartjes kan je wel overhoren.' : 'Deze quiz heeft (nog) geen vragen. Ze komen samen met je kaartjes binnen.' }),
      ),
    );
    fill(foot, h('button', { class: 'btn btn-primary btn-big btn-block', type: 'button', text: 'Terug', on: { click: () => env.back('quiz') } }));
  }

  /** Closing halfway: what he answered wrong still comes back tomorrow. */
  function saveHalfway(): void {
    if (run && !finished && grades.size > 0) {
      finished = true;
      void ctx.actions.finishQuiz(run, grades);
    }
  }

  function close(): void {
    saveHalfway();
    env.back('quiz');
  }

  const onKey = (e: KeyboardEvent) => {
    if (document.documentElement.classList.contains('sheet-open') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') return close();
    if (!run || finished) return;
    const q = run.questions[index];
    if (!answered && q.options) {
      const i = ['a', 'b', 'c', 'd'].indexOf(k) >= 0 ? ['a', 'b', 'c', 'd'].indexOf(k) : ['1', '2', '3', '4'].indexOf(k);
      if (i >= 0 && i < q.options.length) void answer(q, { option: i });
    } else if (answered && k === 'enter') {
      e.preventDefault();
      void nextQuestion();
    }
  };
  document.addEventListener('keydown', onKey);

  start();
  return {
    el: root,
    dispose: () => {
      document.removeEventListener('keydown', onKey);
      saveHalfway();
    },
  };
}

/** 'Juist: 260 stuks', or for juist/fout 'De uitspraak is fout'. */
function expectedLine(q: QuizQuestion, grade: Grade): string {
  if (q.format === 'tf') return `De uitspraak is ${grade.expected.toLowerCase()}`;
  return `Juist: ${grade.expected}`;
}
