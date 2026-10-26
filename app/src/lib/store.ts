/**
 * The local database, and the queue of rows waiting to be sent.
 *
 * Copied from the Andrea app and reshaped for StudyFlow. The shape is the
 * same on purpose: the *logic* (accepting server rows, queueing, retrying,
 * parking a refused row) lives here as plain TypeScript, testable with
 * `node --test` and no browser. The storage itself sits behind a small
 * `Driver`, so the browser (IndexedDB, indexeddb.ts) and the tests (a Map)
 * are interchangeable.
 *
 * How it behaves:
 *
 *  1. Every read comes from the phone. A screen never waits for the network.
 *  2. Content (cards, quiz items, sessions, the day plan …) is written by the
 *     server only. The phone keeps a copy of every table and replaces a row
 *     when a newer one arrives.
 *  3. What the phone writes (reviews, quiz attempts, flags, stars, instrument
 *     scores) goes to the local copy first, then onto the outbox. Each row
 *     carries a uuid made on the phone, so sending it twice is harmless.
 *  4. The outbox is sent in batches. A dead connection stops the flush (it
 *     would fail the same way for everything behind it). A row the server
 *     refuses is retried alone, and after three refusals it is parked, so one
 *     bad row can never block the rest of the queue (Lessons learned: "Two
 *     devices that sync", trap 2).
 *  5. The pull cursors live in this same database (`__meta`), not in
 *     localStorage. When iOS wipes the site's data, cursors and rows go
 *     together, and the next pull simply starts from the beginning.
 */

import { TABLES, TABLE_NAMES, keyOf, type TableName, type Tables } from './model.ts';

/* ------------------------------------------------------------------ *
 * The storage driver
 * ------------------------------------------------------------------ */

/** The object stores next to the tables: the outbox and small bookkeeping values. */
export const OUTBOX = '__outbox';
export const META = '__meta';

/** Every object store that holds JSON values (the image blobs have their own, indexeddb.ts). */
export const STORE_NAMES: readonly string[] = [...TABLE_NAMES, OUTBOX, META];

/**
 * The little bit that actually touches a database. Keys are passed in from
 * outside, because the tables do not all key on `id` (slides on `key`,
 * day_plan on `day`, card_marks on `card_id`).
 */
export interface Driver {
  get(table: string, key: string): Promise<unknown | undefined>;
  getAll(table: string): Promise<unknown[]>;
  put(table: string, key: string, value: unknown): Promise<void>;
  /** Many rows in one transaction: a pull brings hundreds of cards at once. */
  putMany(table: string, entries: readonly (readonly [string, unknown])[]): Promise<void>;
  delete(table: string, key: string): Promise<void>;
  clear(table: string): Promise<void>;
}

/** An in-memory driver. Used by the tests, by demo mode, and as a fallback. */
export class MemoryDriver implements Driver {
  private tables = new Map<string, Map<string, unknown>>();

  private table(name: string): Map<string, unknown> {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }

  async get(table: string, key: string) {
    return clone(this.table(table).get(key));
  }
  async getAll(table: string) {
    return [...this.table(table).values()].map(clone);
  }
  async put(table: string, key: string, value: unknown) {
    this.table(table).set(key, clone(value));
  }
  async putMany(table: string, entries: readonly (readonly [string, unknown])[]) {
    for (const [key, value] of entries) this.table(table).set(key, clone(value));
  }
  async delete(table: string, key: string) {
    this.table(table).delete(key);
  }
  async clear(table: string) {
    this.table(table).clear();
  }
}

/**
 * Copies on the way in and out, like IndexedDB's structured clone does, so a
 * test cannot pass by accident because two places share one object.
 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * IndexedDB, or memory when IndexedDB will not open.
 *
 * iOS can refuse IndexedDB in private browsing, and a database killed during
 * an upgrade can stop answering at all. Rather than an app that shows an
 * error, the phone then runs on memory for this launch: everything still
 * works, and what it writes is sent to the server before the app closes.
 */
export class FallbackDriver implements Driver {
  private inner: Promise<Driver>;
  /** True once the primary failed and memory took over. */
  degraded = false;

  constructor(primary: Promise<Driver>, fallback: () => Driver = () => new MemoryDriver()) {
    this.inner = primary.catch(() => {
      this.degraded = true;
      return fallback();
    });
  }

  ready(): Promise<Driver> {
    return this.inner;
  }
  async get(table: string, key: string) {
    return (await this.inner).get(table, key);
  }
  async getAll(table: string) {
    return (await this.inner).getAll(table);
  }
  async put(table: string, key: string, value: unknown) {
    return (await this.inner).put(table, key, value);
  }
  async putMany(table: string, entries: readonly (readonly [string, unknown])[]) {
    return (await this.inner).putMany(table, entries);
  }
  async delete(table: string, key: string) {
    return (await this.inner).delete(table, key);
  }
  async clear(table: string) {
    return (await this.inner).clear(table);
  }
}

/* ------------------------------------------------------------------ *
 * The outbox
 * ------------------------------------------------------------------ */

/** One row waiting to be sent. */
export interface OutboxEntry {
  /** `${table}:${key}`: at most one entry per row, by construction. */
  id: string;
  table: TableName;
  key: string;
  /** When it was queued (ms). */
  queuedAt: number;
  /** How often the server refused it. */
  attempts: number;
  /** The last refusal, for the "niet verstuurd" detail in Profiel. */
  lastError?: string;
  /** Refused MAX_REFUSALS times: no longer retried on its own. */
  parked?: boolean;
}

/** After this many refusals a row is parked. */
export const MAX_REFUSALS = 3;

/** Rows per POST. */
export const BATCH_SIZE = 200;

/**
 * Why a send failed, read from the error message. The REST layer (sync.ts)
 * puts the HTTP status in front: "409: duplicate key …". No status at all
 * means the request never got an answer.
 *
 *   network  no answer, a timeout, or a 5xx: try again later, keep the order
 *   access   401/403: the personal key is missing, wrong or revoked; every
 *            row would be refused the same way, so nothing is counted
 *   refused  any other 4xx: the server looked at this row and said no
 */
export type FailureKind = 'network' | 'access' | 'refused';

export function classifyFailure(message: string): FailureKind {
  if (/^(401|403):/.test(message)) return 'access';
  if (/^4\d\d:/.test(message)) return 'refused';
  return 'network';
}

/** Sends rows of one table to the server; throws "NNN: reason" on a refusal. */
export type SendBatch = (table: TableName, rows: unknown[]) => Promise<void>;

export interface FlushResult {
  sent: number;
  /** Refused this time, still queued. */
  refused: number;
  /** Parked this time (third refusal). */
  parked: number;
  /** Why the flush stopped early, or null when it went through the queue. */
  stopped: 'network' | 'access' | null;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

export type ChangeListener = (table: TableName) => void;

/** A pull cursor: an ISO timestamp (updated_at, created_at) or a seq number. */
export type Cursor = string | number | null;

export class Store {
  private listeners = new Set<ChangeListener>();
  private driver: Driver;

  // Written out in full on purpose: Node runs TypeScript by stripping the
  // types away, so the shorthand `constructor(private driver: Driver)` is not
  // available to us.
  constructor(driver: Driver) {
    this.driver = driver;
  }

  /* ---- reading: always local, always instant ---- */

  async all<K extends TableName>(table: K): Promise<Tables[K][]> {
    return (await this.driver.getAll(table)) as Tables[K][];
  }

  async get<K extends TableName>(table: K, key: string): Promise<Tables[K] | undefined> {
    return (await this.driver.get(table, key)) as Tables[K] | undefined;
  }

  /* ---- writing from the phone: local first, then queued ---- */

  /**
   * Save a row made on the phone and queue it for the server. Returns as soon
   * as it is safe on the phone; it never waits for the network.
   */
  async write<K extends TableName>(table: K, row: Tables[K], now: number = Date.now()): Promise<void> {
    if (!TABLES[table].write) throw new Error(`${table} is written by the server only.`);
    const key = keyOf(table, row);
    await this.driver.put(table, key, row);
    const id = `${table}:${key}`;
    // Strictly later than a waiting entry for the same row, so flush() can
    // tell a re-save during a send from the entry it just sent.
    const waiting = (await this.driver.get(OUTBOX, id)) as OutboxEntry | undefined;
    const queuedAt = waiting ? Math.max(now, waiting.queuedAt + 1) : now;
    const entry: OutboxEntry = { id, table, key, queuedAt, attempts: 0 };
    // A newer save of the same row (a star toggled twice) replaces the waiting
    // entry: the row is sent as it finally stands.
    await this.driver.put(OUTBOX, entry.id, entry);
    this.notify(table);
  }

  /* ---- rows from the server ---- */

  /**
   * Take rows from the server. Returns how many actually changed, so callers
   * can skip a redraw. A row the phone changed and has not sent yet stays as
   * the phone has it (only card_marks can be in that state; log rows are the
   * same on both sides once written).
   */
  async accept<K extends TableName>(table: K, rows: readonly Tables[K][]): Promise<number> {
    if (rows.length === 0) return 0;
    const existing = new Map<string, string>();
    for (const row of (await this.driver.getAll(table)) as Tables[K][]) {
      existing.set(keyOf(table, row), JSON.stringify(row));
    }
    const waiting = TABLES[table].write === 'upsert' ? await this.waitingKeys(table) : new Set<string>();
    const changed: [string, unknown][] = [];
    for (const row of rows) {
      const key = keyOf(table, row);
      if (waiting.has(key)) continue;
      if (existing.get(key) === JSON.stringify(row)) continue;
      changed.push([key, row]);
    }
    if (changed.length > 0) {
      await this.driver.putMany(table, changed);
      this.notify(table);
    }
    return changed.length;
  }

  /**
   * Drop rows the server no longer has (sync.ts prune). A row still waiting in
   * the outbox is kept: it was made here and has not reached the server yet.
   */
  async remove(table: TableName, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const waiting = await this.waitingKeys(table);
    let removed = 0;
    for (const key of keys) {
      if (waiting.has(key)) continue;
      await this.driver.delete(table, key);
      removed++;
    }
    if (removed > 0) this.notify(table);
    return removed;
  }

  private async waitingKeys(table: TableName): Promise<Set<string>> {
    const all = (await this.driver.getAll(OUTBOX)) as OutboxEntry[];
    return new Set(all.filter((e) => e.table === table).map((e) => e.key));
  }

  /* ---- bookkeeping values (cursors, last sync) ---- */

  async meta<T>(name: string): Promise<T | undefined> {
    return (await this.driver.get(META, name)) as T | undefined;
  }

  async setMeta(name: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) await this.driver.delete(META, name);
    else await this.driver.put(META, name, value);
  }

  async cursor(table: TableName): Promise<Cursor> {
    return (await this.meta<Cursor>(`cursor:${table}`)) ?? null;
  }

  async setCursor(table: TableName, value: Cursor): Promise<void> {
    await this.setMeta(`cursor:${table}`, value);
  }

  /* ---- the outbox ---- */

  private async outbox(): Promise<OutboxEntry[]> {
    return ((await this.driver.getAll(OUTBOX)) as OutboxEntry[]).sort(
      (a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id),
    );
  }

  /** Everything still to send, oldest first. */
  async pending(): Promise<OutboxEntry[]> {
    return (await this.outbox()).filter((e) => !e.parked);
  }

  /** Rows the server kept refusing. Shown in Profiel, not retried on their own. */
  async parked(): Promise<OutboxEntry[]> {
    return (await this.outbox()).filter((e) => e.parked);
  }

  async pendingCount(): Promise<number> {
    return (await this.pending()).length;
  }

  /** Put the parked rows back in the queue (after Claude fixed the cause). */
  async retryParked(): Promise<number> {
    const stuck = await this.parked();
    for (const e of stuck) {
      await this.driver.put(OUTBOX, e.id, { ...e, parked: false, attempts: 0, lastError: undefined });
    }
    return stuck.length;
  }

  /**
   * Send everything that is waiting: per table, in batches, oldest first.
   *
   * `send` talks to the server; it is passed in so this file stays testable
   * and does not care how the rows travel.
   */
  async flush(send: SendBatch): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, refused: 0, parked: 0, stopped: null };

    // Group per table, tables in the order their oldest row was queued.
    const groups = new Map<TableName, OutboxEntry[]>();
    for (const entry of await this.pending()) {
      let list = groups.get(entry.table);
      if (!list) groups.set(entry.table, (list = []));
      list.push(entry);
    }

    for (const [table, entries] of groups) {
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch: { entry: OutboxEntry; row: unknown }[] = [];
        for (const entry of entries.slice(i, i + BATCH_SIZE)) {
          const row = await this.driver.get(table, entry.key);
          // The row vanished from under us: nothing to send.
          if (row === undefined) await this.driver.delete(OUTBOX, entry.id);
          else batch.push({ entry, row });
        }
        if (batch.length === 0) continue;

        try {
          await send(table, batch.map((b) => b.row));
          for (const b of batch) await this.sent(b.entry);
          result.sent += batch.length;
          continue;
        } catch (error) {
          const message = errorText(error);
          const kind = classifyFailure(message);
          if (kind !== 'refused') return { ...result, stopped: kind, error: message };
          if (batch.length === 1) {
            await this.refuse(batch[0].entry, message, result);
            continue;
          }
        }

        // The batch was refused: send the rows one by one, so the good ones
        // still go and the bad one is found.
        for (const b of batch) {
          try {
            await send(table, [b.row]);
            await this.sent(b.entry);
            result.sent++;
          } catch (error) {
            const message = errorText(error);
            const kind = classifyFailure(message);
            if (kind !== 'refused') return { ...result, stopped: kind, error: message };
            await this.refuse(b.entry, message, result);
          }
        }
      }
    }
    return result;
  }

  /**
   * A row reached the server: take it off the outbox, unless it was saved
   * again while it travelled (a star toggled during the send). That newer
   * entry stays queued, so the row is sent once more as it finally stands.
   */
  private async sent(entry: OutboxEntry): Promise<void> {
    const now = (await this.driver.get(OUTBOX, entry.id)) as OutboxEntry | undefined;
    if (now && now.queuedAt !== entry.queuedAt) return;
    await this.driver.delete(OUTBOX, entry.id);
  }

  private async refuse(entry: OutboxEntry, message: string, result: FlushResult): Promise<void> {
    const attempts = entry.attempts + 1;
    const parked = attempts >= MAX_REFUSALS;
    await this.driver.put(OUTBOX, entry.id, { ...entry, attempts, lastError: message, parked });
    if (parked) result.parked++;
    else result.refused++;
  }

  /* ---- letting the screens know ---- */

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(table: TableName): void {
    for (const listener of this.listeners) listener(table);
  }

  /** Wipe everything, outbox and cursors included. Used by the tests and the demo. */
  async clear(): Promise<void> {
    for (const name of STORE_NAMES) await this.driver.clear(name);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
