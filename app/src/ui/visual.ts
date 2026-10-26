/**
 * A card visual: a CSS crop of the full slide image (SPEC-v3 §5). The frame
 * takes the crop's own shape; tapping it opens the full-screen viewer.
 *
 * The image comes from images.url() (the blob cache, or a signed address);
 * until it arrives the frame shows a soft placeholder, and without a
 * connection it says so calmly instead of showing a broken picture.
 */

import { h } from './dom.ts';
import { icon } from './icons.ts';
import type { Slide, Visual } from '../lib/model.ts';
import type { Images } from '../lib/images.ts';
import { cropBox, styleText, visualPath } from '../lib/images.ts';
import { openViewer } from './viewer.ts';

export interface VisualEnv {
  images: Images;
  slides: ReadonlyMap<string, Slide>;
}

export function visualFrame(visual: Visual | null | undefined, env: VisualEnv): HTMLElement | null {
  if (!visual) return null;
  const path = visualPath(visual, env.slides);
  if (!path) return null;
  const slide = env.slides.get(visual.slide);
  const w = slide?.w ?? 2000;
  const hgt = slide?.h ?? 1125;
  const box = cropBox(visual.crop ?? null, w, hgt);

  const img = h('img', { class: 'visual-img', alt: visual.caption ?? 'Schema uit de dia', style: styleText(box.image), draggable: 'false' });
  const frame = h(
    'button',
    {
      class: 'visual-frame loading',
      type: 'button',
      style: styleText(box.frame),
      'aria-label': 'Afbeelding groot bekijken',
    },
    img,
    h('span', { class: 'visual-zoom', html: icon('zoom', 16), 'aria-hidden': 'true' }),
  );
  let src: string | null = null;
  frame.addEventListener('click', (event) => {
    event.stopPropagation();
    if (src) openViewer({ src, w, h: hgt, crop: visual.crop ?? null, caption: visual.caption ?? null });
  });

  void env.images.url(path).then(
    (url) => {
      if (!url) {
        frame.classList.remove('loading');
        frame.classList.add('missing');
        frame.appendChild(h('span', { class: 'visual-missing', text: 'Afbeelding nog niet beschikbaar (offline?)' }));
        return;
      }
      src = url;
      img.addEventListener('load', () => frame.classList.remove('loading'), { once: true });
      img.addEventListener(
        'error',
        () => {
          frame.classList.remove('loading');
          frame.classList.add('missing');
        },
        { once: true },
      );
      img.src = url;
    },
    () => {
      frame.classList.remove('loading');
      frame.classList.add('missing');
    },
  );

  return h(
    'figure',
    { class: 'visual' },
    frame,
    visual.caption ? h('figcaption', { class: 'visual-caption', text: visual.caption }) : null,
  );
}
