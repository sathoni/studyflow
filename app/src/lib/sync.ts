/**
 * Talking to the server.
 *
 * Stripped down from the Andrea & Mathieu app's sync.ts: plain fetch against
 * Supabase's REST interface, no Supabase library (thirty kilobytes and a
 * websocket stack for nothing), and no login at all. Every request carries the
 * publishable key as `apikey` (role anon) and the personal key as `x-sf-key`
 * (access.ts); the database checks the second one in every policy.
 *
 * The shape of the conversation:
 *
 *   flush   send everything waiting in the outbox (store.ts does the queueing,
 *           retrying and parking; this file only carries the rows)
 *   pull    ask every table for what changed since the last look:
 *             content tables  updated_at > cursor − 1 h  (the hour of overlap
 *                             covers a long transaction committing late)
 *             log tables      seq > cursor
 *             card_flags      created_at > cursor − 1 h
 *           Supabase hands out at most 1000 rows per request, so every pull
 *           pages until a short page comes back. Paging is by key ("key >
 *           the last key seen"), never by offset: a row the server changes or
 *           deletes halfway through a pull would otherwise shift the pages and
 *           make the phone skip a row it then never asks for again.
 *   prune   once in a while, ask content tables for their keys only and drop
 *           local rows the server no longer has (a test chapter removed, a
 *           quiz deleted with its session). Never when the key is not
 *           accepted: a wrong key reads as "empty", and emptying the phone
 *           because of that would be the worst possible answer.
 *
 * When: on open, when the connection comes back, when the app returns to the
 * foreground, every 10 ratings (flush only), and every few minutes while open.
 *
 * Everything here takes its surroundings (fetch, the store, the clock, window
 * and document) as arguments, so `node --test` can drive it with a fake server.
 */

import { TABLES, TABLE_NAMES, keyOf, type TableName, type Tables } from './model.ts';
import type { Cursor, FlushResult, SendBatch, Store } from './store.ts';
import { MEDIA_URL, SUPABASE_KEY, SUPABASE_URL } from './server-config.ts';

/* ------------------------------------------------------------------ *
 * The REST door
 * ------------------------------------------------------------------ */

/** A request that gets no answer within this time counts as "offline". */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Supabase's max_rows: never more than this per request. */
export const PAGE_SIZE = 1000;

/** How far back a content pull looks before its cursor. */
export const OVERLAP_MS = 60 * 60 * 1000;

/** At most one prune per this interval. */
export const PRUNE_EVERY_MS = 12 * 60 * 60 * 1000;

/** Flush after this many ratings in a row, without waiting for anything else. */
export const FLUSH_EVERY_RATINGS = 10;

/** Otherwise flush this long after the last rating (ms). */
export const FLUSH_AFTER_QUIET_MS = 3000;

/** While the app is open and visible, sync this often. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

export interface RestConfig {
  /** The personal key (x-sf-key). */
  key: string;
  url?: string;
  apiKey?: string;
  mediaUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One signed image address from the media function. */
export interface SignedUrl {
  path: string;
  signed_url: string | null;
  error?: string | null;
}

/**
 * The few calls the app makes, all with the right headers. Errors are thrown
 * as "NNN: readable reason" (store.ts reads the status off the front); no
 * answer at all is thrown without a status, which counts as "offline".
 */
export class Rest {
  private config: Required<RestConfig>;

  constructor(config: RestConfig) {
    this.config = {
      url: SUPABASE_URL,
      apiKey: SUPABASE_KEY,
      mediaUrl: MEDIA_URL,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...config,
    };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.config.apiKey, 'x-sf-key': this.config.key, ...extra };
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.config.fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('De server antwoordde niet op tijd.');
      }
      throw new Error('Geen verbinding met de server.');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`${response.status}: ${await readableError(response)}`);
    return response;
  }

  /** GET /rest/v1/<table>?<query>, as rows. */
  async select<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
    const response = await this.call(`${this.config.url}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: this.headers({ Accept: 'application/json' }),
    });
    return (await response.json()) as T[];
  }

  /**
   * POST rows. Log tables ignore a row they already have (the phone made the
   * uuid, so a resend is harmless); card_marks updates the existing row.
   */
  async insert(table: TableName, rows: readonly unknown[]): Promise<void> {
    const spec = TABLES[table];
    const upsert = spec.write === 'upsert';
    const query = upsert ? `?on_conflict=${spec.key}` : '';
    await this.call(`${this.config.url}/rest/v1/${table}${query}`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: `resolution=${upsert ? 'merge' : 'ignore'}-duplicates,return=minimal`,
      }),
      body: JSON.stringify(rows),
    });
  }

  /** Signed GET addresses for slide images (Edge Function `media`, ≤60 paths). */
  async signImages(paths: readonly string[]): Promise<SignedUrl[]> {
    const response = await this.call(this.config.mediaUrl, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'sign_download', paths }),
    });
    const body = (await response.json()) as { urls?: SignedUrl[] };
    return body.urls ?? [];
  }
}

/** The server's own sentence ("message"), not the JSON around it. */
async function readableError(response: Response): Promise<string> {
  const detail = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(detail) as { message?: string; error?: string; hint?: string };
    return (parsed.message ?? parsed.error ?? detail).slice(0, 200);
  } catch {
    return detail.slice(0, 200) || response.statusText;
  }
}

/* ------------------------------------------------------------------ *
 * Sending (the outbox)
 * ------------------------------------------------------------------ */

/**
 * A row as the server accepts it: only the columns the database grants for
 * inserts (model.ts TABLES[...].columns). Local extras such as created_at or
 * seq would make the whole batch fail.
 */
export function toWire(table: TableName, row: unknown): Record<string, unknown> {
  const columns = TABLES[table].columns;
  const source = row as Record<string, unknown>;
  if (!columns) return { ...source };
  const out: Record<string, unknown> = {};
  for (const column of columns) if (column in source) out[column] = source[column];
  return out;
}

/** The function store.flush() calls to carry one batch. */
export function sender(rest: Rest): SendBatch {
  return (table, rows) => rest.insert(table, rows.map((row) => toWire(table, row)));
}

/* ------------------------------------------------------------------ *
 * Pulling
 * ------------------------------------------------------------------ */

/**
 * The query for one page of changes of one table.
 *
 * Log tables page on their seq (the cursor itself moves page by page).
 * Content tables ask for `updated_at > cursor − 1 h` and page on their
 * primary key: `afterKey` is the last key of the previous page.
 */
export function pullQuery(table: TableName, cursor: Cursor, afterKey: string | null = null, limit = PAGE_SIZE): string {
  const spec = TABLES[table];
  const parts = [`select=${spec.select ?? '*'}`];
  if (spec.cursor === 'seq') {
    if (typeof cursor === 'number') parts.push(`seq=gt.${cursor}`);
    parts.push('order=seq.asc');
  } else {
    if (typeof cursor === 'string') {
      const since = new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();
      parts.push(`${spec.cursor}=gt.${encodeURIComponent(since)}`);
    }
    if (afterKey !== null) parts.push(`${spec.key}=gt.${encodeURIComponent(afterKey)}`);
    parts.push(`order=${spec.key}.asc`);
  }
  parts.push(`limit=${limit}`);
  return parts.join('&');
}

/** The newest cursor value in a set of rows (or the old cursor when none is newer). */
export function advanceCursor(table: TableName, rows: readonly unknown[], cursor: Cursor): Cursor {
  const field = TABLES[table].cursor;
  let best = cursor;
  for (const row of rows) {
    const value = (row as Record<string, unknown>)[field];
    if (field === 'seq') {
      const n = Number(value);
      if (Number.isFinite(n) && (typeof best !== 'number' || n > best)) best = n;
    } else if (typeof value === 'string') {
      if (typeof best !== 'string' || Date.parse(value) > Date.parse(best)) best = value;
    }
  }
  return best;
}

/** Pull one table to the end. Returns how many local rows changed. */
export async function pullTable(store: Store, rest: Rest, table: TableName, pageSize = PAGE_SIZE): Promise<number> {
  let cursor = await store.cursor(table);
  const isSeq = TABLES[table].cursor === 'seq';
  const start = cursor;
  let afterKey: string | null = null;
  let changed = 0;
  for (;;) {
    const query: string = pullQuery(table, isSeq ? cursor : start, afterKey, pageSize);
    const rows: Tables[typeof table][] = await rest.select<Tables[typeof table]>(table, query);
    changed += await store.accept(table, rows);
    cursor = advanceCursor(table, rows, cursor);
    // Saved page by page: an interrupted first pull resumes where it stopped.
    if (isSeq) await store.setCursor(table, cursor);
    if (rows.length < pageSize) break;
    afterKey = keyOf(table, rows[rows.length - 1]);
  }
  if (!isSeq) await store.setCursor(table, cursor);
  return changed;
}

/** The tables pulled, content first (the screens are made of them), logs after. */
export const PULL_ORDER: readonly TableName[] = [
  ...TABLE_NAMES.filter((t) => TABLES[t].cursor === 'updated_at'),
  ...TABLE_NAMES.filter((t) => TABLES[t].cursor !== 'updated_at'),
];

/** Pull every table, a few at a time. Returns the number of changed rows per table. */
export async function pullAll(store: Store, rest: Rest, parallel = 4): Promise<Partial<Record<TableName, number>>> {
  const result: Partial<Record<TableName, number>> = {};
  const queue = [...PULL_ORDER];
  const worker = async () => {
    for (let table = queue.shift(); table; table = queue.shift()) {
      result[table] = await pullTable(store, rest, table);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return result;
}

/**
 * Does the server accept the key? With row-level security a wrong or revoked
 * key gets "nothing" rather than an error, so the test is: the courses table
 * (six rows, always there) must not come back empty.
 */
export async function keyAccepted(rest: Rest): Promise<boolean> {
  const rows = await rest.select('courses', 'select=id&limit=1');
  return rows.length > 0;
}

/** Content tables that can lose rows on the server (logs never do). */
export const PRUNABLE: readonly TableName[] = TABLE_NAMES.filter(
  (t) => TABLES[t].cursor === 'updated_at' && !TABLES[t].write,
);

/**
 * Drop local rows the server no longer has. Only call it after keyAccepted()
 * said yes. Returns how many rows were removed per table.
 */
export async function prune(store: Store, rest: Rest, pageSize = PAGE_SIZE): Promise<Partial<Record<TableName, number>>> {
  const removed: Partial<Record<TableName, number>> = {};
  for (const table of PRUNABLE) {
    const key = TABLES[table].key;
    const onServer = new Set<string>();
    // Paged by key, not offset: a row deleted on the server mid-prune would
    // otherwise shift the pages, and a row that still exists would be dropped.
    let afterKey: string | null = null;
    for (;;) {
      const after: string = afterKey === null ? '' : `&${key}=gt.${encodeURIComponent(afterKey)}`;
      const rows = await rest.select<Record<string, unknown>>(table, `select=${key}${after}&order=${key}.asc&limit=${pageSize}`);
      for (const row of rows) onServer.add(String(row[key]));
      if (rows.length < pageSize) break;
      afterKey = String(rows[rows.length - 1][key]);
    }
    const gone = (await store.all(table)).map((row) => keyOf(table, row)).filter((k) => !onServer.has(k));
    if (gone.length > 0) removed[table] = await store.remove(table, gone);
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * The rhythm
 * ------------------------------------------------------------------ */

export type SyncState =
  /** Nothing going on; the last sync went through. */
  | 'idle'
  /** Sending or fetching right now. */
  | 'working'
  /** No connection: everything is kept on the phone and sent later. */
  | 'offline'
  /** The server does not accept the personal key (revoked or mistyped). */
  | 'no-access'
  /** Something else went wrong; the next trigger tries again. */
  | 'error';

export interface SyncReport {
  state: SyncState;
  flushed: FlushResult | null;
  pulled: Partial<Record<TableName, number>>;
  pruned: Partial<Record<TableName, number>>;
  error?: string;
}

export interface SyncerOptions {
  store: Store;
  rest: Rest;
  now?: () => number;
  /** navigator.onLine, or a stand-in. */
  online?: () => boolean;
}

/** Meta keys in the store. */
const LAST_SYNC = 'lastSyncAt';
const LAST_PRUNE = 'lastPruneAt';

export class Syncer {
  private store: Store;
  private rest: Rest;
  private now: () => number;
  private online: () => boolean;
  private listeners = new Set<(state: SyncState, detail?: string) => void>();
  private running: Promise<SyncReport> | null = null;
  private again = false;
  private ratings = 0;
  private flushing: Promise<FlushResult> | null = null;

  state: SyncState = 'idle';
  detail: string | undefined;

  constructor(options: SyncerOptions) {
    this.store = options.store;
    this.rest = options.rest;
    this.now = options.now ?? Date.now;
    this.online = options.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  }

  /** Hear about every state change; called at once with the current state. */
  onState(listener: (state: SyncState, detail?: string) => void): () => void {
    this.listeners.add(listener);
    listener(this.state, this.detail);
    return () => this.listeners.delete(listener);
  }

  private announce(state: SyncState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    for (const listener of this.listeners) listener(state, detail);
  }

  /** When the last full sync went through (ms), for "laatste update …". */
  async lastSyncAt(): Promise<number | null> {
    return (await this.store.meta<number>(LAST_SYNC)) ?? null;
  }

  /**
   * Flush, then pull (and prune when it is due). Never runs twice at once: a
   * call during a sync makes one more round follow it.
   */
  syncNow(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let report: SyncReport;
        do {
          this.again = false;
          report = await this.round();
        } while (this.again && report.state === 'idle');
        return report;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async round(): Promise<SyncReport> {
    const report: SyncReport = { state: 'idle', flushed: null, pulled: {}, pruned: {} };
    if (!this.online()) {
      this.announce('offline');
      return { ...report, state: 'offline' };
    }
    this.announce('working');
    try {
      report.flushed = await this.flushNow();
      if (report.flushed.stopped === 'network') throw new Error(report.flushed.error ?? 'offline');
      if (report.flushed.stopped === 'access' || !(await keyAccepted(this.rest))) {
        this.announce('no-access');
        return { ...report, state: 'no-access' };
      }
      report.pulled = await pullAll(this.store, this.rest);
      const lastPrune = (await this.store.meta<number>(LAST_PRUNE)) ?? 0;
      if (this.now() - lastPrune >= PRUNE_EVERY_MS) {
        report.pruned = await prune(this.store, this.rest);
        await this.store.setMeta(LAST_PRUNE, this.now());
      }
      await this.store.setMeta(LAST_SYNC, this.now());
      this.announce('idle');
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state: SyncState = /^(401|403):/.test(message)
        ? 'no-access'
        : /^4\d\d:/.test(message)
          ? 'error'
          : 'offline';
      this.announce(state, message);
      return { ...report, state, error: message };
    }
  }

  /** Send the outbox now (no pull). Overlapping calls share one flush. */
  flushNow(): Promise<FlushResult> {
    if (!this.flushing) {
      this.flushing = this.store.flush(sender(this.rest)).finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  /**
   * Call after every rating: every 10th one sends the outbox straight away, and
   * otherwise it goes out a few seconds after the last rating. So a session closed
   * halfway, or one card rated on the train, still reaches the server soon.
   */
  noteRating(): void {
    this.ratings++;
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    if (!this.online()) return;
    if (this.ratings % FLUSH_EVERY_RATINGS === 0) {
      void this.flushNow().catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      this.quietTimer = null;
      if (this.online()) void this.flushNow().catch(() => undefined);
    }, FLUSH_AFTER_QUIET_MS);
    // In the tests (Node) a pending timer must not keep the process alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.quietTimer = timer;
  }
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the rhythm: sync now, when the connection returns, when the app
   * comes back to the foreground (and flush when it leaves it: iOS may close
   * a backgrounded app without warning), and every few minutes while visible.
   * Returns a function that stops it all.
   */
  start(win: Window = window, doc: Document = document): () => void {
    const onOnline = () => void this.syncNow();
    const onOffline = () => this.announce('offline');
    const onVisibility = () => {
      if (doc.visibilityState === 'visible') void this.syncNow();
      else void this.flushNow().catch(() => undefined);
    };
    win.addEventListener('online', onOnline);
    win.addEventListener('offline', onOffline);
    doc.addEventListener('visibilitychange', onVisibility);
    const timer = win.setInterval(() => {
      if (doc.visibilityState === 'visible') void this.syncNow();
    }, SYNC_INTERVAL_MS);
    void this.syncNow();
    return () => {
      win.removeEventListener('online', onOnline);
      win.removeEventListener('offline', onOffline);
      doc.removeEventListener('visibilitychange', onVisibility);
      win.clearInterval(timer);
    };
  }
}
