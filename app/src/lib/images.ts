/**
 * Slide images on the phone.
 *
 * The bucket `slides` is private. The app asks the Edge Function `media` for
 * signed addresses (with its x-sf-key, sync.ts Rest.signImages), downloads the
 * image once, keeps the blob in IndexedDB under its storage path
 * ('SCM-H3/p006.webp') and shows it through an object URL. After that the
 * image works offline for good; a signed address is never stored, because it
 * expires after an hour.
 *
 *   url(path)        the image to show, from memory, IndexedDB or the network
 *   prefetch(paths)  fetch ahead (today's queue and the open quizzes), so the
 *                    evening session on the train never waits for a picture
 *
 * Requests for addresses are gathered for a moment and sent in batches of at
 * most 60 (the function's limit), so a card list asking for twenty images
 * makes one call, not twenty.
 *
 * Card visuals are CSS crops of the full page (SPEC-v3 §5): cropBox() turns a
 * crop rectangle into the styles that show just that part.
 */

import type { Card, Crop, Slide, Visual } from './model.ts';
import type { SignedUrl } from './sync.ts';

/** The function's limit per call. */
export const SIGN_BATCH = 60;

/** Storage paths look like this (SCHEMA.md "Edge Functions"). */
export const PATH_RE = /^[A-Z]{2,5}-[A-Z0-9]{1,8}\/p\d{3}\.webp$/;

/** 'SCM-H3/p006' → 'SCM-H3/p006.webp'. */
export function slidePath(slideKey: string): string {
  return slideKey.endsWith('.webp') ? slideKey : `${slideKey}.webp`;
}

/** The storage path of a visual: the slide row's image_path when known, else the key + .webp. */
export function visualPath(visual: Visual | null | undefined, slides?: ReadonlyMap<string, Slide>): string | null {
  if (!visual?.slide) return null;
  const path = slides?.get(visual.slide)?.image_path ?? slidePath(visual.slide);
  return PATH_RE.test(path) ? path : null;
}

/** Every image a set of cards shows (front and back), without duplicates, in order. */
export function cardImagePaths(cards: Iterable<Card>, slides?: readonly Slide[]): string[] {
  const bySlide = slides ? new Map(slides.map((s) => [s.key, s])) : undefined;
  const seen = new Set<string>();
  for (const card of cards) {
    for (const visual of [card.front?.visual, card.answer?.visual]) {
      const path = visualPath(visual, bySlide);
      if (path) seen.add(path);
    }
  }
  return [...seen];
}

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

/** Where blobs are kept: IndexedDbDriver fits, and so does a Map in the tests. */
export interface BlobStore {
  getBlob(key: string): Promise<Blob | undefined>;
  putBlob(key: string, blob: Blob): Promise<void>;
}

/** What the screens use; demoImages() offers the same without a network. */
export interface Images {
  /** An address an <img> can show, or null when the image cannot be had right now. */
  url(path: string): Promise<string | null>;
  /** Fetch ahead. Never throws; reports what worked. */
  prefetch(paths: readonly string[]): Promise<{ ok: number; failed: number }>;
}

export interface ImageCacheOptions {
  sign: (paths: string[]) => Promise<SignedUrl[]>;
  /** null when IndexedDB is unavailable: images then live for this launch only. */
  blobs: BlobStore | null;
  fetch?: typeof fetch;
  createObjectURL?: (blob: Blob) => string;
  /** Downloads at the same time during a prefetch. */
  parallel?: number;
}

export class ImageCache implements Images {
  private options: Required<Omit<ImageCacheOptions, 'blobs'>> & { blobs: BlobStore | null };
  /** path → object URL, for this launch. */
  private urls = new Map<string, string>();
  /** path → the download in progress, so two screens asking at once share it. */
  private loading = new Map<string, Promise<string | null>>();
  /** Paths waiting for a signed address, and who waits for them. */
  private pendingSign = new Map<string, ((url: string | null) => void)[]>();
  private signTimer: Promise<void> | null = null;

  constructor(options: ImageCacheOptions) {
    this.options = {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      createObjectURL: (blob: Blob) => URL.createObjectURL(blob),
      parallel: 3,
      ...options,
    };
  }

  url(path: string): Promise<string | null> {
    const known = this.urls.get(path);
    if (known) return Promise.resolve(known);
    let job = this.loading.get(path);
    if (!job) {
      job = this.load(path).finally(() => this.loading.delete(path));
      this.loading.set(path, job);
    }
    return job;
  }

  private async load(path: string): Promise<string | null> {
    if (!PATH_RE.test(path)) return null;
    const blobs = this.options.blobs;
    try {
      const stored = await blobs?.getBlob(path);
      if (stored) return this.remember(path, stored);
    } catch {
      // A broken blob store only costs a download.
    }
    const signed = await this.signedUrl(path);
    if (!signed) return null;
    try {
      const response = await this.options.fetch(signed);
      if (!response.ok) return null;
      const blob = await response.blob();
      try {
        await blobs?.putBlob(path, blob);
      } catch {
        // Full or refused: shown now, fetched again next launch.
      }
      return this.remember(path, blob);
    } catch {
      return null;
    }
  }

  private remember(path: string, blob: Blob): string {
    const url = this.options.createObjectURL(blob);
    this.urls.set(path, url);
    return url;
  }

  /** A signed address, asked together with whatever else is asked in the same moment. */
  private signedUrl(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      const waiting = this.pendingSign.get(path);
      if (waiting) waiting.push(resolve);
      else this.pendingSign.set(path, [resolve]);
      if (!this.signTimer) {
        // One macrotask later: every url() call made while drawing a screen
        // lands in the same batch.
        this.signTimer = new Promise<void>((r) => setTimeout(r, 0)).then(() => this.sendSigns());
      }
    });
  }

  private async sendSigns(): Promise<void> {
    const batch = this.pendingSign;
    this.pendingSign = new Map();
    this.signTimer = null;
    const paths = [...batch.keys()];
    for (let i = 0; i < paths.length; i += SIGN_BATCH) {
      const part = paths.slice(i, i + SIGN_BATCH);
      let answers: SignedUrl[] = [];
      try {
        answers = await this.options.sign(part);
      } catch {
        answers = [];
      }
      const byPath = new Map(answers.map((a) => [a.path, a.signed_url ?? null]));
      for (const path of part) for (const resolve of batch.get(path) ?? []) resolve(byPath.get(path) ?? null);
    }
  }

  async prefetch(paths: readonly string[]): Promise<{ ok: number; failed: number }> {
    const todo = [...new Set(paths)].filter((p) => PATH_RE.test(p));
    let ok = 0;
    let failed = 0;
    // Ask for all addresses in one go (batched above), then download a few at a time.
    const queue = [...todo];
    const worker = async () => {
      for (let path = queue.shift(); path; path = queue.shift()) {
        if ((await this.url(path)) !== null) ok++;
        else failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.options.parallel) }, worker));
    return { ok, failed };
  }
}

/**
 * Demo mode: every path shows the bundled placeholder, and nothing touches
 * the network.
 */
export function demoImages(placeholder = './demo/placeholder.webp'): Images {
  return {
    url: async () => placeholder,
    prefetch: async (paths) => ({ ok: paths.length, failed: 0 }),
  };
}

/* ------------------------------------------------------------------ *
 * Showing a crop of a full page
 * ------------------------------------------------------------------ */

export interface CropBox {
  /** Width ÷ height of the visible part, for the frame's aspect-ratio. */
  aspect: number;
  /** Styles for the frame (position: relative; overflow: hidden). */
  frame: Record<string, string>;
  /** Styles for the full-page <img> inside it. */
  image: Record<string, string>;
}

/** A crop clamped to 0–1 and in the right order; the whole page when it is unusable. */
export function normalizeCrop(crop: Crop | null | undefined): Crop {
  if (!Array.isArray(crop) || crop.length !== 4 || crop.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return [0, 0, 1, 1];
  }
  const c = crop.map((n) => Math.min(1, Math.max(0, n)));
  const [x0, x1] = c[0] <= c[2] ? [c[0], c[2]] : [c[2], c[0]];
  const [y0, y1] = c[1] <= c[3] ? [c[1], c[3]] : [c[3], c[1]];
  // A sliver thinner than 2% of the page is a mistake, not a crop.
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return [0, 0, 1, 1];
  return [x0, y0, x1, y1];
}

/**
 * The CSS that shows just the crop of a page image of w × h pixels.
 *
 * The frame gets the crop's own aspect ratio; the image inside is enlarged so
 * the crop fills the frame, and shifted so the crop's corner sits at the
 * frame's corner. Percentages, so it works at any width.
 */
export function cropBox(crop: Crop | null | undefined, w: number, h: number): CropBox {
  const [x0, y0, x1, y1] = normalizeCrop(crop);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const pageAspect = w > 0 && h > 0 ? w / h : 2000 / 1125;
  const aspect = (cw / ch) * pageAspect;
  const pct = (n: number) => `${+(n * 100).toFixed(4)}%`;
  return {
    aspect,
    frame: {
      position: 'relative',
      overflow: 'hidden',
      'aspect-ratio': String(+aspect.toFixed(5)),
      width: '100%',
    },
    image: {
      position: 'absolute',
      'max-width': 'none',
      width: pct(1 / cw),
      height: pct(1 / ch),
      left: pct(-x0 / cw),
      top: pct(-y0 / ch),
    },
  };
}

/** The same as inline style text, for h(..., { style }). */
export function styleText(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}
