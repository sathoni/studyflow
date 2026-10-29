-- ===========================================================================
-- 0010 · Two lists a day (his wish, 29/10)
--
--   * reviews.mode gets 'extra': answers given as extra practice (a chapter or
--     course round, "Nog een ronde"). The box rules are the same as for 'sessie'
--     (card_states() only skips 'herhaling'), but the app never counts them for
--     today's lists.
--   * sf_day_plan gets p_new_max: how many new cards the evening list holds in
--     all; today's and yesterday's study is always in, even above it. p_cap stays
--     the cap of the morning list (cards whose day has come).
--       - p_new_max left out or null: keep what the day already has (so a call
--         with four arguments never wipes it); -1: back to the default (10, Sunday 5).
--
--   select public.sf_day_plan('2026-10-30', array['SCM','IFHT'], 'SCM en IFHT · inhaalbeurt', 30, 'notion', 30);
-- ===========================================================================

alter table public.reviews drop constraint reviews_mode_check;
alter table public.reviews add constraint reviews_mode_check
  check (mode in ('sessie', 'herhaling', 'handmatig', 'quiz', 'extra'));

drop function if exists public.sf_day_plan(date, text[], text, integer, text);

create function public.sf_day_plan(p_day date, p_order text[], p_reason text,
                                   p_cap integer default 20, p_source text default 'notion',
                                   p_new_max integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  errs     text[] := '{}';
  v_bad    text[];
  v_old    public.day_plan%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_new    smallint;
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
    errs := errs || 'p_cap: cards whose day has come in the morning list, 0 to 60 (normally 20, Sunday 30)'::text;
  end if;
  if p_new_max is not null and p_new_max <> -1 and p_new_max not between 0 and 60 then
    errs := errs || 'p_new_max: new cards in the evening list, 0 to 60 (an inhaalbeurt 25-30); leave it out to keep, -1 for the default'::text;
  end if;
  if coalesce(p_source, '') not in ('notion', 'auto') then
    errs := errs || 'p_source: ''notion'' or ''auto'''::text;
  end if;
  if cardinality(errs) > 0 then
    raise exception using errcode = '22023',
      message = format('sf_day_plan rejected the call (nothing was written): %s', array_to_string(errs, ' | '));
  end if;

  select * into v_old from public.day_plan where day = p_day;
  v_new := case when p_new_max = -1 then null when p_new_max is null then v_old.new_max else p_new_max end;

  insert into public.day_plan as d (day, course_order, reason, cap, new_max, source)
  values (p_day, p_order, v_reason, p_cap, v_new, p_source)
  on conflict (day) do update
     set course_order = excluded.course_order, reason = excluded.reason, cap = excluded.cap,
         new_max = excluded.new_max, source = excluded.source
   where (d.course_order, d.reason, d.cap, d.new_max, d.source) is distinct from
         (excluded.course_order, excluded.reason, excluded.cap, excluded.new_max, excluded.source);

  return jsonb_build_object('day', p_day, 'course_order', to_jsonb(p_order), 'cap', p_cap, 'new_max', v_new,
                            'changed', v_old.day is null
                                       or (v_old.course_order, v_old.reason, v_old.cap, v_old.new_max, v_old.source)
                                          is distinct from (p_order, v_reason, p_cap::smallint, v_new, p_source));
end
$$;

revoke all on function public.sf_day_plan(date, text[], text, integer, text, integer) from public, anon, authenticated;
grant execute on function public.sf_day_plan(date, text[], text, integer, text, integer) to service_role;
