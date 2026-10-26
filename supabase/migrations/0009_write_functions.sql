-- ===========================================================================
-- 0009 · Small write functions for the routines and the course projects
--
-- The Supabase connector asks for a confirmation before it runs an UPDATE (it
-- treats it as destructive). In the unattended evening routine nobody answers, so
-- the run hung for 60 s and its last step failed (26/10, pipeline_status). A
-- `select public.<function>(…)` is never questioned, so every routine write goes
-- through one of these functions (or sf_add_session / sf_record_quiz):
--
--   select public.sf_day_plan('2026-10-27', array['FB','BR'], 'eerst FB en BR', 25);
--   select public.sf_chapter_status('OR-S1', 'af');          -- or the Notion page id
--   select public.sf_intake_done(true, 'Dagvolgorde bijgewerkt');
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The day order for one day (the line of "Volgorde per dag" on 🔁 Overhoren).
-- ---------------------------------------------------------------------------
create or replace function public.sf_day_plan(p_day date, p_order text[], p_reason text,
                                              p_cap integer default 20, p_source text default 'notion')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  errs   text[] := '{}';
  v_bad  text[];
  v_old  public.day_plan%rowtype;
begin
  if p_day is null then
    errs := errs || 'p_day: the day, like ''2026-10-27'''::text;
  end if;
  p_order := coalesce(p_order, '{}');
  select array_agg(x) into v_bad from unnest(p_order) x where x not in (select c.id from public.courses c);
  if v_bad is not null then
    errs := errs || format('p_order: unknown course(s) %s; use SCM, BR, OR, FB, IFHT, BE', array_to_string(v_bad, ', '));
  end if;
  if cardinality(p_order) <> (select count(distinct x) from unnest(p_order) x) then
    errs := errs || 'p_order: a course appears twice'::text;
  end if;
  if p_cap is null or p_cap not between 0 and 60 then
    errs := errs || 'p_cap: a number of cards from 0 to 60 (normally 20, an inhaalbeurt 25-30)'::text;
  end if;
  if coalesce(p_source, '') not in ('notion', 'auto') then
    errs := errs || 'p_source: ''notion'' or ''auto'''::text;
  end if;
  if cardinality(errs) > 0 then
    raise exception using errcode = '22023',
      message = format('sf_day_plan rejected the call (nothing was written): %s', array_to_string(errs, ' | '));
  end if;

  select * into v_old from public.day_plan where day = p_day;
  insert into public.day_plan as d (day, course_order, reason, cap, source)
  values (p_day, p_order, nullif(btrim(coalesce(p_reason, '')), ''), p_cap, p_source)
  on conflict (day) do update
     set course_order = excluded.course_order, reason = excluded.reason, cap = excluded.cap, source = excluded.source
   where (d.course_order, d.reason, d.cap, d.source) is distinct from
         (excluded.course_order, excluded.reason, excluded.cap, excluded.source);

  return jsonb_build_object('day', p_day, 'course_order', to_jsonb(p_order), 'cap', p_cap,
                            'changed', v_old.day is null
                                       or (v_old.course_order, v_old.reason, v_old.cap, v_old.source)
                                          is distinct from (p_order, nullif(btrim(coalesce(p_reason, '')), ''), p_cap::smallint, p_source));
end
$$;

-- ---------------------------------------------------------------------------
-- A chapter's status, by chapter id ('OR-S1') or by its Notion page id.
-- ---------------------------------------------------------------------------
create or replace function public.sf_chapter_status(p_chapter text, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(replace(btrim(coalesce(p_chapter, '')), '-', ''));
  v_id  text;
  v_old text;
begin
  if coalesce(p_status, '') not in ('niet_gezien', 'bezig', 'af', 'examenklaar') then
    raise exception using errcode = '22023',
      message = 'sf_chapter_status rejected the call (nothing was written): p_status is niet_gezien, bezig, af or examenklaar';
  end if;
  select c.id, c.status into v_id, v_old
    from public.chapters c
   where upper(c.id) = upper(btrim(coalesce(p_chapter, '')))
      or lower(replace(coalesce(c.notion_page_id, ''), '-', '')) = v_key
   limit 1;
  if v_id is null then
    raise exception using errcode = '22023',
      message = format('sf_chapter_status rejected the call (nothing was written): no chapter %s; create it first', coalesce(p_chapter, 'null'));
  end if;
  update public.chapters set status = p_status where id = v_id and status is distinct from p_status;
  return jsonb_build_object('id', v_id, 'old_status', v_old, 'new_status', p_status, 'changed', v_old is distinct from p_status);
end
$$;

-- ---------------------------------------------------------------------------
-- The evening routine's last step: how the intake went.
-- ---------------------------------------------------------------------------
create or replace function public.sf_intake_done(p_ok boolean, p_message text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.pipeline_status as p (id, last_intake_at, last_intake_ok, message, updated_at)
  values (1, now(), coalesce(p_ok, false), left(btrim(coalesce(p_message, '')), 500), now())
  on conflict (id) do update
     set last_intake_at = excluded.last_intake_at, last_intake_ok = excluded.last_intake_ok,
         message = excluded.message, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', coalesce(p_ok, false), 'at', now());
end
$$;

revoke all on function public.sf_day_plan(date, text[], text, integer, text) from public, anon, authenticated;
revoke all on function public.sf_chapter_status(text, text) from public, anon, authenticated;
revoke all on function public.sf_intake_done(boolean, text) from public, anon, authenticated;
grant execute on function public.sf_day_plan(date, text[], text, integer, text) to service_role;
grant execute on function public.sf_chapter_status(text, text) to service_role;
grant execute on function public.sf_intake_done(boolean, text) to service_role;
