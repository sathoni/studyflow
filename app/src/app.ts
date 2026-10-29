/**
 * The start of the app.
 *
 *   1. Decide what it runs on (access.ts): the demo, the personal key, or
 *      nothing (then the "open via your link" screen).
 *   2. Open the local store (IndexedDB; memory for the demo) and draw from it
 *      at once. The network is never waited for.
 *   3. Start the sync rhythm (sync.ts) and the self-update recipe (updates.ts).
 *
 * The screens (screens/) are drawn by the Shell on top of the AppContext:
 * the tab bar, the address after the #, and redrawing when the data changes.
 */

import { h, fill } from './ui/dom.ts';
import { resolveAccess, isDemoHash } from './lib/access.ts';
import { openStore } from './lib/db.ts';
import { Rest, Syncer } from './lib/sync.ts';
import { refreshPush } from './lib/push.ts';
import { ImageCache, demoImages, cardImagePaths } from './lib/images.ts';
import { Actions, loadSnapshot, queueInput } from './lib/data.ts';
import { buildQueue } from './lib/queue.ts';
import { seedDemo, DEMO_PLACEHOLDER } from './demo/data.ts';
import { renderNoKey } from './screens/nokey.ts';
import { Shell } from './screens/shell.ts';
import { renderHome } from './screens/home.ts';
import { renderChapter, renderCourse, renderVakken } from './screens/courses.ts';
import { renderQuiz } from './screens/quiz.ts';
import { renderProgress } from './screens/progress.ts';
import { renderProfile } from './screens/profile.ts';
import { sessionMode } from './screens/session.ts';
import { quizRunMode } from './screens/quizrun.ts';
import { startUpdates } from './updates.ts';
import { applyTheme, readTheme, type AppContext } from './context.ts';

const root = document.getElementById('app') as HTMLElement;

async function boot(): Promise<void> {
  applyTheme(readTheme());
  startUpdates();

  const access = resolveAccess();
  if (access.mode === 'none') {
    renderNoKey(root, access.reason, () => location.reload());
    return;
  }

  const mode = access.mode === 'demo' ? 'demo' : 'real';
  const opened = await openStore(mode);
  const store = opened.store;

  let syncer: Syncer | null = null;
  let rest: Rest | null = null;
  let images = demoImages(DEMO_PLACEHOLDER);
  if (access.mode === 'demo') {
    await seedDemo(store);
  } else {
    rest = new Rest({ key: access.key });
    syncer = new Syncer({ store, rest });
    const signer = rest;
    images = new ImageCache({ sign: (paths) => signer.signImages(paths), blobs: opened.blobs });
  }

  const actions = new Actions(store, { onRating: () => syncer?.noteRating() });
  const ctx: AppContext = {
    mode,
    store,
    actions,
    images,
    syncer,
    rest,
    snapshot: () => loadSnapshot(store),
    onSync: (listener) => (syncer ? syncer.onState(listener) : (listener('idle'), () => undefined)),
    degraded: opened.degraded,
  };

  // Draw from the phone first, then redraw when the sync brings changes.
  const shell = new Shell(
    ctx,
    root,
    {
      '': { tab: 'home', render: renderHome },
      vakken: { tab: 'vakken', render: renderVakken },
      vak: { tab: 'vakken', render: renderCourse },
      hoofdstuk: { tab: 'vakken', render: renderChapter },
      quiz: { tab: 'quiz', render: renderQuiz },
      voortgang: { tab: 'voortgang', render: renderProgress },
      profiel: { tab: 'profiel', render: renderProfile },
    },
    { sessie: sessionMode, quizrun: quizRunMode },
  );
  await shell.start();
  store.onChange(() => shell.scheduleRedraw());

  // Reminders: hand the phone's address over again on every start (iOS may change it).
  if (rest) void refreshPush(rest).catch(() => undefined);

  if (syncer) {
    syncer.start();
    syncer.onState((state) => {
      if (state === 'no-access') {
        shell.stop();
        showNoAccess();
      }
      if (state === 'idle') void prefetchToday(ctx).catch(() => undefined);
      if (state === 'offline' || state === 'idle') shell.scheduleRedraw();
    });
  }

  // Leaving #demo for the real app (or the other way) is a different world.
  window.addEventListener('hashchange', () => {
    if (isDemoHash(location.hash) !== (mode === 'demo')) location.reload();
  });
}

/** Today's cards and the open session quizzes, fetched ahead so the session never waits. */
async function prefetchToday(ctx: AppContext): Promise<void> {
  const s = await ctx.snapshot();
  const queue = buildQueue(queueInput(s));
  const quizCards = new Set(
    s.quizzes.flatMap((q) => q.item_ids).map((id) => s.items.find((i) => i.id === id)?.card_id),
  );
  const cards = [...queue.remaining.map((i) => i.card), ...s.cards.filter((c) => quizCards.has(c.id))];
  await ctx.images.prefetch(cardImagePaths(cards, s.slides));
}

/**
 * The server no longer accepts the key. It is not forgotten: the Home Screen
 * icon carries it in its address anyway, and a key that comes back to life
 * (a mistaken revoke undone) then simply works again on the next launch.
 */
function showNoAccess(): void {
  fill(
    root,
    h(
      'main',
      { class: 'nokey' },
      h('h1', { text: 'Deze link werkt niet meer' }),
      h('p', { class: 'nokey-lead', text: 'Vraag Claude om een nieuwe persoonlijke link en zet die opnieuw op je beginscherm.' }),
    ),
  );
}

boot().catch((error) => {
  console.error(error);
  fill(root, h('main', { class: 'nokey' }, h('h1', { text: 'StudyFlow kon niet starten' }), h('p', { text: String(error) })));
});
