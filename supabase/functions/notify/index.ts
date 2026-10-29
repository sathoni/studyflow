/**
 * notify: StudyFlow's reminders on his phone (his wish, 30/10).
 *
 * Woken every 5 minutes by a timer in the database (pg_cron). It asks rules.ts
 * whether a reminder's window is open (7:00 the morning list, 21:00 the evening
 * list, Brussels time), counts what is waiting (sf_reminder_counts), writes the
 * reminder to notification_log first (its key refuses a second copy, so nothing
 * arrives twice) and only then sends it through Apple with webpush.ts. A phone
 * that has gone (uninstalled, notifications off) is forgotten.
 *
 * Every request must carry the timer's secret, which only the database knows
 * (vault). The signing key is made here, once (setup), and kept in the vault:
 * it never appears anywhere else. The recipe and webpush.ts come from the
 * Andrea & Mathieu app, where they were tested on real iPhones.
 *
 * Actions:
 *   tick    the 5-minute run. { dryRun: true, now } works a moment out without
 *           logging or sending anything.
 *   test    one test notification to every phone.
 *   setup   makes the signing key, once, and returns its public half.
 */

import { generateVapid, sendPush, type Vapid } from './webpush.ts';
import { dueReminders, openKinds, studyDayOf, type Counts, type Reminder } from './rules.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/** Who Apple can contact about these messages: the app's own address. */
const SUBJECT = 'https://sathoni.github.io/studyflow/';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function db(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path.split('?')[0]} answered ${response.status}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

function rpc(name: string, args: Row = {}): Promise<unknown> {
  return db(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
}

interface Config {
  cron_secret: string | null;
  vapid_public: string | null;
  vapid_private: string | null;
}

async function readConfig(): Promise<Config> {
  const result = await rpc('notify_config');
  const first = (Array.isArray(result) ? result[0] : result) as Row | null;
  return {
    cron_secret: first?.cron_secret ?? null,
    vapid_public: first?.vapid_public ?? null,
    vapid_private: first?.vapid_private ?? null,
  };
}

async function setup(config: Config) {
  if (config.vapid_public && config.vapid_private) return { ok: true, publicKey: config.vapid_public, created: false };
  const keys = await generateVapid();
  const stored = await rpc('notify_store_vapid', { p_public: keys.publicKey, p_private: JSON.stringify(keys.privateJwk) });
  if (stored !== true) return { ok: true, publicKey: (await readConfig()).vapid_public, created: false };
  return { ok: true, publicKey: keys.publicKey, created: true };
}

async function phones(): Promise<Row[]> {
  const result = await db('/push_subscriptions?select=endpoint,p256dh,auth_key');
  return Array.isArray(result) ? (result as Row[]) : [];
}

/** Send to every phone; forget the ones that have gone. */
async function deliver(vapid: Vapid, payload: { title: string; body: string; tag: string }) {
  let sent = 0;
  const failed: string[] = [];
  for (const phone of await phones()) {
    try {
      const result = await sendPush({ endpoint: phone.endpoint, p256dh: phone.p256dh, auth: phone.auth_key }, payload, vapid);
      if (result.ok) sent++;
      else if (result.gone) await db(`/push_subscriptions?endpoint=eq.${encodeURIComponent(phone.endpoint)}`, { method: 'DELETE' });
      else failed.push(`${result.status} ${result.detail ?? ''}`.trim());
    } catch (error) {
      failed.push(String(error));
    }
  }
  return { sent, failed };
}

/** Write the reminder to the log first: true only when this is its first copy. */
async function logOnce(r: Reminder): Promise<boolean> {
  const rows = await db('/notification_log', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify([{ key: r.key, title: r.skip ? 'overgeslagen' : r.title, body: r.skip ? 'niets te doen' : r.body }]),
  });
  return Array.isArray(rows) && rows.length === 1;
}

async function tick(vapid: Vapid | null, now: number, dryRun: boolean) {
  const day = studyDayOf(now);
  const keys = [`ochtend:${day}`, `avond:${day}`].map((k) => `"${k}"`).join(',');
  const loggedRows = (await db(`/notification_log?select=key&key=in.(${encodeURIComponent(keys)})`)) as Row[];
  const logged = new Set(loggedRows.map((r) => String(r.key)));
  if (openKinds(now, logged).length === 0) return { day, due: [] };

  const counts = (await rpc('sf_reminder_counts', { p_day: day })) as Counts;
  const due = dueReminders(now, logged, counts);
  if (dryRun) return { day, counts, due };

  const results: Row[] = [];
  for (const r of due) {
    if (!(await logOnce(r))) continue;
    if (r.skip || !vapid) {
      results.push({ key: r.key, skipped: true });
      continue;
    }
    const out = await deliver(vapid, { title: r.title, body: r.body, tag: r.tag });
    await db(`/notification_log?key=eq.${encodeURIComponent(r.key)}`, { method: 'PATCH', body: JSON.stringify({ sent: out.sent }) });
    results.push({ key: r.key, ...out });
  }
  return { day, counts, results };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (request: Request) => {
  try {
    const config = await readConfig();
    if (!config.cron_secret || request.headers.get('x-notify-secret') !== config.cron_secret) {
      return json({ error: 'forbidden' }, 403);
    }
    const input = ((await request.json().catch(() => ({}))) ?? {}) as Row;
    const action = String(input.action ?? 'tick');
    if (action === 'setup') return json(await setup(config));

    const vapid: Vapid | null =
      config.vapid_public && config.vapid_private
        ? { publicKey: config.vapid_public, privateJwk: JSON.parse(config.vapid_private), subject: SUBJECT }
        : null;
    if (action === 'test') {
      if (!vapid) return json({ error: 'run setup first' }, 409);
      return json(
        await deliver(vapid, {
          title: '🔔 StudyFlow',
          body: String(input.body ?? 'Je meldingen werken. Tot morgen om 7:00!'),
          tag: 'studyflow-test',
        }),
      );
    }
    const now = input.now ? Date.parse(String(input.now)) : Date.now();
    return json(await tick(vapid, now, Boolean(input.dryRun)));
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
