/**
 * Turns the TypeScript into something a phone can run.
 *
 * Run it with:   npm run build
 * The result lands in `dist/` (a junction to C:\Users\User\AppData\Local\StudyFlow\dist,
 * so it never syncs to OneDrive). GitHub Actions publishes it to
 * https://sathoni.github.io/studyflow/. Every address in it is relative, so the
 * same build works there, on localhost and in any sub-folder.
 *
 * Copied from the Andrea & Mathieu app. esbuild is called through its
 * JavaScript API rather than the command line on purpose: the project lives in
 * a folder whose name contains spaces, and the npx shim on Windows cannot cope.
 */

import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));

/**
 * Where the build goes. On this PC app\dist is a junction to a folder outside
 * OneDrive; Node's copy refuses a junction as its target, so everything is
 * written into the folder the junction points to. On GitHub Actions (and in a
 * fresh clone) dist is simply a normal folder.
 */
async function outputFolder() {
  try {
    return await realpath(join(root, 'dist'));
  } catch {
    await mkdir(join(root, 'dist'), { recursive: true });
    return join(root, 'dist');
  }
}

/**
 * The build id. It goes into the service worker's cache name and is shown in
 * Profiel. A new id is what tells an installed phone "this is genuinely
 * different, fetch it". The date makes it readable; the random tail makes two
 * builds in the same minute distinct.
 */
const BUILD_ID =
  new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + '-' + Math.random().toString(36).slice(2, 6);

const shared = {
  bundle: true,
  format: 'esm',
  target: ['safari16'],
  minify: true,
  sourcemap: true,
  legalComments: 'none',
};

/**
 * The manifest. Frozen once Mathieu installs, so think twice before changing it.
 *
 * NO start_url, on purpose (SPEC-v3 §1): iOS then keeps the address the icon
 * was added from, which is his personal link with the key in it. With a
 * start_url the icon would open the bare address and ask for the link again.
 */
const MANIFEST = {
  name: 'StudyFlow',
  short_name: 'StudyFlow',
  description: 'Kaartjes en mini-quizzen voor je vakken.',
  lang: 'nl-BE',
  dir: 'ltr',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#F4F6FB',
  theme_color: '#2F6BFF',
  icons: [
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

async function main() {
  const out = await outputFolder();
  const dist = (name = '') => join(out, name);

  // Empty dist without removing it: dist is a junction, and removing the
  // junction itself would make the next build write into OneDrive.
  for (const entry of await readdir(out)) {
    await rm(dist(entry), { recursive: true, force: true });
  }

  // The app itself.
  await build({ ...shared, entryPoints: [join(root, 'src/app.ts')], outfile: dist('app.js') });

  // The service worker: its own world, and it must sit at the top level so it
  // can control the whole app.
  await build({ ...shared, entryPoints: [join(root, 'src/sw.ts')], outfile: dist('sw.js'), format: 'iife' });

  // Everything copied as-is: index.html, app.css, icons, the demo image.
  await cp(join(root, 'public'), out, { recursive: true });

  await writeFile(dist('manifest.webmanifest'), JSON.stringify(MANIFEST, null, 2));

  // Stamp the build id into the files that carry it. After bundling, so the
  // placeholder survives minification intact.
  for (const file of ['app.js', 'sw.js']) {
    const path = dist(file);
    const text = await readFile(path, 'utf8');
    if (!text.includes('__BUILD_ID__')) throw new Error(`${file}: build id placeholder missing`);
    await writeFile(path, text.replaceAll('__BUILD_ID__', BUILD_ID));
  }

  // GitHub Pages otherwise runs the output through Jekyll, which quietly
  // ignores files beginning with an underscore.
  await writeFile(dist('.nojekyll'), '');

  console.log('Built ' + BUILD_ID + ' into dist/');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
