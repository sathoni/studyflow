/**
 * Profiel (SPEC-v3 §2): who, the streak with this week's check circles, the
 * three goals, and the settings: theme (Systeem / Licht / Donker), the
 * reminder (from Phase 5), the sync line, "Back-up downloaden" and the
 * version. No account, no "Uitloggen".
 */

import { h } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { toast } from '../ui/overlay.ts';
import { pageTitle, progressBar } from '../ui/parts.ts';
import { readGoals, readProfile } from '../lib/model.ts';
import { cardsLabel } from '../lib/queue.ts';
import { runScores } from '../lib/quiz.ts';
import { firstTryShare, goalProgress, quizzesThisWeek, streak, weekBars } from '../lib/stats.ts';
import { applyTheme, readTheme, type Theme } from '../context.ts';
import { BUILD_ID } from '../updates.ts';
import type { PageEnv } from './shell.ts';

const GOAL_LOOK: Record<string, { icon: string; tone: string }> = {
  daily_queue: { icon: 'pencil', tone: 'yellow' },
  accuracy: { icon: 'target', tone: 'blue' },
  quizzes_week: { icon: 'medal', tone: 'orange' },
};

export function renderProfile(env: PageEnv): Node {
  const { ctx, s, d } = env;
  const profile = readProfile(s.settings);
  const days = streak(s.reviews, s.today);
  const bars = weekBars(s.reviews, s.today);
  const goals = readGoals(s.settings)
    .map((g) =>
      goalProgress(g, {
        queue: d.queue,
        accuracy: firstTryShare(s.reviews, s.today),
        quizzesWeek: quizzesThisWeek(runScores(d.qdata), s.today),
      }),
    )
    .filter((g) => g !== null);

  return h(
    'div',
    { class: 'profile-page' },
    pageTitle('Profiel'),
    h(
      'section',
      { class: 'card who' },
      h('span', { class: 'avatar', text: (profile.name[0] ?? 'M').toUpperCase() }),
      h(
        'span',
        { class: 'who-text' },
        h('b', { text: profile.name }),
        h('span', { class: 'muted', text: profile.subtitle }),
        h('small', { class: 'muted', text: `${s.courses.length} vakken · ${cardsLabel(d.live.length)}` }),
      ),
    ),

    h(
      'section',
      { class: 'card streak-card' },
      h('h2', { class: 'card-title', text: 'Studiereeks' }),
      h('p', { class: 'streak-big' }, h('span', { class: 'flame', html: icon('streak', 28) }), h('b', { text: days === 1 ? '1 dag' : `${days} dagen` })),
      h(
        'div',
        { class: 'streak-week' },
        bars.map((b) =>
          h(
            'span',
            { class: 'streak-day' },
            h('span', {
              class: `streak-dot${b.count > 0 ? ' on' : ''}${b.isToday ? ' today' : ''}${b.future ? ' future' : ''}`,
              html: b.count > 0 ? icon('check', 14) : '',
              'aria-label': `${b.label}: ${b.count > 0 ? 'gestudeerd' : 'niet gestudeerd'}`,
            }),
            h('small', { text: b.label }),
          ),
        ),
      ),
    ),

    goals.length > 0
      ? h(
          'section',
          { class: 'card goals' },
          h('h2', { class: 'card-title', text: 'Doelen' }),
          goals.map((g) => {
            const look = GOAL_LOOK[g.goal.id] ?? { icon: 'target', tone: 'blue' };
            return h(
              'div',
              { class: `goal tone-${look.tone}${g.reached ? ' reached' : ''}` },
              h('span', { class: 'goal-icon', html: icon(look.icon, 18) }),
              h(
                'span',
                { class: 'goal-main' },
                h('span', { class: 'goal-top' }, h('span', { class: 'goal-label', text: g.goal.label }), h('span', { class: 'goal-value', text: g.label })),
                progressBar(g.share, `bar-${look.tone}`),
              ),
            );
          }),
        )
      : null,

    h(
      'section',
      { class: 'card settings' },
      h('h2', { class: 'card-title', text: 'Instellingen' }),
      settingRow('moon', 'Donkere modus', themeControl()),
      settingRow(
        'bell',
        'Meldingen',
        h('span', { class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-disabled': 'true', title: 'Komt in een volgende versie' }, h('i')),
        'Elke avond om 21:00 · komt binnenkort',
      ),
      syncRow(env),
      settingRow(
        'download',
        'Back-up downloaden',
        h('button', { class: 'btn btn-soft btn-small', type: 'button', text: 'Download', on: { click: () => void downloadBackup(env) } }),
        'Al je antwoorden als bestand (JSON)',
      ),
    ),
    h('p', { class: 'version', text: `StudyFlow · versie ${BUILD_ID}${ctx.mode === 'demo' ? ' · demo' : ''}` }),
  );
}

function settingRow(iconName: string, label: string, control: Node, sub?: string): HTMLElement {
  return h(
    'div',
    { class: 'setting' },
    h('span', { class: 'setting-icon', html: icon(iconName, 20) }),
    h('span', { class: 'setting-main' }, h('span', { class: 'setting-label', text: label }), sub ? h('small', { class: 'setting-sub', text: sub }) : null),
    control,
  );
}

function themeControl(): HTMLElement {
  const options: { id: Theme; label: string }[] = [
    { id: 'systeem', label: 'Systeem' },
    { id: 'licht', label: 'Licht' },
    { id: 'donker', label: 'Donker' },
  ];
  const wrap = h('div', { class: 'mini-seg', role: 'radiogroup', 'aria-label': 'Donkere modus' });
  const paint = () => {
    const now = readTheme();
    for (const el of wrap.querySelectorAll<HTMLElement>('button')) {
      const on = el.dataset.theme === now;
      el.classList.toggle('active', on);
      el.setAttribute('aria-checked', String(on));
    }
  };
  for (const o of options) {
    wrap.appendChild(
      h('button', {
        type: 'button',
        role: 'radio',
        dataset: { theme: o.id },
        text: o.label,
        on: {
          click: () => {
            applyTheme(o.id);
            paint();
          },
        },
      }),
    );
  }
  paint();
  return wrap;
}

/** "Alles bewaard" or "3 wachtend · Nu synchroniseren" (real use only). */
function syncRow(env: PageEnv): HTMLElement | null {
  const { ctx } = env;
  if (ctx.mode === 'demo' || !ctx.syncer) {
    return settingRow('cloudCheck', 'Synchronisatie', h('span', { class: 'muted small', text: 'Demo' }), 'In de demo wordt niets verstuurd');
  }
  const syncer = ctx.syncer;
  const sub = h('small', { class: 'setting-sub', text: '…' });
  const button = h('button', { class: 'btn btn-soft btn-small', type: 'button', text: 'Nu' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    const parked = (await ctx.store.parked()).length;
    if (parked > 0) await ctx.store.retryParked();
    const report = await syncer.syncNow();
    button.disabled = false;
    toast(report.state === 'idle' ? 'Alles is bijgewerkt' : report.state === 'offline' ? 'Geen verbinding: alles blijft bewaard' : 'Lukte niet, later opnieuw', { icon: report.state === 'idle' ? 'cloudCheck' : 'offline' });
    env.redraw();
  });
  void (async () => {
    const [pending, parked, last] = await Promise.all([ctx.store.pendingCount(), ctx.store.parked(), syncer.lastSyncAt()]);
    const when = last ? new Date(last).toLocaleString('nl-BE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'nog nooit';
    if (parked.length > 0) sub.textContent = `${parked.length} geweigerd · tik op Nu om opnieuw te proberen`;
    else if (pending > 0) sub.textContent = `${pending} wachtend · laatste keer ${when}`;
    else sub.textContent = `Alles bewaard · laatste keer ${when}`;
  })();
  const row = settingRow('sync', 'Synchronisatie', button);
  row.querySelector('.setting-main')?.appendChild(sub);
  return row;
}

async function downloadBackup(env: PageEnv): Promise<void> {
  const s = await env.ctx.snapshot();
  const data = {
    app: 'StudyFlow',
    version: BUILD_ID,
    exported_at: new Date().toISOString(),
    study_day: s.today,
    reviews: s.reviews,
    quiz_attempts: s.attempts,
    card_flags: s.flags,
    card_marks: s.marks,
    instrument_reviews: s.instrumentReviews,
    cards: s.cards,
    quiz_items: s.items,
    chapters: s.chapters,
    courses: s.courses,
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `studyflow-backup-${s.today}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Back-up gemaakt', { icon: 'download' });
}
