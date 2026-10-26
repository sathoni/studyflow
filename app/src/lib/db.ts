/**
 * The store the whole app shares, and what it runs on.
 *
 * Its own file, as in the Andrea app, so screens, sync and images can all
 * reach it without importing each other.
 *
 *   real use   IndexedDB, or memory when iOS refuses IndexedDB (private
 *              browsing, a database killed mid-upgrade): the app still works
 *              for that launch and sends what it wrote before closing.
 *   #demo      memory only, filled with the built-in fake data. Demo mode
 *              never touches the real database or the network.
 */

import { FallbackDriver, MemoryDriver, Store, type Driver } from './store.ts';
import { IndexedDbDriver, requestPersistence, storageAvailable } from './indexeddb.ts';
import type { BlobStore } from './images.ts';

export interface OpenedStore {
  store: Store;
  driver: Driver;
  /** Where image blobs go; null on memory. */
  blobs: BlobStore | null;
  /** True when IndexedDB was not available and memory took over. */
  degraded: boolean;
}

export async function openStore(mode: 'real' | 'demo'): Promise<OpenedStore> {
  if (mode === 'demo' || !storageAvailable()) {
    const driver = new MemoryDriver();
    return { store: new Store(driver), driver, blobs: null, degraded: mode !== 'demo' };
  }
  const idb = new IndexedDbDriver();
  const fallback = new FallbackDriver(idb.opened());
  const inner = await fallback.ready();
  // Best effort: ask iOS not to evict the cards when the phone gets full.
  void requestPersistence();
  return {
    store: new Store(fallback),
    driver: fallback,
    blobs: inner instanceof IndexedDbDriver ? inner : null,
    degraded: fallback.degraded,
  };
}
