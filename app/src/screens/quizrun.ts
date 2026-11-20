/**
 * A quiz run (SPEC-v3 §2 R7): up to 10 questions, A–D rows for multiple
 * choice and juist/fout, a text field for invullen and rekenen, one hint per
 * question, then a feedback panel with the explanation, every option's
 * "waarom", the source and "Volgende vraag". The end screen shows the score,
 * the mistakes, "Deze 2 kaartjes komen morgen terug" and "Oefen je fouten".
 *
 * quizrun/fouten/<run id> practises the mistakes of that run: a card answered
 * wrong again comes back at the end, in another wording, until every card is
 * right (at most three tries each). A little sound marks right and wrong
 * answers and the end (his wish, 30/10).
 */

import { h, fill } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { openSheet } from '../ui/overlay.ts';
import { buzz, chip, iconButton, ring } from '../ui/parts.ts';
import { sounds } from '../ui/sound.ts';
import type { NumericAnswer } from '../lib/model.ts';
import {
  buildMistakeRun,
  EXAM_FORMS,
  EXAM_MINUTES_PER_QUESTION,
  buildRun,
  cardsStillWrong,
  chapterScores,
  retryQuestion,
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
  /** A mock exam: no hints, no feedback between questions, a clock, the verdict at the end. */
  const exam = kind === 'examen';

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
  /** A typed fill-in answer graded wrong, not written yet (see settle). */
  let held: { q: QuizQuestion; given: QuizAnswer; grade: Grade; hintUsed: boolean } | null = null;
  let deadline = 0;
  let clock: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    run =
      kind === 'fouten' ? buildMistakeRun(scope.id, d.qdata) : ['sessie', 'hoofdstuk', 'vak', 'examen'].includes(kind) ? buildRun(scope, d.qdata) : null;
    index = 0;
    grades = new Map();
    finished = false;
    held = null;
    if (!run) return showNothing();
    const course = d.courses.get(run.course_id);
    const chapter = run.chapter_id ? d.chapters.get(run.chapter_id) : null;
    const label =
      run.scope.kind === 'fouten'
        ? `Je fouten · ${run.title}`
        : run.scope.kind === 'examen'
          ? `${run.course_id} – Proefexamen`
          : run.scope.kind === 'vak'
          ? `${run.course_id} – Gemengde quiz`
          : chapter
            ? `${run.course_id} – ${chapter.title}`
            : run.title;
    title.replaceChildren(h('i', { class: 'dot', style: `--cc:${course?.color ?? '#2F6BFF'}` }), h('span', { class: 'mode-title-text', text: label }));
    stopClock();
    if (exam) {
      deadline = Date.now() + run.questions.length * EXAM_MINUTES_PER_QUESTION * 60_000;
      clock = setInterval(tick, 1000);
    }
    showQuestion();
  }

  function stopClock(): void {
    if (clock) clearInterval(clock);
    clock = null;
  }

  /** 'mm:ss' left on the exam clock. */
  function timeLeft(): string {
    const sec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function tick(): void {
    if (!run || finished) return stopClock();
    if (Date.now() >= deadline) {
      stopClock();
      void endRun();
      return;
    }
    updateCounter();
  }

  function updateCounter(): void {
    if (!run) return;
    const total = run.questions.length;
    counter.textContent = exam && !finished ? `${Math.min(index + 1, total)} / ${total} · ${timeLeft()}` : `${Math.min(index + 1, total)} / ${total}`;
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
    const hintLink = q.item.hint && !exam
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
    fill(foot, submit ?? h('p', { class: 'qz-foot-help', text: exam ? 'Zoals op het examen: je ziet pas op het einde wat juist was' : 'Tik op het antwoord dat jij denkt' }));
    body.scrollTop = 0;
    requestAnimationFrame(() => card.classList.remove('enter'));
  }

  async function answer(q: QuizQuestion, given: QuizAnswer): Promise<void> {
    if (!run || answered || busy) return;
    busy = true;
    answered = true;
    let goOn = false;
    try {
      if (exam) {
        // Graded as written, no feedback now: straight to the next question.
        const { grade } = await ctx.actions.settleQuiz(run, q, given, ctx.actions.gradeQuiz(q, given), false);
        grades.set(q.n, grade);
        buzz(8);
        goOn = true;
        return;
      }
      // A typed fill-in the app calls wrong waits for his own verdict (settle()).
      const first = ctx.actions.gradeQuiz(q, given);
      if (ctx.actions.holdsForHim(q, given, first)) {
        held = { q, given, grade: first, hintUsed };
        grades.set(q.n, first);
        buzz(18);
        sounds.wrong();
        showFeedback(q, first);
        return;
      }
      const { grade } = await ctx.actions.settleQuiz(run, q, given, first, hintUsed);
      grades.set(q.n, grade);
      buzz(grade.correct ? 8 : 18);
      if (grade.correct) sounds.right();
      else sounds.wrong();
      afterWrong(q, grade);
      showFeedback(q, grade);
    } finally {
      busy = false;
      if (goOn) void nextQuestion();
    }
  }

  /** Practising mistakes: a wrong card comes back at the end, in another wording. */
  function afterWrong(q: QuizQuestion, grade: Grade): void {
    if (run && run.scope.kind === 'fouten' && !grade.correct) {
      const again = retryQuestion(run, q.item.card_id, d.qdata);
      if (again) run.questions.push(again);
    }
  }

  /** Write the held fill-in answer: as he judged it, or wrong when he just went on. */
  async function settle(meantSame: boolean): Promise<Grade | null> {
    const w = held;
    if (!run || !w) return null;
    held = null;
    const { grade } = await ctx.actions.settleQuiz(run, w.q, w.given, w.grade, w.hintUsed, meantSame);
    grades.set(w.q.n, grade);
    afterWrong(w.q, grade);
    return grade;
  }

  async function meantSame(q: QuizQuestion): Promise<void> {
    if (!held || busy) return;
    busy = true;
    try {
      const grade = await settle(true);
      if (!grade) return;
      buzz(8);
      sounds.right();
      body.querySelector('.feedback')?.remove();
      const field = body.querySelector<HTMLInputElement>('.qz-field');
      field?.classList.remove('wrong');
      showFeedback(q, grade, true);
    } finally {
      busy = false;
    }
  }

  function showFeedback(q: QuizQuestion, grade: Grade, self = false): void {
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
        h('b', { text: self ? 'Juist gerekend' : grade.correct ? 'Juist!' : 'Niet juist' }),
      ),
      self && grade.expected
        ? h('p', { class: 'feedback-expected' }, 'Het woord uit je cursus: ', h('strong', { text: grade.expected }))
        : null,
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
      held
        ? h(
            'div',
            { class: 'feedback-self' },
            h('p', { class: 'feedback-tip', text: 'Schreef je hetzelfde in andere woorden? Wees eerlijk: het woord uit je cursus moet je op het examen kennen.' }),
            h('button', { class: 'btn btn-soft btn-small', type: 'button', text: 'Ik bedoelde hetzelfde', on: { click: () => void meantSame(q) } }),
          )
        : null,
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
    if (held) {
      busy = true;
      try {
        await settle(false);
      } finally {
        busy = false;
      }
    }
    if (index < run.questions.length - 1) {
      index++;
      showQuestion();
      return;
    }
    await endRun();
  }

  /** The last question was answered, or the exam clock ran out. */
  async function endRun(): Promise<void> {
    if (!run || finished) return;
    busy = true;
    try {
      finished = true;
      stopClock();
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
    const practice = run.scope.kind === 'fouten';
    const left = practice ? cardsStillWrong(run, grades) : [];
    const practised = new Set(run.questions.map((q) => q.item.card_id)).size;
    const form = exam ? EXAM_FORMS[run.course_id] : null;
    const aim = form ? Math.ceil(form.target * result.total) : 0;
    const passed = form ? result.correct >= aim : false;
    const perChapter = exam ? chapterScores(run, grades, d.qdata.chapters) : [];
    const message = form
      ? passed
        ? 'Op examenniveau 🎉'
        : 'Nog niet op examenniveau'
      : practice
      ? left.length === 0
        ? 'Alles juist! 🎉'
        : `Nog ${left.length === 1 ? '1 kaartje' : `${left.length} kaartjes`} om te oefenen`
      : share >= 0.8
        ? 'Sterk gedaan!'
        : share >= 0.5
          ? 'Goed bezig'
          : 'Nog even oefenen';
    if (form ? passed : (practice && left.length === 0) || (!practice && share >= 0.8)) sounds.fanfare();
    else sounds.done();
    // The cards that went wrong in this run, for "Oefen je fouten".
    const toFix = practice ? left.length : new Set(result.mistakes.map((m) => m.question.item.card_id)).size;
    fill(
      body,
      h(
        'div',
        { class: 'end quiz-end' },
        practice ? ring(left.length === 0 ? 1 : (practised - left.length) / practised, 132, `${practised - left.length}/${practised}`) : ring(share, 132, result.score),
        h('h1', { class: 'end-title', text: message }),
        h('p', {
          class: 'end-sub',
          text: form
            ? `${form.label} · je mikt op ${aim}/${result.total}${grades.size < result.total ? ` · ${result.total - grades.size} niet beantwoord` : ''}`
            : practice
            ? left.length === 0
              ? `Je kent ze nu allemaal. Morgen komen ze nog één keer terug, om het te laten plakken.`
              : 'Doe ze gerust nog een keer: elke keer in andere woorden.'
            : `${run.kind_label} · ${run.title}`,
        }),
        perChapter.length > 1
          ? h(
              'section',
              { class: 'card end-hard exam-chapters' },
              h('h2', { class: 'card-title', text: 'Per hoofdstuk' }),
              perChapter.map((c) => {
                const part = c.total ? c.correct / c.total : 0;
                return h(
                  'div',
                  { class: 'score-line' },
                  h('span', { class: `score-dot ${part >= 0.8 ? 'good' : part >= 0.5 ? 'mid' : 'bad'}` }),
                  h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: c.title ? `${c.code} · ${c.title}` : c.code })),
                  h('b', { class: 'score-value', text: `${c.correct}/${c.total}` }),
                );
              }),
            )
          : null,
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
    const fixRun = run.run_id;
    fill(
      foot,
      toFix > 0
        ? h(
            'button',
            {
              class: 'btn btn-primary btn-big btn-block fix-btn',
              type: 'button',
              on: { click: () => env.go(`quizrun/fouten/${fixRun}`, { replace: true }) },
            },
            h('span', { html: icon('target', 18) }),
            practice ? `Nog eens · ${toFix === 1 ? '1 kaartje' : `${toFix} kaartjes`}` : `Oefen je fouten · ${toFix === 1 ? '1 kaartje' : `${toFix} kaartjes`}`,
          )
        : null,
      h(
        'div',
        { class: 'end-actions' },
        practice
          ? null
          : h('button', { class: 'btn btn-soft btn-big', type: 'button', on: { click: () => start() } }, h('span', { html: icon('sync', 18) }), exam ? 'Nieuw examen' : run.scope.kind === 'sessie' ? 'Opnieuw' : 'Nog een quiz'),
        h('button', { class: `btn ${toFix > 0 ? 'btn-soft' : 'btn-primary'} btn-big`, type: 'button', text: 'Klaar', on: { click: () => env.back('quiz') } }),
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
    const be = (['sessie', 'hoofdstuk', 'vak', 'examen'].includes(kind) ? scopeCourse(scope, d.qdata) : null) === 'BE';
    const fouten = kind === 'fouten';
    fill(
      body,
      h(
        'div',
        { class: 'end' },
        h('span', { class: 'end-check muted', html: icon(fouten ? 'checkCircle' : 'quiz', 56) }),
        h('h1', { class: 'end-title', text: fouten ? 'Geen fouten om te oefenen' : be ? 'Geen quiz voor Business English' : 'Nog geen vragen' }),
        h('p', {
          class: 'end-sub',
          text: fouten
            ? 'Alles uit die quiz was juist, of de kaartjes zijn er niet meer.'
            : be
              ? 'Business English heeft geen mini-quizzen; de kaartjes kan je wel overhoren.'
              : 'Deze quiz heeft (nog) geen vragen. Ze komen samen met je kaartjes binnen.',
        }),
      ),
    );
    fill(foot, h('button', { class: 'btn btn-primary btn-big btn-block', type: 'button', text: 'Terug', on: { click: () => env.back('quiz') } }));
  }

  /** Closing halfway: what he answered wrong still comes back tomorrow. */
  function saveHalfway(): void {
    const r = run;
    stopClock();
    if (r && !finished && grades.size > 0) {
      finished = true;
      // A fill-in answer still waiting for his verdict counts as the app graded it.
      void settle(false).then(() => ctx.actions.finishQuiz(r, grades));
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
      stopClock();
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
