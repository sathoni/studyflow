-- StudyFlow 0005_advisor_fixes: fixes from the Supabase security advisor after 0001-0004.
--
-- 1. public.rls_auto_enable() is Supabase's "Automatic RLS" event-trigger function. It was
--    executable by anon/authenticated through /rest/v1/rpc. The event trigger keeps working
--    without that privilege (it runs as its owner); clients have no business calling it.
-- 2. The advisor flags the aggregate private.leitner_fold (an aggregate cannot carry its own
--    search_path). The fold now loops in PL/pgSQL over the same SQL step function
--    private.leitner_step (which does pin search_path), so the rules live in one place.

revoke all on function public.rls_auto_enable() from public, anon, authenticated;

create or replace function public.card_states()
returns table (card_id uuid, box int, due_day date, n_reviews int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  w     int[];
  r     record;
  cur   uuid := null;
  st    int[];
  ids   uuid[] := '{}';
  boxes int[]  := '{}';
  dues  int[]  := '{}';
  ns    int[]  := '{}';
begin
  -- Guard, like the RLS policies: a client call (role anon through the REST API) needs a
  -- valid x-sf-key, otherwise the result is empty. Server roles (postgres, service_role) pass.
  if coalesce(nullif(current_setting('role', true), ''), 'none') in ('anon', 'authenticated')
     and not private.key_ok() then
    return;
  end if;

  select array(select jsonb_array_elements_text(s.value -> 'wait_days')::int)
    into w
    from public.settings s
   where s.key = 'defaults' and jsonb_typeof(s.value -> 'wait_days') = 'array';
  if w is null or cardinality(w) <> 6 then
    w := array[1, 3, 7, 14, 28, 60];
  end if;

  -- Fold every card's effective rows in order (reviewed_at, then id).
  for r in
    select rv.card_id as cid, rv.result as res, rv.day as d
      from public.reviews rv
     where rv.result in ('gekend', 'hint', 'niet', 'opnieuw', 'quiz_fout')
       and rv.mode <> 'herhaling'
       and not exists (select 1 from public.reviews u
                        where u.result = 'undo' and u.undoes = rv.id)
     order by rv.card_id, rv.reviewed_at, rv.id
  loop
    if cur is distinct from r.cid then
      if cur is not null then
        ids := ids || cur; boxes := boxes || st[1]; dues := dues || st[2]; ns := ns || st[3];
      end if;
      cur := r.cid;
      st  := array[0, null, 0];
    end if;
    st := private.leitner_step(st, r.res, r.d, w);
  end loop;
  if cur is not null then
    ids := ids || cur; boxes := boxes || st[1]; dues := dues || st[2]; ns := ns || st[3];
  end if;

  -- One row per card; cards without reviews are new (box 0, no due day, 0 reviews).
  return query
  select c.id,
         coalesce(x.b, 0),
         date '2000-01-01' + x.du,
         coalesce(x.n, 0)
    from public.cards c
    left join unnest(ids, boxes, dues, ns) as x(id, b, du, n) on x.id = c.id;
end
$$;
revoke all on function public.card_states() from public, anon, authenticated;
grant execute on function public.card_states() to anon, service_role;

drop aggregate if exists private.leitner_fold(text, date, int[]);
