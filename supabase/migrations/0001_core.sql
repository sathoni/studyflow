-- StudyFlow 0001_core: the personal-key access rule, all tables, touch triggers, RLS, grants.
-- Data contract: docs/SCHEMA.md. Change both together.
--
-- There are NO user accounts. The app calls the REST API with the publishable key (role anon)
-- plus the header  x-sf-key: <KEY>.  private.key_ok() checks the SHA-256 of that header
-- against private.app_keys. Every client policy is "to anon using (private.key_ok())".
-- The routine and Claude use the Supabase connector (role postgres), which bypasses RLS.
--
-- Project settings this file relies on:
--   * "Automatically expose new tables" is OFF, so every table gets explicit grants below.
--   * Automatic RLS is ON; RLS is also enabled explicitly here.
-- 0000_owner_guard (already applied, kept) created schema "private" and a trigger on
-- auth.users that rejects every sign-up except Mathieu's Gmail. auth is not used otherwise.

-- ---------------------------------------------------------------------------
-- Extensions and the private schema
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
-- anon needs USAGE so the RLS policies can call private.key_ok().
-- Taking it away makes every policy *fail* instead of returning nothing (vault note "Supabase").
grant usage on schema private to anon;

-- Functions created later in "private" must not be executable by PUBLIC by default.
alter default privileges for role postgres in schema private revoke execute on functions from public;
-- The owner-guard trigger function from 0000 was created with the default PUBLIC execute.
revoke all on function private.only_owner_signup() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The personal key
-- ---------------------------------------------------------------------------
-- Only the SHA-256 of each KEY is stored. The KEY itself lives in
-- C:\Users\User\.studyflow\tokens.json (APP_KEY) and in Mathieu's personal link.
-- A leaked link: insert a new key, set revoked_at on the old one.
create table private.app_keys (
  id         uuid primary key default gen_random_uuid(),
  hash       bytea not null unique check (octet_length(hash) = 32),
  label      text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table private.app_keys enable row level security;   -- no policies: never reachable by a client
revoke all on private.app_keys from public, anon, authenticated, service_role;

-- Server tokens for the Edge Functions (INGEST_TOKEN, ROUTINE_TOKEN): only their SHA-256.
-- The functions check them with the service role through public.sf_token_ok() (0003).
-- Kept apart from app_keys so a server token can never pass private.key_ok().
create table private.function_tokens (
  name       text primary key check (name in ('INGEST_TOKEN', 'ROUTINE_TOKEN')),
  hash       bytea not null unique check (octet_length(hash) = 32),
  created_at timestamptz not null default now()
);
alter table private.function_tokens enable row level security;
revoke all on private.function_tokens from public, anon, authenticated, service_role;

-- The access rule. stable + security definer + empty search_path, and executable by anon.
create or replace function private.key_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.app_keys k
    where k.revoked_at is null
      and k.hash = extensions.digest(
            nullif(current_setting('request.headers', true), '')::json ->> 'x-sf-key',
            'sha256')
  );
$$;
revoke all on function private.key_ok() from public;
-- Must stay executable by anon (see the trap above).
grant execute on function private.key_ok() to anon, service_role;

-- updated_at is always set by the server, on insert and on update, so the app's
-- "updated_at > cursor - 1h" pull never misses a row because a writer sent an old value.
create or replace function private.touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
revoke all on function private.touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Content tables (the app only reads them; the routine writes as postgres)
-- ---------------------------------------------------------------------------
create table public.courses (
  id         text primary key check (id ~ '^[A-Z]{2,5}$'),
  name       text not null,
  color      text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  icon       text not null,
  sort       smallint not null default 0,
  updated_at timestamptz not null default now()
);
create index courses_updated_at on public.courses (updated_at);

create table public.chapters (
  id              text primary key check (id ~ '^[A-Z]{2,5}-[A-Z0-9]{1,8}$'),
  course_id       text not null references public.courses (id),
  code            text not null,
  title           text not null,
  sort            smallint not null default 0,
  notion_page_id  text,
  slide_numbering text not null default 'position'
                  check (slide_numbering in ('printed', 'position', 'book', 'none')),
  updated_at      timestamptz not null default now(),
  check (split_part(id, '-', 1) = course_id)
);
create index chapters_course_id on public.chapters (course_id);
create index chapters_updated_at on public.chapters (updated_at);

create table public.exams (
  id          uuid primary key default gen_random_uuid(),
  course_id   text references public.courses (id),          -- null = all courses
  kind        text not null check (kind in ('toets', 'proefexamen', 'examen', 'opdracht')),
  day         date not null,
  end_day     date,
  chapter_ids text[] not null default '{}',                 -- empty = whole course
  title       text not null,
  updated_at  timestamptz not null default now(),
  check (end_day is null or end_day >= day)
);
create index exams_course_id on public.exams (course_id);
create index exams_updated_at on public.exams (updated_at);

-- Full page images: key 'SCM-H3/p006' -> object 'SCM-H3/p006.webp' in bucket "slides".
-- chapter_id is the key prefix; it is not a foreign key, because book pages
-- ('FB-BOEK', 'BE-BOEK') are page stores, not study chapters.
create table public.slides (
  key        text primary key check (key ~ '^[A-Z]{2,5}-[A-Z0-9]{1,8}/p[0-9]{3}$'),
  chapter_id text not null,
  page_idx   int not null check (page_idx between 0 and 999),
  printed_no text,
  title      text,
  text       text,
  image_path text not null,
  w          int not null check (w > 0),
  h          int not null check (h > 0),
  updated_at timestamptz not null default now(),
  check (key = chapter_id || '/p' || lpad(page_idx::text, 3, '0')),
  check (image_path = key || '.webp')
);
create index slides_chapter_id on public.slides (chapter_id, page_idx);
create index slides_updated_at on public.slides (updated_at);

create table public.cards (
  id               uuid primary key default gen_random_uuid(),
  course_id        text not null references public.courses (id),
  chapter_id       text not null references public.chapters (id),
  type             text not null check (type in ('begrip', 'schema', 'formule', 'rekenen',
                                                 'casus', 'grammatica', 'vertaling', 'waarom')),
  front            jsonb not null,
  answer           jsonb not null,
  hints            jsonb not null,
  source           jsonb not null,
  exam_value       smallint not null default 2 check (exam_value between 1 and 3),
  sibling_group    text,
  sort             int not null default 0,
  legacy_notion_id text,
  notion_inbox_id  text,
  status           text not null default 'live' check (status in ('live', 'needs_check', 'retired')),
  version          int not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (jsonb_typeof(front) = 'object' and jsonb_typeof(front -> 'text') = 'string'),
  check (jsonb_typeof(answer) = 'object' and jsonb_typeof(answer -> 'core') = 'string'),
  check (jsonb_typeof(hints) = 'array' and jsonb_array_length(hints) = 3
         and not jsonb_path_exists(hints, '$[*] ? (@.type() != "string")')),
  check (jsonb_typeof(source) = 'object' and jsonb_typeof(source -> 'label') = 'string'),
  check (split_part(chapter_id, '-', 1) = course_id)
);
create index cards_course_id on public.cards (course_id);
create index cards_chapter_id on public.cards (chapter_id);
create index cards_updated_at on public.cards (updated_at);
create index cards_legacy_notion_id on public.cards (legacy_notion_id) where legacy_notion_id is not null;
create index cards_notion_inbox_id on public.cards (notion_inbox_id) where notion_inbox_id is not null;

create table public.quiz_items (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references public.cards (id),
  course_id    text not null references public.courses (id),
  chapter_id   text not null references public.chapters (id),
  format       text not null check (format in ('mcq', 'tf', 'cloze', 'numeric')),
  stem         text not null,
  options      jsonb,
  answer       jsonb,
  hint         text,
  explanation  text,
  source_label text,
  status       text not null default 'live' check (status in ('live', 'retired')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- The shapes from SCHEMA.md, enforced for live items.
  check (status <> 'live' or case format
    when 'mcq' then
      jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4
      and jsonb_array_length(jsonb_path_query_array(options, '$[*] ? (@.correct == true)')) = 1
    when 'tf' then
      jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 2
      and jsonb_array_length(jsonb_path_query_array(options, '$[*] ? (@.correct == true)')) = 1
    when 'cloze' then
      position('____' in stem) > 0
      and jsonb_typeof(answer -> 'accept') = 'array' and jsonb_array_length(answer -> 'accept') >= 1
    when 'numeric' then
      jsonb_typeof(answer -> 'value') = 'number'
    else false end),
  check (split_part(chapter_id, '-', 1) = course_id)
);
create index quiz_items_card_id on public.quiz_items (card_id);
create index quiz_items_course_id on public.quiz_items (course_id);
create index quiz_items_chapter_id on public.quiz_items (chapter_id);
create index quiz_items_updated_at on public.quiz_items (updated_at);

create table public.day_plan (
  day          date primary key,
  course_order text[] not null default '{}',
  reason       text,
  cap          smallint check (cap >= 0),          -- null = settings.defaults
  new_max      smallint check (new_max >= 0),      -- null = settings.defaults
  reminder_at  time default '21:00',               -- null = no reminder (shift night)
  source       text not null default 'notion' check (source in ('notion', 'auto')),
  updated_at   timestamptz not null default now()
);
create index day_plan_updated_at on public.day_plan (updated_at);

create table public.instruments (
  id         uuid primary key default gen_random_uuid(),
  course_id  text not null references public.courses (id),
  chapter_id text not null references public.chapters (id),
  title      text not null,
  notion_url text,
  minutes    smallint not null default 10 check (minutes > 0),
  status     text not null default 'live',
  updated_at timestamptz not null default now()
);
create index instruments_course_id on public.instruments (course_id);
create index instruments_chapter_id on public.instruments (chapter_id);
create index instruments_updated_at on public.instruments (updated_at);

create table public.settings (
  key        text primary key check (key ~ '^[a-z_]{2,40}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
create index settings_updated_at on public.settings (updated_at);

create table public.pipeline_status (
  id             smallint primary key default 1 check (id = 1),
  last_intake_at timestamptz,
  last_intake_ok boolean,
  message        text,
  updated_at     timestamptz not null default now()
);

-- Server only: no client grants, no policies.
create table public.pipeline_runs (
  id          bigserial primary key,
  kind        text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  counts      jsonb not null default '{}'::jsonb,
  errors      jsonb not null default '[]'::jsonb
);

-- ---------------------------------------------------------------------------
-- Log tables: append-only for the client (insert + select). The client makes the
-- UUIDs, so a resent row is a harmless duplicate (Prefer: resolution=ignore-duplicates).
-- seq and created_at are always assigned by the server (column grants below).
-- ---------------------------------------------------------------------------
create table public.reviews (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references public.cards (id),
  reviewed_at timestamptz not null,
  day         date not null,                       -- study day (Brussels, 04:00 rollover)
  result      text not null check (result in ('gekend', 'hint', 'niet', 'opnieuw', 'quiz_fout', 'undo')),
  hints_used  smallint not null default 0 check (hints_used between 0 and 3),
  mode        text not null check (mode in ('sessie', 'herhaling', 'handmatig', 'quiz')),
  undoes      uuid,
  ms          int check (ms between 0 and 86400000),
  seq         bigserial not null,
  created_at  timestamptz not null default now(),
  check ((result = 'undo') = (undoes is not null))
);
create unique index reviews_seq on public.reviews (seq);
create index reviews_card_id on public.reviews (card_id, reviewed_at, id);
create index reviews_undoes on public.reviews (undoes) where undoes is not null;
create index reviews_day on public.reviews (day);

create table public.quiz_attempts (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null,
  item_id     uuid not null references public.quiz_items (id),
  card_id     uuid not null references public.cards (id),
  scope       text,
  correct     boolean not null,
  answer      jsonb,
  hint_used   boolean not null default false,
  answered_at timestamptz not null,
  day         date not null,
  seq         bigserial not null
);
create unique index quiz_attempts_seq on public.quiz_attempts (seq);
create index quiz_attempts_item_id on public.quiz_attempts (item_id);
create index quiz_attempts_card_id on public.quiz_attempts (card_id);
create index quiz_attempts_run_id on public.quiz_attempts (run_id);

create table public.card_flags (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references public.cards (id),
  reason      text not null check (reason in ('fout', 'onduidelijk', 'te_lang', 'beeld', 'dubbel')),
  note        text check (char_length(note) <= 1000),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,                         -- written only by the routine
  resolution  text                                 -- written only by the routine
);
create index card_flags_card_id on public.card_flags (card_id);
create index card_flags_open on public.card_flags (created_at) where resolved_at is null;

create table public.card_marks (
  card_id    uuid primary key references public.cards (id),
  starred    boolean not null default false,
  updated_at timestamptz not null default now()
);
create index card_marks_updated_at on public.card_marks (updated_at);

create table public.instrument_reviews (
  id            uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.instruments (id),
  day           date not null,
  score         text not null check (score in ('alles', 'bijna', 'veel_fout')),
  created_at    timestamptz not null default now(),
  seq           bigserial not null
);
create unique index instrument_reviews_seq on public.instrument_reviews (seq);
create index instrument_reviews_instrument_id on public.instrument_reviews (instrument_id, day);

-- ---------------------------------------------------------------------------
-- Touch triggers (every table with updated_at)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['courses', 'chapters', 'exams', 'slides', 'cards', 'quiz_items',
                           'day_plan', 'instruments', 'settings', 'pipeline_status', 'card_marks']
  loop
    execute format(
      'create trigger touch_updated_at before insert or update on public.%I
         for each row execute function private.touch()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: every client policy is "to anon using (private.key_ok())".
-- (select ...) makes Postgres evaluate the check once per statement, not once per row.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['courses', 'chapters', 'exams', 'slides', 'cards', 'quiz_items',
                           'day_plan', 'instruments', 'settings', 'pipeline_status',
                           'pipeline_runs', 'reviews', 'quiz_attempts', 'card_flags', 'card_marks',
                           'instrument_reviews']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- Everything the client may read.
  foreach t in array array['courses', 'chapters', 'exams', 'slides', 'cards', 'quiz_items',
                           'day_plan', 'instruments', 'settings', 'pipeline_status',
                           'reviews', 'quiz_attempts', 'card_flags', 'card_marks', 'instrument_reviews']
  loop
    execute format(
      'create policy %I on public.%I for select to anon using ((select private.key_ok()))',
      t || '_key_select', t);
  end loop;

  -- Logs (and card_marks): the client appends. No update or delete policy on the logs, ever.
  foreach t in array array['reviews', 'quiz_attempts', 'card_flags', 'instrument_reviews', 'card_marks']
  loop
    execute format(
      'create policy %I on public.%I for insert to anon with check ((select private.key_ok()))',
      t || '_key_insert', t);
  end loop;
end
$$;

-- card_marks is the one client table that may be updated (the star toggles).
create policy card_marks_key_update on public.card_marks for update to anon
  using ((select private.key_ok())) with check ((select private.key_ok()));

-- pipeline_runs: RLS on, no policy, no client grant -> invisible to every client role.

-- ---------------------------------------------------------------------------
-- Grants. Auto-expose is OFF, so nothing is reachable unless granted here.
-- Start from zero (the default ACL leaves truncate/references/trigger on new tables).
-- Only anon gets client grants; there are no accounts, so authenticated gets nothing.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;

grant select on
  public.courses, public.chapters, public.exams, public.slides, public.cards,
  public.quiz_items, public.day_plan, public.instruments, public.settings, public.pipeline_status,
  public.reviews, public.quiz_attempts, public.card_flags, public.card_marks, public.instrument_reviews
to anon;

-- Append-only logs: insert only the client's own columns (never seq, created_at, resolved_*).
grant insert (id, card_id, reviewed_at, day, result, hints_used, mode, undoes, ms)
  on public.reviews to anon;
grant insert (id, run_id, item_id, card_id, scope, correct, answer, hint_used, answered_at, day)
  on public.quiz_attempts to anon;
grant insert (id, card_id, reason, note)
  on public.card_flags to anon;
grant insert (id, instrument_id, day, score)
  on public.instrument_reviews to anon;
-- card_marks: an upsert (Prefer: resolution=merge-duplicates) sets card_id too, so it needs
-- UPDATE on card_id as well as starred.
grant insert (card_id, starred), update (card_id, starred)
  on public.card_marks to anon;

-- bigserial columns: inserting needs nextval() on the sequence.
grant usage on sequence public.reviews_seq_seq, public.quiz_attempts_seq_seq,
  public.instrument_reviews_seq_seq to anon;

-- service_role (Edge Functions with the secret key) bypasses RLS but still needs privileges.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
