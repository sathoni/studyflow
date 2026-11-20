-- ===========================================================================
-- 0013 · The catch-up plan (20/11)
--
-- 379 of his 616 live cards had never been shown, with the mock exams in the
-- week of 14/12. settings.defaults gets
--     "catch_up": {"until": "2026-12-13", "new_max": 20}
-- Up to and including that day, an evening list whose day plan names no new_max
-- holds 20 new cards instead of 10 (Sunday 5). A number in the day plan still
-- wins. It ends by itself. The app (queue.ts) also puts exam points (exam_value
-- 3) first within a course. The reminder counts the same way.
-- ===========================================================================

update public.settings
   set value = value || jsonb_build_object('catch_up', jsonb_build_object('until', '2026-12-13', 'new_max', 20)),
       updated_at = now()
 where key = 'defaults';

create or replace function public.sf_reminder_counts(p_day date)
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
               greatest(
                 case when (select yes from sunday) then coalesce(((select v from defaults) ->> 'new_max_sunday')::int, 5)
                      else coalesce(((select v from defaults) ->> 'new_max')::int, 10) end,
                 -- the catch-up plan (0013), as queue.ts planFor() reads it
                 case when jsonb_typeof((select v from defaults) -> 'catch_up') = 'object'
                       and ((select v from defaults) -> 'catch_up' ->> 'until') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                       and jsonb_typeof((select v from defaults) -> 'catch_up' -> 'new_max') = 'number'
                       and p_day <= ((select v from defaults) -> 'catch_up' ->> 'until')::date
                      then ((select v from defaults) -> 'catch_up' ->> 'new_max')::int else 0 end)),
    'new_done_today', (select n from new_today)
  );
$$;
