/**
 * The shapes of the data, exactly as the database holds them (docs/SCHEMA.md).
 *
 * Field names stay snake_case on purpose. The Andrea app converted every name
 * to camelCase on the way in and back on the way out; here the same rows are
 * also written by the course projects and the evening routine through SQL, and
 * most of the interesting data is jsonb whose inner keys are snake_case anyway
 * (`source_label`, `session_key`). One spelling everywhere means a row can be
 * compared with what the connector shows without translating it in your head.
 */

/** A study day or calendar date, 'YYYY-MM-DD'. Never a Date object. */
export type Day = string;
/** A uuid. Rows written on the phone get theirs from crypto.randomUUID(). */
export type Uuid = string;
/** A timestamp as the server writes it (ISO 8601 with offset). */
export type Timestamp = string;

/* ------------------------------------------------------------------ *
 * Content tables (written by the server, read by the app)
 * ------------------------------------------------------------------ */

export interface Course {
  id: string; // 'SCM', 'BR', 'OR', 'FB', 'IFHT', 'BE'
  name: string;
  color: string;
  icon: string;
  sort: number;
  updated_at: Timestamp;
}

export type ChapterStatus = 'niet_gezien' | 'bezig' | 'af' | 'examenklaar';

export interface Chapter {
  id: string; // 'SCM-H3'
  course_id: string;
  code: string; // 'H3'
  title: string;
  sort: number;
  notion_page_id: string | null;
  slide_numbering: 'printed' | 'position' | 'book' | 'none';
  status: ChapterStatus;
  updated_at: Timestamp;
}

export interface StudySession {
  id: Uuid;
  session_key: string; // 'SCM-H3:2026-10-24:121-135'
  course_id: string;
  chapter_id: string;
  kind: 'zelfstudie' | 'les' | 'import';
  title: string; // 'SCM H3 · dia 121–135'
  card_ids: Uuid[];
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Quiz {
  id: Uuid;
  kind: 'sessie';
  session_id: Uuid | null;
  course_id: string; // never 'BE'
  chapter_id: string;
  title: string;
  item_ids: Uuid[]; // fixed for a session quiz, 1..10
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Exam {
  id: Uuid;
  course_id: string | null; // null = every course
  kind: 'toets' | 'proefexamen' | 'examen' | 'opdracht';
  day: Day;
  end_day: Day | null;
  chapter_ids: string[]; // empty = the whole course
  title: string;
  updated_at: Timestamp;
}

export interface Slide {
  key: string; // 'SCM-H3/p006'
  chapter_id: string;
  page_idx: number;
  printed_no: string | null;
  title?: string | null;
  text?: string | null; // not pulled to the phone (see TABLES.slides.select)
  image_path: string; // 'SCM-H3/p006.webp' in the private bucket "slides"
  w: number;
  h: number;
  updated_at: Timestamp;
}

/** [x0, y0, x1, y1], each a fraction 0..1 of the full page image. */
export type Crop = [number, number, number, number];

export interface Visual {
  slide: string;
  crop?: Crop | null;
  caption?: string | null;
}

export interface CardFront {
  text: string;
  visual?: Visual | null;
}

export interface CardAnswer {
  core: string;
  more?: string | null;
  visual?: Visual | null;
}

export interface CardSource {
  label: string;
  slide?: string | null;
  page?: string | null;
}

export type CardType =
  | 'begrip'
  | 'schema'
  | 'formule'
  | 'rekenen'
  | 'casus'
  | 'grammatica'
  | 'vertaling'
  | 'waarom';

export interface Card {
  id: Uuid;
  course_id: string;
  chapter_id: string;
  type: CardType;
  front: CardFront;
  answer: CardAnswer;
  hints: string[]; // always exactly 3
  source: CardSource;
  exam_value: number; // 1..3
  sibling_group: string | null;
  sort: number;
  legacy_notion_id: string | null;
  notion_inbox_id: string | null;
  status: 'live' | 'needs_check' | 'retired';
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type QuizFormat = 'mcq' | 'tf' | 'cloze' | 'numeric';

export interface QuizOption {
  text: string;
  correct: boolean;
  why?: string | null;
}

export interface ClozeAnswer {
  accept: string[];
}

export interface NumericAnswer {
  value: number;
  unit?: string | null;
  tolerance?: number | null;
  steps?: string[] | null;
}

export interface TfAnswer {
  correction?: string | null;
}

export interface QuizItem {
  id: Uuid;
  card_id: Uuid;
  course_id: string;
  chapter_id: string;
  format: QuizFormat;
  stem: string;
  options: QuizOption[] | null;
  answer: ClozeAnswer | NumericAnswer | TfAnswer | null;
  hint: string | null;
  explanation: string | null;
  source_label: string | null;
  status: 'live' | 'retired';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DayPlan {
  day: Day;
  course_order: string[];
  reason: string | null;
  cap: number | null; // null = settings.defaults
  new_max: number | null; // null = settings.defaults
  reminder_at: string | null;
  source: 'notion' | 'auto';
  updated_at: Timestamp;
}

export interface Instrument {
  id: Uuid;
  course_id: string;
  chapter_id: string | null;
  title: string;
  notion_url: string | null;
  minutes: number;
  status: string;
  updated_at: Timestamp;
}

export interface Setting {
  key: string;
  value: unknown;
  updated_at: Timestamp;
}

export interface PipelineStatus {
  id: number;
  last_intake_at: Timestamp | null;
  last_intake_ok: boolean | null;
  message: string | null;
  updated_at: Timestamp;
}

/* ------------------------------------------------------------------ *
 * Log tables (written by the phone, append-only)
 * ------------------------------------------------------------------ */

export type ReviewResult = 'gekend' | 'hint' | 'niet' | 'opnieuw' | 'quiz_fout' | 'undo';
export type ReviewMode = 'sessie' | 'herhaling' | 'handmatig' | 'quiz';

export interface Review {
  id: Uuid;
  card_id: Uuid;
  reviewed_at: Timestamp;
  day: Day; // the study day (Brussels, 04:00 rollover)
  result: ReviewResult;
  hints_used: number;
  mode: ReviewMode;
  undoes: Uuid | null;
  ms: number | null;
  seq?: number | null; // assigned by the server
  created_at?: Timestamp;
}

export interface QuizAttempt {
  id: Uuid;
  run_id: Uuid;
  item_id: Uuid;
  card_id: Uuid;
  scope: string | null; // 'sessie:<quiz_id>' | 'hoofdstuk:<chapter_id>' | 'vak:<course_id>'
  correct: boolean;
  answer: unknown;
  hint_used: boolean;
  answered_at: Timestamp;
  day: Day;
  seq?: number | null;
}

export type FlagReason = 'fout' | 'onduidelijk' | 'te_lang' | 'beeld' | 'dubbel';

export interface CardFlag {
  id: Uuid;
  card_id: Uuid;
  reason: FlagReason;
  note: string | null;
  created_at: Timestamp;
  resolved_at?: Timestamp | null;
  resolution?: string | null;
}

export interface CardMark {
  card_id: Uuid;
  starred: boolean;
  updated_at: Timestamp;
}

export type InstrumentScore = 'alles' | 'bijna' | 'veel_fout';

export interface InstrumentReview {
  id: Uuid;
  instrument_id: Uuid;
  day: Day;
  score: InstrumentScore;
  created_at: Timestamp;
  seq?: number | null;
}

/* ------------------------------------------------------------------ *
 * The table registry
 * ------------------------------------------------------------------ */

export interface Tables {
  courses: Course;
  chapters: Chapter;
  study_sessions: StudySession;
  quizzes: Quiz;
  exams: Exam;
  slides: Slide;
  cards: Card;
  quiz_items: QuizItem;
  day_plan: DayPlan;
  instruments: Instrument;
  settings: Setting;
  pipeline_status: PipelineStatus;
  card_marks: CardMark;
  reviews: Review;
  quiz_attempts: QuizAttempt;
  card_flags: CardFlag;
  instrument_reviews: InstrumentReview;
}

export type TableName = keyof Tables;

/**
 * How each table is kept in step with the server.
 *
 *   key       the primary key column (IndexedDB stores rows under it)
 *   cursor    what "changed since last time" means for that table:
 *             content tables carry updated_at (touch trigger), the logs a
 *             server-assigned seq, card_flags only created_at
 *   write     tables the phone writes to: logs are append-only inserts,
 *             card_marks is an upsert by card_id
 *   columns   the columns the phone may insert (the database grants exactly
 *             these; sending seq or created_at would be refused)
 *   select    a narrower column list to pull, where the full row is heavy
 */
export interface TableSpec {
  key: string;
  cursor: 'updated_at' | 'seq' | 'created_at';
  write?: 'append' | 'upsert';
  columns?: readonly string[];
  select?: string;
}

export const TABLES: { readonly [K in TableName]: TableSpec } = {
  courses: { key: 'id', cursor: 'updated_at' },
  chapters: { key: 'id', cursor: 'updated_at' },
  study_sessions: { key: 'id', cursor: 'updated_at' },
  quizzes: { key: 'id', cursor: 'updated_at' },
  exams: { key: 'id', cursor: 'updated_at' },
  slides: {
    key: 'key',
    cursor: 'updated_at',
    // The slide text is for the routine; the phone only needs size and path.
    select: 'key,chapter_id,page_idx,printed_no,image_path,w,h,updated_at',
  },
  cards: { key: 'id', cursor: 'updated_at' },
  quiz_items: { key: 'id', cursor: 'updated_at' },
  day_plan: { key: 'day', cursor: 'updated_at' },
  instruments: { key: 'id', cursor: 'updated_at' },
  settings: { key: 'key', cursor: 'updated_at' },
  pipeline_status: { key: 'id', cursor: 'updated_at' },
  card_marks: {
    key: 'card_id',
    cursor: 'updated_at',
    write: 'upsert',
    columns: ['card_id', 'starred'],
  },
  reviews: {
    key: 'id',
    cursor: 'seq',
    write: 'append',
    columns: ['id', 'card_id', 'reviewed_at', 'day', 'result', 'hints_used', 'mode', 'undoes', 'ms'],
  },
  quiz_attempts: {
    key: 'id',
    cursor: 'seq',
    write: 'append',
    columns: [
      'id', 'run_id', 'item_id', 'card_id', 'scope', 'correct', 'answer', 'hint_used',
      'answered_at', 'day',
    ],
  },
  card_flags: {
    key: 'id',
    cursor: 'created_at',
    write: 'append',
    columns: ['id', 'card_id', 'reason', 'note'],
  },
  instrument_reviews: {
    key: 'id',
    cursor: 'seq',
    write: 'append',
    columns: ['id', 'instrument_id', 'day', 'score'],
  },
};

export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/** The primary key of a row, as a string (IndexedDB key). */
export function keyOf<K extends TableName>(table: K, row: Tables[K]): string {
  return String((row as unknown as Record<string, unknown>)[TABLES[table].key]);
}

/* ------------------------------------------------------------------ *
 * Settings and course rules
 * ------------------------------------------------------------------ */

/** settings.defaults, with the values the seed migration writes. */
export interface Defaults {
  cap: number;
  cap_sunday: number;
  new_max: number;
  new_max_sunday: number;
  wait_days: number[]; // boxes 1..6
  est_sec_review: number;
  est_sec_new: number;
  reminder_at: string;
}

export const DEFAULTS: Defaults = {
  cap: 20,
  cap_sunday: 30,
  new_max: 10,
  new_max_sunday: 5,
  wait_days: [1, 3, 7, 14, 28, 60],
  est_sec_review: 15,
  est_sec_new: 30,
  reminder_at: '21:00',
};

/**
 * settings.defaults as stored, over the built-in values.
 *
 * Anything missing or of the wrong type falls back, so a half-written settings
 * row from the routine can never make the queue empty or the waits nonsense.
 */
export function readDefaults(settings: readonly Setting[]): Defaults {
  const row = settings.find((s) => s.key === 'defaults');
  const raw = (row?.value ?? {}) as Partial<Record<keyof Defaults, unknown>>;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const waits =
    Array.isArray(raw.wait_days) &&
    raw.wait_days.length === 6 &&
    raw.wait_days.every((n) => typeof n === 'number' && n > 0)
      ? (raw.wait_days as number[])
      : DEFAULTS.wait_days;
  return {
    cap: num(raw.cap, DEFAULTS.cap),
    cap_sunday: num(raw.cap_sunday, DEFAULTS.cap_sunday),
    new_max: num(raw.new_max, DEFAULTS.new_max),
    new_max_sunday: num(raw.new_max_sunday, DEFAULTS.new_max_sunday),
    wait_days: waits,
    est_sec_review: num(raw.est_sec_review, DEFAULTS.est_sec_review) || DEFAULTS.est_sec_review,
    est_sec_new: num(raw.est_sec_new, DEFAULTS.est_sec_new) || DEFAULTS.est_sec_new,
    reminder_at: typeof raw.reminder_at === 'string' ? raw.reminder_at : DEFAULTS.reminder_at,
  };
}

export interface Goal {
  id: string;
  label: string;
  target: number;
  unit: 'share' | 'count';
}

export function readGoals(settings: readonly Setting[]): Goal[] {
  const value = settings.find((s) => s.key === 'goals')?.value;
  return Array.isArray(value) ? (value as Goal[]) : [];
}

export interface Profile {
  name: string;
  subtitle: string;
}

export function readProfile(settings: readonly Setting[]): Profile {
  const value = (settings.find((s) => s.key === 'profile')?.value ?? {}) as Partial<Profile>;
  return { name: value.name || 'Mathieu', subtitle: value.subtitle || 'Student' };
}

/**
 * Business English has no mini-quizzes of any kind (SPEC-v3, his additions).
 * Its cards are still reviewed. The database refuses BE quiz rows as well; this
 * is the app's half of the same rule.
 */
export const COURSES_WITHOUT_QUIZ: ReadonlySet<string> = new Set(['BE']);

export function hasQuizzes(courseId: string): boolean {
  return !COURSES_WITHOUT_QUIZ.has(courseId);
}
