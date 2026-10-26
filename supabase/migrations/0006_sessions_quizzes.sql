-- StudyFlow 0006_sessions_quizzes: the v3 additions to the data contract (docs/SCHEMA.md).
--
--   * chapters.status            (synced from Notion by the routine)
--   * public.study_sessions      (one row per "zelfstudie gedaan" / "les gedaan" / import)
--   * public.quizzes             (the fixed session quiz, "Na je studie")
--   * Business English has no quizzes: quiz_items and quizzes refuse course BE
--   * quiz_attempts.scope must be sessie:<quiz_id> | hoofdstuk:<chapter_id> | vak:<course_id>
--   * public.sf_add_session(payload jsonb): the only write path for the course projects
--     and the routine (SCHEMA.md "The write path").
--
-- 0001-0005 are applied and never edited; this file builds on them.

-- ---------------------------------------------------------------------------
-- 1. chapters.status
-- ---------------------------------------------------------------------------
alter table public.chapters
  add column status text not null default 'niet_gezien'
    check (status in ('niet_gezien', 'bezig', 'af', 'examenklaar'));

-- ---------------------------------------------------------------------------
-- 2. study_sessions
-- ---------------------------------------------------------------------------
create table public.study_sessions (
  id          uuid primary key default gen_random_uuid(),
  session_key text not null unique check (char_length(session_key) between 5 and 120),
  course_id   text not null references public.courses (id),
  chapter_id  text not null references public.chapters (id),
  kind        text not null check (kind in ('zelfstudie', 'les', 'import')),
  title       text not null check (char_length(title) between 1 and 200),
  card_ids    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (split_part(chapter_id, '-', 1) = course_id),
  check (split_part(session_key, ':', 1) = chapter_id)
);
create index study_sessions_course_id on public.study_sessions (course_id);
create index study_sessions_chapter_id on public.study_sessions (chapter_id);
create index study_sessions_updated_at on public.study_sessions (updated_at);
create index study_sessions_card_ids on public.study_sessions using gin (card_ids);

-- ---------------------------------------------------------------------------
-- 3. quizzes (only the session quiz is stored; chapter and course quizzes are
--    sampled by the app from quiz_items every run)
-- ---------------------------------------------------------------------------
create table public.quizzes (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'sessie' check (kind in ('sessie')),
  session_id uuid references public.study_sessions (id) on delete cascade,
  course_id  text not null references public.courses (id),
  chapter_id text not null references public.chapters (id),
  title      text not null check (char_length(title) between 1 and 200),
  item_ids   uuid[] not null check (cardinality(item_ids) between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'sessie' or session_id is not null),
  check (course_id <> 'BE'),                              -- Business English has no quizzes
  check (split_part(chapter_id, '-', 1) = course_id)
);
create unique index quizzes_session_id on public.quizzes (session_id) where kind = 'sessie';
create index quizzes_course_id on public.quizzes (course_id);
create index quizzes_chapter_id on public.quizzes (chapter_id);
create index quizzes_updated_at on public.quizzes (updated_at);

-- ---------------------------------------------------------------------------
-- 4. Contract guards on existing tables
-- ---------------------------------------------------------------------------
alter table public.quiz_items
  add constraint quiz_items_not_be check (course_id <> 'BE');

alter table public.quiz_attempts
  add constraint quiz_attempts_scope_format check (
    scope is null or scope ~ ('^(sessie:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
                              '|hoofdstuk:[A-Z]{2,5}-[A-Z0-9]{1,8}|vak:[A-Z]{2,5})$'));

-- ---------------------------------------------------------------------------
-- 5. Touch triggers, RLS, grants for the new tables (same pattern as 0001)
-- ---------------------------------------------------------------------------
create trigger touch_updated_at before insert or update on public.study_sessions
  for each row execute function private.touch();
create trigger touch_updated_at before insert or update on public.quizzes
  for each row execute function private.touch();

alter table public.study_sessions enable row level security;
alter table public.quizzes enable row level security;

create policy study_sessions_key_select on public.study_sessions
  for select to anon using ((select private.key_ok()));
create policy quizzes_key_select on public.quizzes
  for select to anon using ((select private.key_ok()));

revoke all on public.study_sessions, public.quizzes from public, anon, authenticated, service_role;
grant select on public.study_sessions, public.quizzes to anon;
grant select, insert, update, delete on public.study_sessions, public.quizzes to service_role;

-- ---------------------------------------------------------------------------
-- 6. public.sf_add_session(payload jsonb) returns jsonb
--
-- Called by the course projects and the routine through the Supabase connector:
--   select public.sf_add_session($json$ {...} $json$::jsonb);
-- In one transaction it validates everything first (all problems are reported at once and
-- nothing is written when there is one), then upserts the session, the cards (version + 1
-- when a card changes) and the quiz items, then (not for BE, not for kind 'import') creates
-- or refreshes the session quiz: up to 10 items from the session's cards, at most 2 per
-- card, formats mixed. Calling it again with the same payload changes nothing.
-- ---------------------------------------------------------------------------
create or replace function public.sf_add_session(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uuid_re    constant text   := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  slide_re   constant text   := '^[A-Z]{2,5}-[A-Z0-9]{1,8}/p[0-9]{3}$';
  card_types constant text[] := array['begrip', 'schema', 'formule', 'rekenen', 'casus',
                                      'grammatica', 'vertaling', 'waarom'];
  errs       text[] := '{}';
  warns      text[] := '{}';
  v_key      text;
  v_kind     text;
  v_chapter  text;
  v_title    text;
  v_course   text;
  v_cards    jsonb;
  v_items    jsonb;
  e          record;
  c          jsonb;
  q          jsonb;
  p          text;
  v_ref      text;
  v_vis      jsonb;
  v_other    text;
  v_id       uuid;
  v_card     uuid;
  v_fmt      text;
  v_existed  boolean;
  v_n        int;
  card_ids   uuid[] := '{}';
  item_ids   uuid[] := '{}';
  v_session_id    uuid;
  v_session_cards uuid[];
  v_quiz_id       uuid;
  quiz_ids        uuid[] := '{}';
  fmt_count       jsonb  := '{}';
  v_round         int;
  n_cards_new int := 0; n_cards_upd int := 0; n_cards_same int := 0;
  n_items_new int := 0; n_items_upd int := 0; n_items_same int := 0;
begin
  -- ---- 1. Validate -------------------------------------------------------
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023',
      message = 'sf_add_session rejected the payload: it must be a JSON object';
  end if;

  v_key     := payload ->> 'session_key';
  v_kind    := payload ->> 'kind';
  v_chapter := payload ->> 'chapter_id';
  v_title   := payload ->> 'title';
  v_cards   := coalesce(payload -> 'cards', '[]'::jsonb);
  v_items   := coalesce(payload -> 'quiz_items', '[]'::jsonb);

  if jsonb_typeof(payload -> 'chapter_id') is distinct from 'string' then
    errs := errs || 'chapter_id: required string, e.g. "SCM-H3"'::text;
  else
    select ch.course_id into v_course from public.chapters ch where ch.id = v_chapter;
    if v_course is null then
      errs := errs || format('chapter_id: unknown chapter %s (it must exist in public.chapters)', v_chapter);
    end if;
  end if;

  if jsonb_typeof(payload -> 'session_key') is distinct from 'string' then
    errs := errs || 'session_key: required string, e.g. "SCM-H3:2026-10-24:121-135"'::text;
  elsif char_length(v_key) not between 5 and 120 or v_key ~ '\s' then
    errs := errs || 'session_key: 5-120 characters, no spaces'::text;
  elsif v_chapter is not null and split_part(v_key, ':', 1) is distinct from v_chapter then
    errs := errs || format('session_key: must start with "%s:"', v_chapter);
  end if;

  if v_kind is null or v_kind not in ('zelfstudie', 'les', 'import') then
    errs := errs || 'kind: one of "zelfstudie", "les", "import"'::text;
  end if;

  if jsonb_typeof(payload -> 'title') is distinct from 'string'
     or char_length(btrim(v_title)) not between 1 and 200 then
    errs := errs || 'title: required string of 1-200 characters, e.g. "SCM H3 · dia 121–135"'::text;
  end if;

  if jsonb_typeof(v_cards) <> 'array' then
    errs := errs || 'cards: must be an array'::text;
    v_cards := '[]'::jsonb;
  elsif jsonb_array_length(v_cards) > 50 then
    errs := errs || 'cards: at most 50 per call'::text;
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    errs := errs || 'quiz_items: must be an array'::text;
    v_items := '[]'::jsonb;
  elsif jsonb_array_length(v_items) > 100 then
    errs := errs || 'quiz_items: at most 100 per call'::text;
  end if;
  if jsonb_array_length(v_cards) + jsonb_array_length(v_items) = 0 then
    errs := errs || 'cards / quiz_items: nothing to add'::text;
  end if;
  if v_course = 'BE' and jsonb_array_length(v_items) > 0 then
    errs := errs || 'quiz_items: Business English (BE) has no quizzes; send its cards without quiz_items'::text;
  end if;

  -- Cards
  for e in select x.value as v, x.ord as i from jsonb_array_elements(v_cards) with ordinality x(value, ord) loop
    c := e.v;
    p := format('cards[%s]', e.i - 1);
    if jsonb_typeof(c) <> 'object' then
      errs := errs || (p || ': must be an object');
      continue;
    end if;

    if jsonb_typeof(c -> 'id') is distinct from 'string' or (c ->> 'id') !~ uuid_re then
      errs := errs || (p || '.id: required uuid string (make a fresh random uuid per card)');
      continue;
    end if;
    v_id := (c ->> 'id')::uuid;
    if v_id = any(card_ids) then
      errs := errs || format('%s.id: %s appears twice in cards', p, v_id);
      continue;
    end if;
    card_ids := card_ids || v_id;

    select ca.chapter_id into v_other from public.cards ca where ca.id = v_id;
    if v_other is not null and v_other is distinct from v_chapter then
      errs := errs || format('%s.id: card %s already exists in chapter %s; use a fresh uuid', p, v_id, v_other);
    end if;
    select s.session_key into v_other from public.study_sessions s
     where v_id = any(s.card_ids) and s.session_key is distinct from v_key limit 1;
    if found then
      errs := errs || format('%s.id: card %s already belongs to session %s; use a fresh uuid', p, v_id, v_other);
    end if;

    if (c ->> 'type') is null or (c ->> 'type') <> all(card_types) then
      errs := errs || format('%s.type: one of %s', p, array_to_string(card_types, ', '));
    end if;
    if jsonb_typeof(c -> 'front') is distinct from 'object'
       or jsonb_typeof(c -> 'front' -> 'text') is distinct from 'string'
       or btrim(c -> 'front' ->> 'text') = '' then
      errs := errs || (p || '.front: object with a non-empty "text"');
    end if;
    if jsonb_typeof(c -> 'answer') is distinct from 'object'
       or jsonb_typeof(c -> 'answer' -> 'core') is distinct from 'string'
       or btrim(c -> 'answer' ->> 'core') = '' then
      errs := errs || (p || '.answer: object with a non-empty "core"');
    end if;
    if jsonb_typeof(c -> 'hints') is distinct from 'array'
       or jsonb_array_length(c -> 'hints') <> 3
       or jsonb_path_exists(c -> 'hints', '$[*] ? (@.type() != "string")')
       or exists (select 1 from jsonb_array_elements_text(c -> 'hints') h where btrim(h) = '') then
      errs := errs || (p || '.hints: exactly 3 non-empty strings');
    end if;
    if jsonb_typeof(c -> 'source') is distinct from 'object'
       or jsonb_typeof(c -> 'source' -> 'label') is distinct from 'string' then
      errs := errs || (p || '.source: object with a "label", e.g. {"label": "SCM H3 · dia 114", "slide": "SCM-H3/p006"}');
    end if;
    if c ? 'exam_value' and jsonb_typeof(c -> 'exam_value') <> 'null'
       and (jsonb_typeof(c -> 'exam_value') <> 'number' or (c ->> 'exam_value') not in ('1', '2', '3')) then
      errs := errs || (p || '.exam_value: 1, 2 or 3');
    end if;
    if c ? 'sort' and jsonb_typeof(c -> 'sort') <> 'null'
       and (jsonb_typeof(c -> 'sort') <> 'number' or (c ->> 'sort') !~ '^-?[0-9]{1,9}$') then
      errs := errs || (p || '.sort: an integer');
    end if;
    if c ? 'status' and jsonb_typeof(c -> 'status') <> 'null'
       and coalesce(c ->> 'status', '') not in ('live', 'needs_check', 'retired') then
      errs := errs || (p || '.status: "live", "needs_check" or "retired"');
    end if;
    if exists (select 1 from unnest(array['sibling_group', 'legacy_notion_id', 'notion_inbox_id']) f
                where c ? f and jsonb_typeof(c -> f) not in ('string', 'null')) then
      errs := errs || (p || ': sibling_group, legacy_notion_id and notion_inbox_id are strings or null');
    end if;

    -- Slide references: malformed is an error; a page that is not uploaded yet is a warning.
    foreach v_ref in array array['front', 'answer'] loop
      v_vis := c -> v_ref -> 'visual';
      if v_vis is null or jsonb_typeof(v_vis) = 'null' then
        continue;
      end if;
      if jsonb_typeof(v_vis) <> 'object' then
        errs := errs || format('%s.%s.visual: null or an object', p, v_ref);
        continue;
      end if;
      if v_vis ? 'slide' and ((v_vis ->> 'slide') is null or (v_vis ->> 'slide') !~ slide_re) then
        errs := errs || format('%s.%s.visual.slide: like "SCM-H3/p006"', p, v_ref);
      elsif (v_vis ->> 'slide') is not null
            and not exists (select 1 from public.slides sl where sl.key = v_vis ->> 'slide') then
        warns := warns || format('card %s: slide %s is not uploaded yet (the card shows text only until it is)',
                                 v_id, v_vis ->> 'slide');
      end if;
      if v_vis ? 'crop' and jsonb_typeof(v_vis -> 'crop') <> 'null' and not (
           jsonb_typeof(v_vis -> 'crop') = 'array' and jsonb_array_length(v_vis -> 'crop') = 4
           and not jsonb_path_exists(v_vis -> 'crop', '$[*] ? (@.type() != "number" || @ < 0 || @ > 1)')
           and (v_vis -> 'crop' ->> 0)::numeric < (v_vis -> 'crop' ->> 2)::numeric
           and (v_vis -> 'crop' ->> 1)::numeric < (v_vis -> 'crop' ->> 3)::numeric) then
        errs := errs || format('%s.%s.visual.crop: [x0, y0, x1, y1], fractions 0-1, x0 < x1 and y0 < y1', p, v_ref);
      end if;
    end loop;
    if jsonb_typeof(c -> 'source') = 'object' and (c -> 'source') ? 'slide'
       and coalesce(c -> 'source' ->> 'slide', '') !~ slide_re then
      errs := errs || (p || '.source.slide: like "SCM-H3/p006"');
    end if;
  end loop;

  -- Quiz items
  for e in select x.value as v, x.ord as i from jsonb_array_elements(v_items) with ordinality x(value, ord) loop
    q := e.v;
    p := format('quiz_items[%s]', e.i - 1);
    if jsonb_typeof(q) <> 'object' then
      errs := errs || (p || ': must be an object');
      continue;
    end if;

    if jsonb_typeof(q -> 'id') is distinct from 'string' or (q ->> 'id') !~ uuid_re then
      errs := errs || (p || '.id: required uuid string (make a fresh random uuid per item)');
      continue;
    end if;
    v_id := (q ->> 'id')::uuid;
    if v_id = any(item_ids) then
      errs := errs || format('%s.id: %s appears twice in quiz_items', p, v_id);
      continue;
    end if;

    if jsonb_typeof(q -> 'card_id') is distinct from 'string' or (q ->> 'card_id') !~ uuid_re then
      errs := errs || (p || '.card_id: required uuid of one of the cards');
      continue;
    end if;
    v_card := (q ->> 'card_id')::uuid;
    if not (v_card = any(card_ids)
            or exists (select 1 from public.cards ca where ca.id = v_card and ca.chapter_id = v_chapter)) then
      errs := errs || format('%s.card_id: %s is not in cards and not an existing card of %s', p, v_card, v_chapter);
    end if;
    item_ids   := item_ids || v_id;

    select qi.card_id::text into v_other from public.quiz_items qi where qi.id = v_id;
    if v_other is not null and v_other::uuid is distinct from v_card then
      errs := errs || format('%s.id: item %s already exists for another card; use a fresh uuid', p, v_id);
    end if;

    if jsonb_typeof(q -> 'stem') is distinct from 'string' or btrim(q ->> 'stem') = ''
       or char_length(q ->> 'stem') > 1000 then
      errs := errs || (p || '.stem: non-empty string (max 1000 characters)');
    end if;
    if q ? 'status' and jsonb_typeof(q -> 'status') <> 'null'
       and coalesce(q ->> 'status', '') not in ('live', 'retired') then
      errs := errs || (p || '.status: "live" or "retired"');
    end if;
    if exists (select 1 from unnest(array['hint', 'explanation', 'source_label']) f
                where q ? f and jsonb_typeof(q -> f) not in ('string', 'null')) then
      errs := errs || (p || ': hint, explanation and source_label are strings or null');
    end if;

    v_fmt := q ->> 'format';
    case v_fmt
      when 'mcq' then
        if jsonb_typeof(q -> 'options') is distinct from 'array' or jsonb_array_length(q -> 'options') <> 4
           or jsonb_path_exists(q -> 'options',
                '$[*] ? (@.type() != "object" || !exists(@.text) || @.text.type() != "string" || !exists(@.correct) || @.correct.type() != "boolean")')
           or jsonb_array_length(jsonb_path_query_array(q -> 'options', '$[*] ? (@.correct == true)')) <> 1 then
          errs := errs || (p || ' (mcq): exactly 4 options {"text", "correct", "why"} with exactly 1 correct');
        elsif jsonb_path_exists(q -> 'options', '$[*] ? (!exists(@.why) || @.why.type() != "string")') then
          warns := warns || format('quiz item %s: not every option has a "why"', v_id);
        end if;
        if q ? 'answer' and jsonb_typeof(q -> 'answer') <> 'null' then
          errs := errs || (p || ' (mcq): answer must be null');
        end if;
      when 'tf' then
        if jsonb_typeof(q -> 'options') is distinct from 'array' or jsonb_array_length(q -> 'options') <> 2
           or jsonb_path_exists(q -> 'options',
                '$[*] ? (@.type() != "object" || !exists(@.text) || @.text.type() != "string" || !exists(@.correct) || @.correct.type() != "boolean")')
           or jsonb_array_length(jsonb_path_query_array(q -> 'options', '$[*] ? (@.correct == true)')) <> 1
           or (q -> 'options' -> 0 ->> 'text') is distinct from 'Juist'
           or (q -> 'options' -> 1 ->> 'text') is distinct from 'Fout' then
          errs := errs || (p || ' (tf): options [{"text": "Juist", ...}, {"text": "Fout", ...}] with exactly 1 correct');
        end if;
        if q ? 'answer' and jsonb_typeof(q -> 'answer') not in ('object', 'null') then
          errs := errs || (p || ' (tf): answer is null or {"correction": "..."}');
        end if;
      when 'cloze' then
        if position('____' in coalesce(q ->> 'stem', '')) = 0 then
          errs := errs || (p || ' (cloze): the stem must contain ____');
        end if;
        if jsonb_typeof(q -> 'answer' -> 'accept') is distinct from 'array'
           or jsonb_array_length(q -> 'answer' -> 'accept') = 0
           or jsonb_path_exists(q -> 'answer' -> 'accept', '$[*] ? (@.type() != "string")') then
          errs := errs || (p || ' (cloze): answer {"accept": ["...", ...]} with at least 1 string');
        end if;
      when 'numeric' then
        if jsonb_typeof(q -> 'answer' -> 'value') is distinct from 'number' then
          errs := errs || (p || ' (numeric): answer {"value": <number>, "unit", "tolerance", "steps"}');
        elsif (q -> 'answer') ? 'tolerance' and not (jsonb_typeof(q -> 'answer' -> 'tolerance') = 'number'
                                                    and (q -> 'answer' ->> 'tolerance')::numeric >= 0) then
          errs := errs || (p || ' (numeric): tolerance must be a number >= 0');
        end if;
      else
        errs := errs || (p || '.format: one of "mcq", "tf", "cloze", "numeric"');
    end case;
  end loop;

  if cardinality(errs) > 0 then
    raise exception using errcode = '22023',
      message = format('sf_add_session rejected the payload (%s problem(s), nothing was written): %s',
                       cardinality(errs), array_to_string(errs[1:30], ' | '));
  end if;

  -- ---- 2. Session row (one per session_key; a session never loses cards) -----
  select s.card_ids into v_session_cards from public.study_sessions s where s.session_key = v_key for update;
  v_session_cards := coalesce(v_session_cards, '{}')
                     || array(select x from unnest(card_ids) with ordinality u(x, o)
                               where x <> all(coalesce(v_session_cards, '{}')) order by o);

  insert into public.study_sessions as s (session_key, course_id, chapter_id, kind, title, card_ids)
  values (v_key, v_course, v_chapter, v_kind, btrim(v_title), v_session_cards)
  on conflict (session_key) do update
     set kind = excluded.kind, title = excluded.title, card_ids = excluded.card_ids
   where (s.kind, s.title, s.card_ids) is distinct from (excluded.kind, excluded.title, excluded.card_ids)
  returning s.id into v_session_id;
  if v_session_id is null then
    select s.id into v_session_id from public.study_sessions s where s.session_key = v_key;
  end if;

  -- ---- 3. Cards (version + 1 only when something changed) --------------------
  for e in select x.value as v, x.ord as i from jsonb_array_elements(v_cards) with ordinality x(value, ord) loop
    c := e.v;
    v_id := (c ->> 'id')::uuid;
    v_existed := exists (select 1 from public.cards ca where ca.id = v_id);
    insert into public.cards as t (id, course_id, chapter_id, type, front, answer, hints, source,
                                   exam_value, sibling_group, sort, legacy_notion_id, notion_inbox_id, status)
    values (v_id, v_course, v_chapter, c ->> 'type', c -> 'front', c -> 'answer', c -> 'hints', c -> 'source',
            coalesce((c ->> 'exam_value')::smallint, 2),
            c ->> 'sibling_group',
            coalesce((c ->> 'sort')::int, e.i::int),
            c ->> 'legacy_notion_id',
            c ->> 'notion_inbox_id',
            coalesce(c ->> 'status', 'live'))
    on conflict (id) do update
       set type = excluded.type, front = excluded.front, answer = excluded.answer,
           hints = excluded.hints, source = excluded.source, exam_value = excluded.exam_value,
           sibling_group = excluded.sibling_group, sort = excluded.sort,
           legacy_notion_id = coalesce(excluded.legacy_notion_id, t.legacy_notion_id),
           notion_inbox_id  = coalesce(excluded.notion_inbox_id, t.notion_inbox_id),
           status = excluded.status,
           version = t.version + 1
     where (t.type, t.front, t.answer, t.hints, t.source, t.exam_value, t.sibling_group, t.sort,
            t.legacy_notion_id, t.notion_inbox_id, t.status)
           is distinct from
           (excluded.type, excluded.front, excluded.answer, excluded.hints, excluded.source,
            excluded.exam_value, excluded.sibling_group, excluded.sort,
            coalesce(excluded.legacy_notion_id, t.legacy_notion_id),
            coalesce(excluded.notion_inbox_id, t.notion_inbox_id), excluded.status);
    get diagnostics v_n = row_count;
    if not v_existed then n_cards_new := n_cards_new + 1;
    elsif v_n > 0 then n_cards_upd := n_cards_upd + 1;
    else n_cards_same := n_cards_same + 1;
    end if;
  end loop;

  -- ---- 4. Quiz items -----------------------------------------------------------
  for e in select x.value as v from jsonb_array_elements(v_items) x(value) loop
    q := e.v;
    v_id := (q ->> 'id')::uuid;
    v_existed := exists (select 1 from public.quiz_items qi where qi.id = v_id);
    insert into public.quiz_items as t (id, card_id, course_id, chapter_id, format, stem, options, answer,
                                        hint, explanation, source_label, status)
    values (v_id, (q ->> 'card_id')::uuid, v_course, v_chapter, q ->> 'format', q ->> 'stem',
            nullif(q -> 'options', 'null'::jsonb), nullif(q -> 'answer', 'null'::jsonb),
            q ->> 'hint', q ->> 'explanation', q ->> 'source_label', coalesce(q ->> 'status', 'live'))
    on conflict (id) do update
       set format = excluded.format, stem = excluded.stem, options = excluded.options,
           answer = excluded.answer, hint = excluded.hint, explanation = excluded.explanation,
           source_label = excluded.source_label, status = excluded.status
     where (t.format, t.stem, t.options, t.answer, t.hint, t.explanation, t.source_label, t.status)
           is distinct from
           (excluded.format, excluded.stem, excluded.options, excluded.answer, excluded.hint,
            excluded.explanation, excluded.source_label, excluded.status);
    get diagnostics v_n = row_count;
    if not v_existed then n_items_new := n_items_new + 1;
    elsif v_n > 0 then n_items_upd := n_items_upd + 1;
    else n_items_same := n_items_same + 1;
    end if;
  end loop;

  -- ---- 5. Session quiz (not for BE, not for imports) ---------------------------
  if v_course <> 'BE' and v_kind <> 'import' then
    -- Round 1: one item per card, round 2: a second one, in session order. Within a card the
    -- format used least so far wins, so the formats mix. Deterministic: a retry gives the same quiz.
    for v_round in 1 .. 2 loop
      foreach v_card in array v_session_cards loop
        exit when cardinality(quiz_ids) >= 10;
        select qi.id, qi.format into v_id, v_fmt
          from public.quiz_items qi
          join public.cards ca on ca.id = qi.card_id
         where qi.card_id = v_card and qi.status = 'live' and ca.status <> 'retired'
           and qi.id <> all(quiz_ids)
         order by coalesce((fmt_count ->> qi.format)::int, 0), qi.created_at, qi.id
         limit 1;
        if found then
          quiz_ids  := quiz_ids || v_id;
          fmt_count := jsonb_set(fmt_count, array[v_fmt],
                                 to_jsonb(coalesce((fmt_count ->> v_fmt)::int, 0) + 1));
        end if;
      end loop;
    end loop;

    if cardinality(quiz_ids) = 0 then
      warns := warns || 'no live quiz items for this session: no session quiz was made (add quiz_items)'::text;
    else
      insert into public.quizzes as z (kind, session_id, course_id, chapter_id, title, item_ids)
      values ('sessie', v_session_id, v_course, v_chapter, btrim(v_title), quiz_ids)
      on conflict (session_id) where kind = 'sessie' do update
         set title = excluded.title, item_ids = excluded.item_ids
       where (z.title, z.item_ids) is distinct from (excluded.title, excluded.item_ids)
      returning z.id into v_quiz_id;
      if v_quiz_id is null then
        select z.id into v_quiz_id from public.quizzes z where z.session_id = v_session_id and z.kind = 'sessie';
      end if;
      if cardinality(quiz_ids) < 8 then
        warns := warns || format('the session quiz has only %s questions (aim for 8-10: add quiz items)',
                                 cardinality(quiz_ids));
      end if;
      if cardinality(quiz_ids) >= 4 and (select count(*) from jsonb_object_keys(fmt_count)) = 1 then
        warns := warns || 'every session quiz question has the same format (mix mcq, tf, cloze, numeric)'::text;
      end if;
    end if;

    select count(*) into v_n
      from unnest(card_ids) u(cid)
     where not exists (select 1 from public.quiz_items qi where qi.card_id = u.cid and qi.status = 'live');
    if v_n > 0 then
      warns := warns || format('%s card(s) of this call have no live quiz item', v_n);
    end if;
  end if;

  if v_kind <> 'import' and jsonb_array_length(v_cards) > 8 then
    warns := warns || format('%s cards in one session (the card contract says at most 8)', jsonb_array_length(v_cards));
  end if;

  return jsonb_build_object(
    'session_id',    v_session_id,
    'quiz_id',       v_quiz_id,
    'card_ids',      to_jsonb(card_ids),
    'item_ids',      to_jsonb(item_ids),
    'quiz_item_ids', to_jsonb(quiz_ids),
    'counts',        jsonb_build_object(
                       'cards_new', n_cards_new, 'cards_updated', n_cards_upd, 'cards_unchanged', n_cards_same,
                       'items_new', n_items_new, 'items_updated', n_items_upd, 'items_unchanged', n_items_same),
    'warnings',      to_jsonb(warns));
end
$$;
revoke all on function public.sf_add_session(jsonb) from public, anon, authenticated;
grant execute on function public.sf_add_session(jsonb) to service_role;
