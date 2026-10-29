-- ===========================================================================
-- 0011 · Reminders on his phone, and "Oefen je fouten" (his wishes, 30/10)
--
--   * quiz_attempts.scope also allows 'fouten:<run id>': a practice run over
--     the mistakes of one quiz, until everything is right.
--   * push_subscriptions: his phone's address for notifications. The phone
--     writes it only through sf_push_subscribe / sf_push_unsubscribe, which
--     check the personal key.
--   * notification_log: one row per reminder, written before sending. Its key
--     ('ochtend:2026-10-31') refuses a second copy, so nothing arrives twice.
--   * sf_reminder_counts(day): what the reminders say (the morning list, the
--     new cards of the evening list).
--   * notify_config / notify_store_vapid: the signing key and the timer's
--     secret, kept in the vault. Only the server (service_role) reads them.
--   * pg_cron wakes the notify function every 5 minutes.
-- ===========================================================================

alter table public.quiz_attempts drop constraint quiz_attempts_scope_format;
alter table public.quiz_attempts add constraint quiz_attempts_scope_format check (
  scope is null
  or scope ~ '^((sessie|fouten):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|hoofdstuk:[A-Z]{2,5}-[A-Z0-9]{1,8}|vak:[A-Z]{2,5})$'
);

create table public.push_subscriptions (
  endpoint     text primary key check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh       text not null check (length(p256dh) between 40 and 200),
  auth_key     text not null check (length(auth_key) between 10 and 100),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

create table public.notification_log (
  key     text primary key,
  title   text not null,
  body    text not null,
  sent    integer not null default 0,
  sent_at timestamptz not null default now()
);
alter table public.notification_log enable row level security;
revoke all on public.notification_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The phone hands over (and refreshes) its address, with the personal key.
-- ---------------------------------------------------------------------------
create function public.sf_push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.key_ok() then
    raise exception using errcode = '42501', message = 'sf_push_subscribe: no access';
  end if;
  insert into public.push_subscriptions as s (endpoint, p256dh, auth_key)
  values (p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
     set p256dh = excluded.p256dh, auth_key = excluded.auth_key, last_seen_at = now();
  return jsonb_build_object('ok', true);
end
$$;

create function public.sf_push_unsubscribe(p_endpoint text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.key_ok() then
    raise exception using errcode = '42501', message = 'sf_push_unsubscribe: no access';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.sf_push_subscribe(text, text, text) from public, authenticated;
revoke all on function public.sf_push_unsubscribe(text) from public, authenticated;
grant execute on function public.sf_push_subscribe(text, text, text) to anon;
grant execute on function public.sf_push_unsubscribe(text) to anon;

-- ---------------------------------------------------------------------------
-- What a reminder says on a study day. Mirrors the app's two lists closely
-- enough for a reminder: the morning list exactly (nothing is answered at
-- 7:00), the evening list by its first part (today's and yesterday's study).
-- ---------------------------------------------------------------------------
create function public.sf_reminder_counts(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with defaults as (
    select coalesce((select s.value from public.settings s where s.key = 'defaults'), '{}'::jsonb) as v
  ),
  sunday as (select extract(isodow from p_day) = 7 as yes),
  plan as (select d.cap, d.new_max from public.day_plan d where d.day = p_day),
  st as (select * from public.card_states()),
  live as (select c.id, c.course_id from public.cards c where c.status = 'live'),
  due as (
    select count(*)::int as n
      from live l join st on st.card_id = l.id
     where st.box between 1 and 6 and st.due_day <= p_day
  ),
  fresh as (
    select distinct x.card_id, s.course_id
      from public.study_sessions s, unnest(s.card_ids) as x(card_id)
     where s.kind <> 'import'
       and split_part(s.session_key, ':', 2) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       and split_part(s.session_key, ':', 2)::date between p_day - 1 and p_day
  ),
  fresh_open as (
    select f.card_id, f.course_id
      from fresh f
      join live l on l.id = f.card_id
      left join st on st.card_id = f.card_id
     where coalesce(st.box, 0) = 0
  ),
  new_today as (
    select count(distinct r.card_id)::int as n
      from public.reviews r
     where r.day = p_day and r.mode = 'sessie' and r.result in ('gekend', 'hint', 'niet')
       and not exists (select 1 from public.reviews u where u.result = 'undo' and u.undoes = r.id)
       and not exists (
         select 1 from public.reviews e
          where e.card_id = r.card_id and e.day < p_day and e.result in ('gekend', 'hint', 'niet', 'opnieuw')
       )
  )
  select jsonb_build_object(
    'morning', least(
      (select n from due),
      coalesce((select cap from plan),
               case when (select yes from sunday) then coalesce(((select v from defaults) ->> 'cap_sunday')::int, 30)
                    else coalesce(((select v from defaults) ->> 'cap')::int, 20) end)),
    'evening_fresh', (select count(*)::int from fresh_open),
    'evening_courses', coalesce((select jsonb_agg(distinct course_id) from fresh_open), '[]'::jsonb),
    'new_max', coalesce((select new_max from plan),
               case when (select yes from sunday) then coalesce(((select v from defaults) ->> 'new_max_sunday')::int, 5)
                    else coalesce(((select v from defaults) ->> 'new_max')::int, 10) end),
    'new_done_today', (select n from new_today)
  );
$$;
revoke all on function public.sf_reminder_counts(date) from public, anon, authenticated;
grant execute on function public.sf_reminder_counts(date) to service_role;

-- ---------------------------------------------------------------------------
-- The vault: the timer's secret (made here, never shown) and the signing key
-- (made by the notify function's setup action, never shown either).
-- ---------------------------------------------------------------------------
create function public.notify_config()
returns table (cron_secret text, vapid_public text, vapid_private text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'sf_notify_cron_secret'),
    (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'sf_vapid_public'),
    (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'sf_vapid_private');
$$;
revoke all on function public.notify_config() from public, anon, authenticated;
grant execute on function public.notify_config() to service_role;

create function public.notify_store_vapid(p_public text, p_private text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from vault.secrets s where s.name = 'sf_vapid_private') then
    return false;
  end if;
  perform vault.create_secret(p_public, 'sf_vapid_public', 'StudyFlow web push: public signing key');
  perform vault.create_secret(p_private, 'sf_vapid_private', 'StudyFlow web push: private signing key (JWK)');
  return true;
end
$$;
revoke all on function public.notify_store_vapid(text, text) from public, anon, authenticated;
grant execute on function public.notify_store_vapid(text, text) to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'sf_notify_cron_secret',
                           'StudyFlow notify: shared secret of the pg_cron timer')
 where not exists (select 1 from vault.secrets s where s.name = 'sf_notify_cron_secret');

-- ---------------------------------------------------------------------------
-- The timer: every 5 minutes, the notify function decides what is due.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'studyflow-notify',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://fshdvzqsyzqvsvodxxwh.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'sf_notify_cron_secret')),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 20000);
  $cron$
);
