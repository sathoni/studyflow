/**
 * Pulls the icons the app uses out of Phosphor and writes them into
 * src/ui/icons.ts. Copied from the Andrea & Mathieu app.
 *
 * Run:  npm run icons      (needs the dev dependencies: npm run deps)
 *
 * Done ahead of time so the app carries only the icons it actually uses,
 * rather than a whole icon package, and needs no network to draw them.
 * Phosphor is MIT licensed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** name in our code -> file in the Phosphor package */
const WANTED = {
  // The tab bar: Home · Vakken · Quiz · Voortgang · Profiel (outline, and filled when active).
  home: 'regular/house',
  homeOn: 'fill/house-fill',
  courses: 'regular/cards',
  coursesOn: 'fill/cards-fill',
  quiz: 'regular/seal-question',
  quizOn: 'fill/seal-question-fill',
  progress: 'regular/chart-bar',
  progressOn: 'fill/chart-bar-fill',
  profile: 'regular/user',
  profileOn: 'fill/user-fill',
  // Course tiles (SPEC-v3 §2): courses.icon names these.
  truck: 'fill/truck-fill',
  scales: 'fill/scales-fill',
  building: 'fill/buildings-fill',
  calculator: 'fill/calculator-fill',
  globe: 'fill/globe-hemisphere-west-fill',
  speech: 'fill/chat-circle-text-fill',
  // Everything else.
  star: 'regular/star',
  starOn: 'fill/star-fill',
  close: 'regular/x',
  chevronLeft: 'regular/caret-left',
  chevronRight: 'regular/caret-right',
  chevronDown: 'regular/caret-down',
  hint: 'regular/lightbulb',
  check: 'bold/check-bold',
  wrong: 'bold/x-bold',
  undo: 'regular/arrow-counter-clockwise',
  more: 'regular/dots-three',
  flag: 'regular/flag',
  copy: 'regular/copy',
  play: 'fill/play-fill',
  plus: 'regular/plus',
  moon: 'regular/moon',
  sun: 'regular/sun',
  bell: 'regular/bell',
  download: 'regular/download-simple',
  offline: 'regular/wifi-slash',
  streak: 'fill/fire-fill',
  book: 'regular/book-open-text',
  exam: 'regular/exam',
  // Screens (v1 screens, 2026-10-26).
  target: 'fill/target-fill',
  medal: 'fill/medal-fill',
  pencil: 'fill/pencil-simple-fill',
  external: 'regular/arrow-square-out',
  checkCircle: 'fill/check-circle-fill',
  wrongCircle: 'fill/x-circle-fill',
  arrowRight: 'regular/arrow-right',
  sparkle: 'fill/sparkle-fill',
  trendUp: 'regular/trend-up',
  trendDown: 'regular/trend-down',
  clipboard: 'regular/clipboard-text',
  sync: 'regular/arrows-clockwise',
  info: 'regular/info',
  sealCheck: 'fill/seal-check-fill',
  calendar: 'regular/calendar-blank',
  lightning: 'fill/lightning-fill',
  chevronUp: 'regular/caret-up',
  zoom: 'regular/magnifying-glass-plus',
  cloudCheck: 'regular/cloud-check',
  hintOn: 'fill/lightbulb-fill',
  timer: 'regular/timer',
  swipe: 'regular/hand-swipe-right',
};

/** Keep only what is inside <svg>...</svg>, and strip the fixed fill so the
 *  icon inherits the surrounding text colour. */
function inner(svg) {
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');
  return body
    .replace(/\s*fill="#[0-9a-fA-F]{3,8}"/g, '')
    .replace(/<rect\s+width="256"\s+height="256"\s+fill="none"\s*\/>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const entries = [];
for (const [name, file] of Object.entries(WANTED)) {
  const path = root + 'node_modules/@phosphor-icons/core/assets/' + file + '.svg';
  let svg;
  try {
    svg = await readFile(path, 'utf8');
  } catch {
    console.warn('  missing, skipped:', file);
    continue;
  }
  entries.push(`  ${name}: '${inner(svg).replace(/'/g, "\\'")}',`);
}

const out = `/**
 * Icons. Generated - do not edit by hand.
 *
 * Regenerate with:  npm run icons   (tools/make-icons-ts.mjs)
 *
 * Only the icons the app actually uses, taken from Phosphor (MIT) and stripped
 * of their fixed colour so they inherit the text colour around them.
 */

export const ICONS: Record<string, string> = {
${entries.join('\n')}
};

/** An inline <svg> for h(..., { html: icon('home') }). Unknown names draw nothing. */
export function icon(name: string, size = 24): string {
  const body = ICONS[name];
  if (!body) return '';
  return \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="\${size}" height="\${size}" fill="currentColor" aria-hidden="true">\${body}</svg>\`;
}
`;

await writeFile(root + 'src/ui/icons.ts', out);
console.log(`Wrote ${entries.length} icons to src/ui/icons.ts`);
