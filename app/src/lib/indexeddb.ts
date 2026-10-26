/**
 * The real storage on the phone.
 *
 * A thin, boring adapter, copied from the Andrea app. All the interesting
 * decisions live in store.ts, where they can be tested without a browser;
 * this file only wraps IndexedDB's callback API in promises.
 *
 * IndexedDB rather than localStorage: a few thousand cards, their quiz items
 * and the slide images are far beyond what localStorage holds, and
 * localStorage is synchronous (it freezes the screen) and text-only.
 */

import type { Driver } from './store.ts';
import { STORE_NAMES } from './store.ts';

const DB_NAME = 'studyflow';

/**
 * Bump this when the set of stores changes.
 *
 * IndexedDB only creates stores during an upgrade, and an upgrade only happens
 * when this number goes up. A phone that already has the database keeps what
 * it got the first time, so adding a table without raising this leaves every
 * existing install unable to find it.
 *
 *   1  the first set: every table in model.ts, __outbox, __meta, __images
 */
const DB_VERSION = 1;

/**
 * Slide images, as blobs keyed by their storage path ('SCM-H3/p006.webp').
 * In the same database as everything else: one database means one upgrade
 * path and one thing that can go wrong (Andrea app, 2026-09).
 */
export const IMAGES = '__images';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbDriver implements Driver {
  private ready: Promise<IDBDatabase>;

  constructor() {
    this.ready = this.open();
  }

  /** Resolves with the driver once the database is open; rejects when it will not open. */
  opened(): Promise<IndexedDbDriver> {
    return this.ready.then(() => this);
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      // IndexedDB can go quiet rather than fail: an older connection elsewhere
      // blocks the upgrade, or one killed mid-upgrade wedges the database. In
      // neither case is there an error, and a promise that never settles takes
      // down whatever waits on it. So every path settles, once.
      let done = false;
      const settle = (finish: () => void) => {
        if (done) return;
        done = true;
        finish();
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        // Keys are passed in from outside (out-of-line): the tables do not all
        // key on `id`, and blobs carry no key of their own.
        for (const name of [...STORE_NAMES, IMAGES]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // If another tab opens a newer version, step aside rather than block it.
        db.onversionchange = () => db.close();
        settle(() => resolve(db));
      };

      request.onerror = () => settle(() => reject(request.error));
      request.onblocked = () =>
        settle(() => reject(new Error('De database is ergens anders nog open.')));
      setTimeout(
        () => settle(() => reject(new Error('De database antwoordt niet.'))),
        8000,
      );
    });
  }

  private async store(table: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.ready;
    return db.transaction(table, mode).objectStore(table);
  }

  /** A write that resolves when the transaction is committed, not merely queued. */
  private async write(table: string, work: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.ready;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(table, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Opslaan afgebroken.'));
      work(tx.objectStore(table));
    });
  }

  async get(table: string, key: string): Promise<unknown | undefined> {
    return promisify((await this.store(table, 'readonly')).get(key));
  }

  async getAll(table: string): Promise<unknown[]> {
    return promisify((await this.store(table, 'readonly')).getAll());
  }

  async put(table: string, key: string, value: unknown): Promise<void> {
    await this.write(table, (s) => s.put(value, key));
  }

  async putMany(table: string, entries: readonly (readonly [string, unknown])[]): Promise<void> {
    if (entries.length === 0) return;
    await this.write(table, (s) => {
      for (const [key, value] of entries) s.put(value, key);
    });
  }

  async delete(table: string, key: string): Promise<void> {
    await this.write(table, (s) => s.delete(key));
  }

  async clear(table: string): Promise<void> {
    await this.write(table, (s) => s.clear());
  }

  /* ---- image blobs, in the same database ---- */

  async putBlob(key: string, blob: Blob): Promise<void> {
    await this.write(IMAGES, (s) => s.put(blob, key));
  }

  async getBlob(key: string): Promise<Blob | undefined> {
    return promisify((await this.store(IMAGES, 'readonly')).get(key) as IDBRequest<Blob | undefined>);
  }

  async deleteBlob(key: string): Promise<void> {
    await this.write(IMAGES, (s) => s.delete(key));
  }

  async blobKeys(): Promise<string[]> {
    return promisify((await this.store(IMAGES, 'readonly')).getAllKeys() as IDBRequest<string[]>);
  }
}

/**
 * Is there somewhere to store things at all? iOS can refuse IndexedDB in
 * private browsing; then the app runs on memory for the session.
 */
export function storageAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/**
 * Ask the browser not to evict the data when the phone gets full. Best
 * effort: iOS may say no, and that is fine, the server holds everything too.
 * Asked on every launch from the home-screen icon (design-v2 §7.5).
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
