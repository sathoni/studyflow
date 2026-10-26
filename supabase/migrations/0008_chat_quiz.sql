-- ===========================================================================
-- 0008 · A quiz asked in a course-project chat counts in StudyFlow
--
-- After a lesson or self-study the course project (skill nieuw-hoofdstuk, Mode B)
-- writes the cards with sf_add_session, then quizzes Mathieu in the chat with about
-- five questions of the session quiz it just made (his wish, 26/10). This function
-- stores his answers exactly as the app stores a quiz answer:
--   * one quiz_attempts row per answer, under the session quiz's scope;
--   * one 'quiz_fout' review (mode 'quiz') per card with a wrong answer, so the card
--     comes back tomorrow; its box does not move.
-- Because the session quiz then has attempts, the app's quiz for that session asks
-- other questions about the same cards, the mistakes first (lib/quiz.ts buildRun).
--
--   select public.sf_record_quiz($json$ {"quiz_id": "...", "answers": [...]} $json$::jsonb);
--
-- Ids are derived from the quiz, the round and the item, so calling it again with the
-- same payload writes nothing new.
-- ===========================================================================

create or replace function public.sf_record_quiz(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ns       constant uuid := '45fe8f0a-9907-55ee-a2c0-9bdad8508de5';
  uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  errs     text[] := '{}';
  v_quiz   uuid;
  v_cards  uuid[];
  v_round  int := 1;
  v_run    uuid;
  v_scope  text;
  v_answers jsonb;
  v_day    date := ((now() at time zone 'Europe/Brussels') - interval '4 hours')::date;
  v_now    timestamptz := now();
  e        record;
  a        jsonb;
  p        text;
  v_item   uuid;
  v_card   uuid;
  v_status text;
  seen     uuid[] := '{}';
  n_right  int := 0;
  n_new    int := 0;
  n_rows   int;
  back     uuid[] := '{}';
begin
  -- ---- 1. Validate -------------------------------------------------------
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023',
      message = 'sf_record_quiz rejected the payload: it must be a JSON object';
  end if;

  if coalesce(payload ->> 'quiz_id', '') !~ uuid_re then
    errs := errs || 'quiz_id: the quiz_id that sf_add_session returned'::text;
  else
    v_quiz := (payload ->> 'quiz_id')::uuid;
    select s.card_ids into v_cards
      from public.quizzes q join public.study_sessions s on s.id = q.session_id
     where q.id = v_quiz and q.kind = 'sessie';
    if not found then
      errs := errs || 'quiz_id: no session quiz with this id'::text;
    end if;
  end if;

  if payload ? 'round' then
    if jsonb_typeof(payload -> 'round') <> 'number' or (payload ->> 'round') !~ '^[0-9]{1,2}$' then
      errs := errs || 'round: a whole number from 1 to 20 (leave it out for the first chat quiz)'::text;
    elsif (payload ->> 'round')::int not between 1 and 20 then
      errs := errs || 'round: a whole number from 1 to 20 (leave it out for the first chat quiz)'::text;
    else
      v_round := (payload ->> 'round')::int;
    end if;
  end if;

  v_answers := payload -> 'answers';
  if v_answers is null or jsonb_typeof(v_answers) <> 'array' or jsonb_array_length(v_answers) not between 1 and 20 then
    errs := errs || 'answers: an array of 1 to 20 answers'::text;
    v_answers := '[]'::jsonb;
  end if;

  for e in select value as a, ordinality - 1 as i from jsonb_array_elements(v_answers) with ordinality loop
    a := e.a;
    p := format('answers[%s]', e.i);
    if jsonb_typeof(a) <> 'object' then
      errs := errs || (p || ': an object {item_id, correct, answer, hint_used}');
      continue;
    end if;
    if coalesce(a ->> 'item_id', '') !~ uuid_re then
      errs := errs || (p || '.item_id: the id of the quiz item you asked');
    else
      v_item := (a ->> 'item_id')::uuid;
      if v_item = any(seen) then
        errs := errs || (p || '.item_id: this item is already in the list');
      end if;
      seen := seen || v_item;
      select qi.card_id, qi.status into v_card, v_status from public.quiz_items qi where qi.id = v_item;
      if not found then
        errs := errs || (p || '.item_id: no quiz item with this id');
      elsif v_status <> 'live' then
        errs := errs || (p || '.item_id: this quiz item is not live');
      elsif v_cards is not null and not (v_card = any(v_cards)) then
        errs := errs || (p || '.item_id: this item is about a card of another session');
      end if;
    end if;
    if jsonb_typeof(a -> 'correct') is distinct from 'boolean' then
      errs := errs || (p || '.correct: true or false');
    end if;
    if a ? 'answer' and jsonb_typeof(a -> 'answer') not in ('string', 'null') then
      errs := errs || (p || '.answer: his answer as text');
    elsif length(coalesce(a ->> 'answer', '')) > 500 then
      errs := errs || (p || '.answer: at most 500 characters');
    end if;
    if a ? 'hint_used' and jsonb_typeof(a -> 'hint_used') <> 'boolean' then
      errs := errs || (p || '.hint_used: true or false');
    end if;
  end loop;

  if cardinality(errs) > 0 then
    raise exception using errcode = '22023',
      message = format('sf_record_quiz rejected the payload (%s problem(s), nothing was written): %s',
                       cardinality(errs), array_to_string(errs[1:30], ' | '));
  end if;

  -- ---- 2. Write ------------------------------------------------------------
  v_run   := extensions.uuid_generate_v5(ns, 'chat:' || v_quiz || ':' || v_round);
  v_scope := 'sessie:' || v_quiz;

  for e in select value as a, ordinality as n from jsonb_array_elements(v_answers) with ordinality loop
    a := e.a;
    v_item := (a ->> 'item_id')::uuid;
    select qi.card_id into v_card from public.quiz_items qi where qi.id = v_item;

    insert into public.quiz_attempts (id, run_id, item_id, card_id, scope, correct, answer, hint_used, answered_at, day)
    values (extensions.uuid_generate_v5(ns, 'chat-attempt:' || v_run || ':' || v_item),
            v_run, v_item, v_card, v_scope, (a ->> 'correct')::boolean,
            jsonb_build_object('text', nullif(btrim(coalesce(a ->> 'answer', '')), ''), 'via', 'chat'),
            coalesce((a ->> 'hint_used')::boolean, false),
            v_now + make_interval(secs => e.n), v_day)
    on conflict (id) do nothing;
    get diagnostics n_rows = row_count;
    n_new := n_new + n_rows;

    if (a ->> 'correct')::boolean then
      n_right := n_right + 1;
    elsif not (v_card = any(back)) then
      back := back || v_card;
      insert into public.reviews (id, card_id, reviewed_at, day, result, hints_used, mode)
      values (extensions.uuid_generate_v5(ns, 'chat-fout:' || v_run || ':' || v_card),
              v_card, v_now + make_interval(secs => e.n), v_day, 'quiz_fout', 0, 'quiz')
      on conflict (id) do nothing;
    end if;
  end loop;

  return jsonb_build_object(
    'run_id',        v_run,
    'scope',         v_scope,
    'answered',      jsonb_array_length(v_answers),
    'correct',       n_right,
    'back_tomorrow', to_jsonb(back),
    'new_rows',      n_new);
end
$$;
revoke all on function public.sf_record_quiz(jsonb) from public, anon, authenticated;
grant execute on function public.sf_record_quiz(jsonb) to service_role;
