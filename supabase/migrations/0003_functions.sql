-- StudyFlow 0003_functions: the Leitner fold in SQL, and the token check for the Edge Functions.
-- Data contract: docs/SCHEMA.md ("Leitner fold", "Edge Functions").

-- ---------------------------------------------------------------------------
-- Leitner fold. Mirrors the client fold exactly:
--   box 0 = new, 1-5 = Doos, 6 = Gekend.
--   gekend           : box 0 -> 2, box n -> min(n+1, 6)
--   hint             : box 0 -> 1, box n stays n
--   niet / opnieuw   : -> 1
--   quiz_fout        : box unchanged, due = that day + 1
--   due = day + wait(box), wait for boxes 1..6 = settings.defaults.wait_days
--   (default 1, 3, 7, 14, 28, 60), calendar days.
--   Rows sorted by reviewed_at, then id. undo rows, the rows they cancel and
--   herhaling rows are skipped.
-- State while folding: int[] {box, due as days since 2000-01-01, n_reviews}.
-- ---------------------------------------------------------------------------
create or replace function private.leitner_step(s int[], p_result text, p_day date, p_waits int[])
returns int[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[
           x.nb,
           (p_day - date '2000-01-01')
             + case when p_result = 'quiz_fout' then 1 else p_waits[greatest(x.nb, 1)] end,
           s[3] + 1]
  from (select case p_result
                 when 'gekend'  then case when s[1] = 0 then 2 else least(s[1] + 1, 6) end
                 when 'hint'    then case when s[1] = 0 then 1 else s[1] end
                 when 'niet'    then 1
                 when 'opnieuw' then 1
                 else s[1]                                  -- quiz_fout: box unchanged
               end as nb) x;
$$;
revoke all on function private.leitner_step(int[], text, date, int[]) from public, anon, authenticated;

create aggregate private.leitner_fold(text, date, int[]) (
  sfunc    = private.leitner_step,
  stype    = int[],
  initcond = '{0,NULL,0}'
);
revoke all on function private.leitner_fold(text, date, int[]) from public, anon, authenticated;

-- One row per card (also cards without reviews: box 0, due_day null, n_reviews 0).
-- security definer so it reads the logs directly; guarded like the RLS policies:
-- a client call (role anon through the REST API, POST /rest/v1/rpc/card_states) needs a
-- valid x-sf-key, otherwise the result is empty. The routine calls it as postgres.
create or replace function public.card_states()
returns table (card_id uuid, box int, due_day date, n_reviews int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  w int[];
begin
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

  return query
  with eff as (
    select r.card_id, r.result, r.day, r.reviewed_at, r.id
      from public.reviews r
     where r.result in ('gekend', 'hint', 'niet', 'opnieuw', 'quiz_fout')
       and r.mode <> 'herhaling'
       and not exists (select 1 from public.reviews u
                        where u.result = 'undo' and u.undoes = r.id)
  ), folded as (
    select e.card_id,
           private.leitner_fold(e.result, e.day, w order by e.reviewed_at, e.id) as st
      from eff e
     group by e.card_id
  )
  select c.id,
         coalesce(f.st[1], 0),
         date '2000-01-01' + f.st[2],
         coalesce(f.st[3], 0)
    from public.cards c
    left join folded f on f.card_id = c.id;
end
$$;
revoke all on function public.card_states() from public, anon, authenticated;
grant execute on function public.card_states() to anon, service_role;

-- ---------------------------------------------------------------------------
-- Token check for the Edge Functions (called with the service role, never by a client).
--   p_kind 'app'     -> a non-revoked row in private.app_keys      (media: x-sf-key)
--   p_kind 'ingest'  -> private.function_tokens 'INGEST_TOKEN'      (ingest: x-ingest-token)
--   p_kind 'routine' -> private.function_tokens 'ROUTINE_TOKEN'     (media: x-routine-token)
--   p_hash = lowercase hex SHA-256 of the header value (the raw secret never reaches SQL).
-- ---------------------------------------------------------------------------
create or replace function public.sf_token_ok(p_kind text, p_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then false
    when p_kind = 'app' then exists (
      select 1 from private.app_keys k
       where k.revoked_at is null and k.hash = decode(p_hash, 'hex'))
    when p_kind in ('ingest', 'routine') then exists (
      select 1 from private.function_tokens t
       where t.name = upper(p_kind) || '_TOKEN' and t.hash = decode(p_hash, 'hex'))
    else false
  end;
$$;
revoke all on function public.sf_token_ok(text, text) from public, anon, authenticated;
grant execute on function public.sf_token_ok(text, text) to service_role;
