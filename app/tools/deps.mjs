/**
 * Installs the dev dependencies without breaking the node_modules junction.
 *
 * Run it with:   npm run deps            (or: node tools/deps.mjs)
 *
 * Why this exists: app\node_modules is a junction to a folder outside OneDrive
 * (C:\Users\User\AppData\Local\StudyFlow\node_modules), so OneDrive never syncs
 * thousands of downloaded files. A plain `npm install` inside app\ sees that
 * junction as "not a directory", deletes it and creates a real node_modules in
 * OneDrive instead (seen 24/10/2026 with npm 11). So the install runs in the folder the
 * junction points into, from a copy of package.json and package-lock.json, and the
 * lock file is copied back. Node and esbuild follow the junction without noticing.
 *
 * Where node_modules is a normal folder (GitHub Actions, a fresh clone), it simply
 * runs `npm ci` in place.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const modules = join(app, 'node_modules');

function run(cmd, cwd) {
  console.log(`> ${cmd}   (in ${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

const linked = existsSync(modules) && lstatSync(modules).isSymbolicLink();
if (!linked) {
  run(existsSync(join(app, 'package-lock.json')) ? 'npm ci' : 'npm install', app);
} else {
  const local = dirname(realpathSync(modules));
  copyFileSync(join(app, 'package.json'), join(local, 'package.json'));
  if (existsSync(join(app, 'package-lock.json'))) {
    copyFileSync(join(app, 'package-lock.json'), join(local, 'package-lock.json'));
  }
  run('npm install --no-audit --no-fund', local);
  copyFileSync(join(local, 'package-lock.json'), join(app, 'package-lock.json'));
  console.log('Dependencies installed in ' + join(local, 'node_modules'));
}
