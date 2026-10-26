/**
 * Mini-quizzes (SPEC-v3 §2 "Quiz" and his additions of 24/10).
 *
 * Three kinds, none of them for Business English:
 *
 *   sessie     "Na je studie": made by the course project right after a lesson
 *              or self-study. Its questions are fixed (quizzes.item_ids), so
 *              a retry is the same quiz; only the option order changes.
 *   hoofdstuk  The chapter quiz: 10 questions sampled from the chapter's pool.
 *   vak        The mixed course quiz: 10 questions from every chapter.
 *
 * A sampled run takes at most one item per card, mixes the formats, prefers
 * items he did not see in his last two runs over the same material, and
 * shuffles the options. The pool grows every night, so runs keep changing.
 *
 * Grading is lenient where a person would be: typed answers ignore case,
 * accents, punctuation and a leading article, forgive one typo in a longer
 * word, and numbers are read the Belgian way ("41.000" is forty-one thousand,
 * "877,95" has a decimal comma).
 *
 * A wrong answer sends the card back tomorrow (a `quiz_fout` review row, box
 * unchanged; leitner.ts). A right answer changes nothing.
 */

import {
  hasQuizzes,
  type Card,
  type Chapter,
  type ClozeAnswer,
  type Course,
  type NumericAnswer,
  type Quiz,
  type QuizAttempt,
  type QuizFormat,
  type QuizItem,
  type StudySession,
  type TfAnswer,
} from './model.ts';
import { instant, studyDay } from './dates.ts';

/** Questions in a sampled run. */
export const RUN_LENGTH = 10;

/** Items from this many recent runs over the same material are avoided. */
export const RECENT_RUNS = 2;

/* ------------------------------------------------------------------ *
 * Scopes
 * ------------------------------------------------------------------ */

export type QuizKind = 'sessie' | 'hoofdstuk' | 'vak';

/** What a run covers. `id` is a quiz id, a chapter id or a course id. */
export interface QuizScope {
  kind: QuizKind;
  id: string;
}

/** 'sessie:<quiz_id>', 'hoofdstuk:<chapter_id>' or 'vak:<course_id>' (quiz_attempts.scope). */
export function scopeKey(scope: QuizScope): string {
  return `${scope.kind}:${scope.id}`;
}

export function parseScope(value: string | null | undefined): QuizScope | null {
  const m = /^(sessie|hoofdstuk|vak):(.+)$/.exec(value ?? '');
  return m ? { kind: m[1] as QuizKind, id: m[2] } : null;
}

/** 'Na je studie', 'Hoofdstukquiz', 'Gemengde quiz'. */
export const KIND_LABELS: Record<QuizKind, string> = {
  sessie: 'Na je studie',
  hoofdstuk: 'Hoofdstukquiz',
  vak: 'Gemengde quiz',
};

/** The tag on each question. */
export const FORMAT_LABELS: Record<QuizFormat, string> = {
  mcq: 'Meerkeuze',
  tf: 'Juist of fout',
  cloze: 'Invullen',
  numeric: 'Rekenen',
};

/** Everything the quiz needs from the local data. */
export interface QuizData {
  courses: readonly Course[];
  chapters: readonly Chapter[];
  cards: readonly Card[];
  items: readonly QuizItem[];
  quizzes: readonly Quiz[];
  sessions?: readonly StudySession[];
  attempts: readonly QuizAttempt[];
}

/** Which course a scope belongs to, or null when it points at nothing known. */
export function scopeCourse(scope: QuizScope, data: Pick<QuizData, 'chapters' | 'quizzes'>): string | null {
  if (scope.kind === 'vak') return scope.id;
  if (scope.kind === 'hoofdstuk') return data.chapters.find((c) => c.id === scope.id)?.course_id ?? null;
  return data.quizzes.find((q) => q.id === scope.id)?.course_id ?? null;
}

/* ------------------------------------------------------------------ *
 * The pool
 * ------------------------------------------------------------------ */

/**
 * Can this item be asked? Live item, live card, not Business English.
 * A card that waits for a check (needs_check) or was retired takes its items
 * out with it, so a quiz never asks about something the queue would hide.
 */
function usable(item: QuizItem | undefined, cards: ReadonlyMap<string, Card>): item is QuizItem {
  if (!item || item.status !== 'live' || !hasQuizzes(item.course_id)) return false;
  return cards.get(item.card_id)?.status === 'live';
}

function cardMap(cards: readonly Card[]): Map<string, Card> {
  return new Map(cards.map((c) => [c.id, c]));
}

/** The items a chapter quiz or a course quiz samples from (empty for BE). */
export function poolFor(scope: QuizScope, data: Pick<QuizData, 'cards' | 'items' | 'quizzes'>): QuizItem[] {
  const cards = cardMap(data.cards);
  if (scope.kind === 'sessie') {
    const quiz = data.quizzes.find((q) => q.id === scope.id);
    if (!quiz) return [];
    const byId = new Map(data.items.map((i) => [i.id, i]));
    return quiz.item_ids.map((id) => byId.get(id)).filter((i) => usable(i, cards));
  }
  return data.items.filter(
    (i) => usable(i, cards) && (scope.kind === 'hoofdstuk' ? i.chapter_id === scope.id : i.course_id === scope.id),
  );
}

/**
 * How many questions a sampled run over this pool asks: at most one per card,
 * so a chapter with 9 cards gives 9 questions even when it holds 27 items.
 */
export function runLength(pool: readonly QuizItem[], n: number = RUN_LENGTH): number {
  return Math.min(n, new Set(pool.map((i) => i.card_id)).size);
}

/**
 * Items seen in the last `runs` runs that touched this pool, whatever their
 * scope. Doing the session quiz and then the chapter quiz straight after
 * should not ask the same questions twice.
 */
export function recentItemIds(
  attempts: readonly QuizAttempt[],
  poolIds: ReadonlySet<string>,
  runs: number = RECENT_RUNS,
): Set<string> {
  const byRun = new Map<string, { items: Set<string>; last: number; touches: boolean }>();
  for (const a of attempts) {
    let run = byRun.get(a.run_id);
    if (!run) byRun.set(a.run_id, (run = { items: new Set(), last: 0, touches: false }));
    run.items.add(a.item_id);
    run.last = Math.max(run.last, instant(a.answered_at));
    if (poolIds.has(a.item_id)) run.touches = true;
  }
  const recent = new Set<string>();
  [...byRun.values()]
    .filter((r) => r.touches)
    .sort((a, b) => b.last - a.last)
    .slice(0, runs)
    .forEach((r) => r.items.forEach((id) => recent.add(id)));
  return recent;
}

/** Fisher–Yates on a copy. `rng` returns [0, 1). */
export function shuffle<T>(list: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick up to `n` items: at most one per card, formats as even as the pool
 * allows, unseen items before recently seen ones, in random order.
 *
 * Step by step: the cards are shuffled, cards that still have an unseen item
 * go first, and each step takes the first card that offers one of the formats
 * used least so far. That keeps the randomness of the card order while it
 * stops ten multiple-choice questions in a row when the pool has other formats.
 */
export function sampleItems(
  pool: readonly QuizItem[],
  recent: ReadonlySet<string>,
  n: number = RUN_LENGTH,
  rng: () => number = Math.random,
): QuizItem[] {
  const byCard = new Map<string, QuizItem[]>();
  for (const item of pool) {
    let list = byCard.get(item.card_id);
    if (!list) byCard.set(item.card_id, (list = []));
    list.push(item);
  }
  // Per card, the unseen items, or all of them when every one was seen lately.
  const candidates = new Map<string, QuizItem[]>();
  const fresh = new Set<string>();
  for (const [cardId, items] of byCard) {
    const unseen = items.filter((i) => !recent.has(i.id));
    candidates.set(cardId, unseen.length > 0 ? unseen : items);
    if (unseen.length > 0) fresh.add(cardId);
  }

  const order = shuffle([...byCard.keys()], rng);
  let remaining = [...order.filter((id) => fresh.has(id)), ...order.filter((id) => !fresh.has(id))];
  const used: Record<QuizFormat, number> = { mcq: 0, tf: 0, cloze: 0, numeric: 0 };
  const picked: QuizItem[] = [];

  while (picked.length < n && remaining.length > 0) {
    // Fresh cards are used up before a recently seen card is asked again.
    const tier = remaining.some((id) => fresh.has(id)) ? remaining.filter((id) => fresh.has(id)) : remaining;
    const offered = new Set<QuizFormat>();
    for (const id of tier) for (const i of candidates.get(id)!) offered.add(i.format);
    const least = Math.min(...[...offered].map((f) => used[f]));
    const wanted = new Set([...offered].filter((f) => used[f] === least));

    const cardId = tier.find((id) => candidates.get(id)!.some((i) => wanted.has(i.format)))!;
    const options = candidates.get(cardId)!.filter((i) => wanted.has(i.format));
    const choice = options[Math.floor(rng() * options.length)];
    used[choice.format]++;
    picked.push(choice);
    remaining = remaining.filter((id) => id !== cardId);
  }
  return shuffle(picked, rng);
}

/** A card whose latest quiz answer was wrong, this many days back at most, is a weak spot. */
export const WEAK_DAYS = 21;

/** At most this share of a sampled quiz goes to weak spots; the rest stays fresh material. */
export const WEAK_SHARE = 0.4;

/** Cards whose most recent quiz answer was wrong (within WEAK_DAYS). */
export function weakCards(attempts: readonly QuizAttempt[], now: number = Date.now()): Set<string> {
  const last = new Map<string, { at: number; correct: boolean }>();
  for (const a of attempts) {
    const at = instant(a.answered_at);
    const prev = last.get(a.card_id);
    if (!prev || at > prev.at) last.set(a.card_id, { at, correct: a.correct });
  }
  const out = new Set<string>();
  for (const [cardId, v] of last) if (!v.correct && now - v.at <= WEAK_DAYS * 86_400_000) out.add(cardId);
  return out;
}

/**
 * Like sampleItems, but a quiz first goes back to what went wrong lately (his
 * wish, 26/10: "extra focus op de fouten"): up to 40% of the questions come
 * from weak cards, asked in another wording when the card has one (the item
 * that went wrong was in a recent run, so an unseen one is preferred). The rest
 * is sampled as usual, so every run still brings new questions.
 */
export function sampleAdaptive(
  pool: readonly QuizItem[],
  recent: ReadonlySet<string>,
  weak: ReadonlySet<string>,
  n: number = RUN_LENGTH,
  rng: () => number = Math.random,
): QuizItem[] {
  const weakPool = pool.filter((i) => weak.has(i.card_id));
  const nWeak = Math.min(Math.ceil(n * WEAK_SHARE), new Set(weakPool.map((i) => i.card_id)).size);
  const first = nWeak > 0 ? sampleItems(weakPool, recent, nWeak, rng) : [];
  const taken = new Set(first.map((i) => i.card_id));
  const rest = sampleItems(pool.filter((i) => !taken.has(i.card_id)), recent, n - first.length, rng);
  return shuffle([...first, ...rest], rng);
}

/* ------------------------------------------------------------------ *
 * A run
 * ------------------------------------------------------------------ */

/** One option as shown: its letter, and where it sat in the stored item. */
export interface ShownOption {
  letter: string; // 'A'…'D'
  text: string;
  correct: boolean;
  /** The one-line "waarom", shown when the option is tapped after answering. */
  why: string | null;
  /** Position in quiz_items.options. */
  index: number;
}

export interface QuizQuestion {
  /** 1-based, for the number badge and "3 / 10". */
  n: number;
  item: QuizItem;
  format: QuizFormat;
  formatLabel: string;
  /** Rows A–D for mcq (shuffled) and tf (Juist, Fout); null for typed answers. */
  options: ShownOption[] | null;
}

export interface QuizRun {
  run_id: string;
  scope: QuizScope;
  scope_key: string;
  kind_label: string;
  /** 'SCM H3 · dia 121–135' for a session quiz, 'SCM H3' for a chapter, the course name for a course quiz. */
  title: string;
  course_id: string;
  chapter_id: string | null;
  questions: QuizQuestion[];
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** The options as shown: mcq shuffled, tf always Juist then Fout. */
export function showOptions(item: QuizItem, rng: () => number = Math.random): ShownOption[] | null {
  if (!item.options || (item.format !== 'mcq' && item.format !== 'tf')) return null;
  const indexed = item.options.map((o, index) => ({ ...o, index }));
  const ordered =
    item.format === 'mcq'
      ? shuffle(indexed, rng)
      : [...indexed].sort((a, b) => Number(b.text === 'Juist') - Number(a.text === 'Juist'));
  return ordered.map((o, i) => ({
    letter: LETTERS[i] ?? String(i + 1),
    text: o.text,
    correct: o.correct === true,
    why: o.why ?? null,
    index: o.index,
  }));
}

export interface RunOptions {
  rng?: () => number;
  runId?: string;
  n?: number;
  /** For the weak-spot window (tests); defaults to now. */
  now?: number;
}

/**
 * A quiz run, ready to show. Null when there is nothing to ask: an unknown
 * scope, an empty pool, or Business English (which never has quizzes).
 */
export function buildRun(scope: QuizScope, data: QuizData, options: RunOptions = {}): QuizRun | null {
  const rng = options.rng ?? Math.random;
  const courseId = scopeCourse(scope, data);
  if (!courseId || !hasQuizzes(courseId)) return null;

  let items: QuizItem[];
  let title: string;
  let chapterId: string | null = null;
  const weak = weakCards(data.attempts, options.now ?? Date.now());
  if (scope.kind === 'sessie') {
    const quiz = data.quizzes.find((q) => q.id === scope.id)!;
    const fixed = poolFor(scope, data); // the questions chosen when the session was saved
    title = quiz.title;
    chapterId = quiz.chapter_id;
    if (!data.attempts.some((a) => a.scope === scopeKey(scope))) {
      items = fixed;
    } else {
      // Done before: same material, other questions. All items of the session's
      // cards, unseen ones and weak cards first, in random order.
      const cards = cardMap(data.cards);
      const cardIds = new Set(fixed.map((i) => i.card_id));
      const pool = data.items.filter((i) => cardIds.has(i.card_id) && usable(i, cards));
      const recent = recentItemIds(data.attempts, new Set(pool.map((i) => i.id)));
      const ordered = shuffle(pool, rng).sort(
        (a, b) => Number(recent.has(a.id)) - Number(recent.has(b.id)) || Number(!weak.has(a.card_id)) - Number(!weak.has(b.card_id)),
      );
      items = shuffle(ordered.slice(0, Math.max(fixed.length, 1)), rng);
    }
  } else {
    const pool = poolFor(scope, data);
    const recent = recentItemIds(data.attempts, new Set(pool.map((i) => i.id)));
    items = sampleAdaptive(pool, recent, weak, options.n ?? RUN_LENGTH, rng);
    if (scope.kind === 'hoofdstuk') {
      const chapter = data.chapters.find((c) => c.id === scope.id)!;
      chapterId = chapter.id;
      title = `${chapter.course_id} ${chapter.code}`;
    } else {
      title = data.courses.find((c) => c.id === courseId)?.name ?? courseId;
    }
  }
  if (items.length === 0) return null;

  return {
    run_id: options.runId ?? crypto.randomUUID(),
    scope,
    scope_key: scopeKey(scope),
    kind_label: KIND_LABELS[scope.kind],
    title,
    course_id: courseId,
    chapter_id: chapterId,
    questions: items.map((item, i) => ({
      n: i + 1,
      item,
      format: item.format,
      formatLabel: FORMAT_LABELS[item.format],
      options: showOptions(item, rng),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Reading typed answers
 * ------------------------------------------------------------------ */

const ARTICLES = new Set(['de', 'het', 'een', "'t", 'the', 'a', 'an']);

/** Lower case, no accents, no punctuation, single spaces, no leading article. */
export function normalizeAnswer(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.join(' ');
}

/** Edit distance, stopping early once it is above `max`. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Does a typed answer match one of the accepted ones?
 * Exact after normalising, or one typo away when the accepted answer is
 * longer than 5 characters ("economisch" for "economische" passes, "BTW" for
 * "BTE" does not).
 */
export function matchCloze(typed: string, accept: readonly string[]): boolean {
  const given = normalizeAnswer(typed);
  if (!given) return false;
  for (const option of accept) {
    const want = normalizeAnswer(option);
    if (!want) continue;
    if (given === want) return true;
    if (want.length > 5 && levenshtein(given, want, 1) <= 1) return true;
  }
  return false;
}

/** Thousands grouping: a first group of 1-3 digits, then groups of exactly 3. */
function validGroups(text: string, sep: string): boolean {
  const parts = text.split(sep);
  return /^\d{1,3}$/.test(parts[0]) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * A number as a Belgian student types it, or null.
 *
 *   "41.000" -> 41000        a lone dot before exactly 3 digits groups thousands
 *   "877,95" -> 877.95       the comma is the decimal sign
 *   "1.234.567,8" -> 1234567.8
 *   "2.5" -> 2.5, "0.125" -> 0.125
 *   "€ 1 250,50", "-12 %", "2020 stuks" -> the number inside
 */
export function parseBelgianNumber(input: string): number | null {
  const s = input.replace(/[\s   ]/g, '').replace(/[−–]/g, '-');
  const m = /[-+]?[\d.,]*\d[\d.,]*/.exec(s);
  if (!m) return null;
  let t = m[0];
  let sign = 1;
  if (t[0] === '-' || t[0] === '+') {
    if (t[0] === '-') sign = -1;
    t = t.slice(1);
  }
  t = t.replace(/[.,]+$/, ''); // "12." or "12," at the end of a sentence
  const dots = (t.match(/\./g) ?? []).length;
  const commas = (t.match(/,/g) ?? []).length;
  let value: number;

  if (dots > 0 && commas > 0) {
    const decimal = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    const parts = t.split(decimal);
    if (parts.length !== 2 || !validGroups(parts[0], thousands)) return null;
    value = Number(parts[0].split(thousands).join('') + '.' + parts[1]);
  } else if (commas > 0) {
    if (commas === 1) value = Number(t.replace(',', '.'));
    else if (validGroups(t, ',')) value = Number(t.split(',').join(''));
    else return null;
  } else if (dots > 0) {
    if (dots === 1) {
      const [whole, frac] = t.split('.');
      const grouped = frac.length === 3 && whole.length >= 1 && whole.length <= 3 && /[1-9]/.test(whole);
      value = grouped ? Number(whole + frac) : Number(t);
    } else if (validGroups(t, '.')) {
      value = Number(t.split('.').join(''));
    } else {
      return null;
    }
  } else {
    value = Number(t);
  }
  return Number.isFinite(value) ? sign * value : null;
}

/** 2020 -> '2.020', 877.95 -> '877,95' (nl-BE). */
export function formatBelgianNumber(value: number, maxDecimals = 2): string {
  return new Intl.NumberFormat('nl-BE', { maximumFractionDigits: maxDecimals }).format(value);
}

/** Within tolerance? Without one, 1% of the value counts as right. */
export function matchNumeric(typed: string, answer: NumericAnswer): boolean {
  const value = parseBelgianNumber(typed);
  if (value === null || typeof answer.value !== 'number') return false;
  const tolerance =
    typeof answer.tolerance === 'number' && answer.tolerance >= 0
      ? answer.tolerance
      : Math.abs(answer.value) * 0.01;
  return Math.abs(value - answer.value) <= tolerance + 1e-9;
}

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

/** A tap on option row `option` (index into question.options), or typed text. */
export type QuizAnswer = { option: number } | { text: string };

export interface Grade {
  correct: boolean;
  /** The right answer as text: the correct option, the first accepted word, or '2.020 stuks'. */
  expected: string;
  /** The option he tapped, when he tapped one. */
  chosen: ShownOption | null;
  /** The item's explanation (shown under "Juist!" / "Niet juist"). */
  explanation: string | null;
  /** tf: the corrected statement when the statement was false. */
  correction: string | null;
  /** numeric: the worked steps. */
  steps: string[];
}

function expectedText(q: QuizQuestion): string {
  const item = q.item;
  if (item.format === 'cloze') return (item.answer as ClozeAnswer | null)?.accept?.[0] ?? '';
  if (item.format === 'numeric') {
    const a = item.answer as NumericAnswer | null;
    if (!a || typeof a.value !== 'number') return '';
    return a.unit ? `${formatBelgianNumber(a.value)} ${a.unit}` : formatBelgianNumber(a.value);
  }
  return q.options?.find((o) => o.correct)?.text ?? '';
}

export function gradeAnswer(q: QuizQuestion, answer: QuizAnswer): Grade {
  const item = q.item;
  let correct = false;
  let chosen: ShownOption | null = null;
  if ('option' in answer) {
    chosen = q.options?.[answer.option] ?? null;
    correct = chosen?.correct === true;
  } else if (item.format === 'cloze') {
    correct = matchCloze(answer.text, (item.answer as ClozeAnswer | null)?.accept ?? []);
  } else if (item.format === 'numeric') {
    correct = item.answer ? matchNumeric(answer.text, item.answer as NumericAnswer) : false;
  }
  return {
    correct,
    expected: expectedText(q),
    chosen,
    explanation: item.explanation,
    correction: item.format === 'tf' ? ((item.answer as TfAnswer | null)?.correction ?? null) : null,
    steps: item.format === 'numeric' ? ((item.answer as NumericAnswer | null)?.steps ?? []) : [],
  };
}

/** The quiz_attempts row for one answer. The id is made here, so a resend is harmless. */
export function attemptRow(
  run: Pick<QuizRun, 'run_id' | 'scope_key'>,
  q: QuizQuestion,
  answer: QuizAnswer,
  grade: Pick<Grade, 'correct' | 'chosen'>,
  hintUsed: boolean,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): QuizAttempt {
  return {
    id,
    run_id: run.run_id,
    item_id: q.item.id,
    card_id: q.item.card_id,
    scope: run.scope_key,
    correct: grade.correct,
    answer: 'option' in answer
      ? { option: grade.chosen?.index ?? null, text: grade.chosen?.text ?? null }
      : { text: answer.text },
    hint_used: hintUsed,
    answered_at: now.toISOString(),
    day: studyDay(now),
  };
}

/* ------------------------------------------------------------------ *
 * The end screen
 * ------------------------------------------------------------------ */

export interface RunResult {
  correct: number;
  total: number;
  /** '8/10'. */
  score: string;
  /** The questions answered wrong, in order (tappable on the end screen). */
  mistakes: { question: QuizQuestion; grade: Grade }[];
  /** Cards that come back tomorrow, one per card. */
  backTomorrow: string[];
  /** 'Deze 2 kaartjes komen morgen terug', or null when all were right. */
  backLabel: string | null;
}

/** `grades` by question number (1-based). Unanswered questions count as not right. */
export function summarizeRun(run: QuizRun, grades: ReadonlyMap<number, Grade>): RunResult {
  const mistakes: RunResult['mistakes'] = [];
  let correct = 0;
  for (const q of run.questions) {
    const grade = grades.get(q.n);
    if (grade?.correct) correct++;
    else if (grade) mistakes.push({ question: q, grade });
  }
  const back = [...new Set(mistakes.map((m) => m.question.item.card_id))];
  return {
    correct,
    total: run.questions.length,
    score: `${correct}/${run.questions.length}`,
    mistakes,
    backTomorrow: back,
    backLabel:
      back.length === 0
        ? null
        : back.length === 1
          ? 'Dit kaartje komt morgen terug'
          : `Deze ${back.length} kaartjes komen morgen terug`,
  };
}

/* ------------------------------------------------------------------ *
 * Lists for the Quiz tab, Home and Voortgang
 * ------------------------------------------------------------------ */

export interface RunScore {
  run_id: string;
  scope: string | null;
  course_id: string | null;
  day: string;
  /** Last answer, ms since epoch. */
  at: number;
  correct: number;
  total: number;
}

/** One line per run (newest first), built from the attempts log. */
export function runScores(data: Pick<QuizData, 'attempts' | 'cards' | 'chapters' | 'quizzes'>): RunScore[] {
  const cards = cardMap(data.cards);
  const runs = new Map<string, RunScore>();
  for (const a of data.attempts) {
    let run = runs.get(a.run_id);
    if (!run) {
      const scope = parseScope(a.scope);
      run = {
        run_id: a.run_id,
        scope: a.scope,
        course_id: (scope && scopeCourse(scope, data)) ?? cards.get(a.card_id)?.course_id ?? null,
        day: a.day,
        at: 0,
        correct: 0,
        total: 0,
      };
      runs.set(a.run_id, run);
    }
    run.total++;
    if (a.correct) run.correct++;
    const at = instant(a.answered_at);
    if (at >= run.at) {
      run.at = at;
      run.day = a.day;
    }
  }
  return [...runs.values()].sort((a, b) => b.at - a.at);
}

export interface SessionQuizEntry {
  quiz: Quiz;
  session: StudySession | null;
  /** The questions a run asks (its live items; retired ones drop out). */
  questions: number;
  /**
   * Done once from start to end. Until then it is "Nieuwe quiz" on Home: a run
   * closed after two questions does not make it disappear.
   */
  done: boolean;
  /** Runs that answered every question. */
  runs: number;
  /** The latest complete run. */
  last: RunScore | null;
}

/** Runs of one scope that answered at least `questions` questions, newest first. */
function completeRuns(scores: readonly RunScore[], scope: string, questions: number): RunScore[] {
  return scores.filter((s) => s.scope === scope && s.total >= Math.max(1, questions));
}

/** "Na je studie": open ones first (newest first), then done ones (most recently done first). */
export function sessionQuizList(data: QuizData): SessionQuizEntry[] {
  const scores = runScores(data);
  const entries = data.quizzes
    .filter((q) => q.kind === 'sessie' && hasQuizzes(q.course_id))
    .map((quiz) => {
      const questions = poolFor({ kind: 'sessie', id: quiz.id }, data).length;
      const mine = completeRuns(scores, `sessie:${quiz.id}`, questions);
      return {
        quiz,
        session: data.sessions?.find((s) => s.id === quiz.session_id) ?? null,
        questions,
        done: mine.length > 0,
        runs: mine.length,
        last: mine[0] ?? null,
      };
    })
    .filter((e) => e.questions > 0);
  const open = entries.filter((e) => !e.done).sort((a, b) => instant(b.quiz.created_at) - instant(a.quiz.created_at));
  const done = entries.filter((e) => e.done).sort((a, b) => b.last!.at - a.last!.at);
  return [...open, ...done];
}

export interface ChapterQuizEntry {
  chapter: Chapter;
  /** Questions in the chapter's pool. */
  pool: number;
  /** Questions one run asks (at most 10, at most one per card). */
  questions: number;
  /** Notion says the chapter is finished (🟢 Volledig gezien or 🏆). */
  finished: boolean;
  /** Finished and its chapter quiz not done yet: "Hoofdstuk af · doe de hoofdstukquiz". */
  highlighted: boolean;
  runs: number;
  last: RunScore | null;
}

export function isFinished(chapter: Pick<Chapter, 'status'>): boolean {
  return chapter.status === 'af' || chapter.status === 'examenklaar';
}

/** "Per hoofdstuk": chapters with questions, by course order then chapter order. BE never. */
export function chapterQuizList(data: QuizData): ChapterQuizEntry[] {
  const scores = runScores(data);
  const courseSort = new Map(data.courses.map((c) => [c.id, c.sort]));
  return data.chapters
    .filter((c) => hasQuizzes(c.course_id))
    .map((chapter) => {
      const scope = `hoofdstuk:${chapter.id}`;
      const mine = scores.filter((s) => s.scope === scope);
      const finished = isFinished(chapter);
      const items = poolFor({ kind: 'hoofdstuk', id: chapter.id }, data);
      const questions = runLength(items);
      // The highlight stays until one chapter quiz was done to the end.
      const complete = completeRuns(scores, scope, questions);
      return {
        chapter,
        pool: items.length,
        questions,
        finished,
        highlighted: finished && complete.length === 0,
        runs: mine.length,
        last: mine[0] ?? null,
      };
    })
    .filter((e) => e.pool > 0)
    .sort(
      (a, b) =>
        (courseSort.get(a.chapter.course_id) ?? 99) - (courseSort.get(b.chapter.course_id) ?? 99) ||
        a.chapter.sort - b.chapter.sort ||
        a.chapter.id.localeCompare(b.chapter.id),
    );
}

export interface CourseQuizEntry {
  course: Course;
  pool: number;
  /** Questions one run asks (at most 10, at most one per card). */
  questions: number;
  /** Runs of any kind over this course's material. */
  runs: number;
  /** Mean share right over the last 5 runs (0..1), or null before the first. */
  average: number | null;
  /** The last 5 runs' shares, oldest first, for the trend line. */
  trend: number[];
}

/** "Gemengd per vak", plus the quiz average and trend Voortgang shows. BE never. */
export function courseQuizList(data: QuizData): CourseQuizEntry[] {
  const scores = runScores(data);
  return [...data.courses]
    .filter((c) => hasQuizzes(c.id))
    .sort((a, b) => a.sort - b.sort)
    .map((course) => {
      const mine = scores.filter((s) => s.course_id === course.id && s.total > 0);
      const last5 = mine.slice(0, 5).reverse().map((s) => s.correct / s.total);
      const items = poolFor({ kind: 'vak', id: course.id }, data);
      return {
        course,
        pool: items.length,
        questions: runLength(items),
        runs: mine.length,
        average: last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : null,
        trend: last5,
      };
    })
    .filter((e) => e.pool > 0);
}

export type HomeQuizSuggestion =
  | { kind: 'sessie'; entry: SessionQuizEntry; label: string }
  | { kind: 'hoofdstuk'; entry: ChapterQuizEntry; label: string }
  | null;

/**
 * What Home offers: the newest open session quiz ("Nieuwe quiz · SCM H3 · dia
 * 121–135", above the hero card), otherwise the quiz of a finished chapter
 * whose chapter quiz he has not done yet.
 */
export function homeQuizSuggestion(data: QuizData): HomeQuizSuggestion {
  const open = sessionQuizList(data).find((e) => !e.done);
  if (open) return { kind: 'sessie', entry: open, label: `Nieuwe quiz · ${open.quiz.title}` };
  const chapter = chapterQuizList(data).find((e) => e.highlighted);
  if (chapter) {
    const n = chapter.questions;
    return {
      kind: 'hoofdstuk',
      entry: chapter,
      label: `Mini-quiz · ${chapter.chapter.course_id} ${chapter.chapter.code} · ${n} ${n === 1 ? 'vraag' : 'vragen'}`,
    };
  }
  return null;
}
