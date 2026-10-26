-- StudyFlow 0004_seed: the six courses, the settings defaults and the pipeline_status row.
-- Colours and icons: SPEC-v3 section 2. Course names: his OneDrive course folders.
-- Re-running is safe (upserts). Later changes are made by Claude/the routine as postgres.

insert into public.courses (id, name, color, icon, sort) values
  ('SCM',  'Supply Chain Management',                         '#2F6FEB', 'truck',      1),
  ('BR',   'Burgerlijk recht',                                '#D93F3F', 'scales',     2),
  ('OR',   'Ondernemingsrecht',                               '#8250DF', 'building',   3),
  ('FB',   'Financieel beheer van een bedrijf',               '#1F9D55', 'calculator', 4),
  ('IFHT', 'Internationale financiële- en handelstechnieken', '#E8730C', 'globe',      5),
  ('BE',   'Business English 1',                              '#0F9AA8', 'speech',     6)
on conflict (id) do update
  set name  = excluded.name,
      color = excluded.color,
      icon  = excluded.icon,
      sort  = excluded.sort;

-- settings.value shapes are documented in docs/SCHEMA.md ("settings values").
insert into public.settings (key, value) values
  ('goals', '[
     {"id": "daily_queue",  "label": "Vandaag je kaartjes afwerken", "target": 1,   "unit": "share"},
     {"id": "accuracy",     "label": "Gemiddeld 80% juist",          "target": 0.8, "unit": "share"},
     {"id": "quizzes_week", "label": "3 quizzen deze week",          "target": 3,   "unit": "count"}
   ]'::jsonb),
  ('defaults', '{
     "cap": 20,
     "cap_sunday": 30,
     "new_max": 10,
     "new_max_sunday": 5,
     "wait_days": [1, 3, 7, 14, 28, 60],
     "est_sec_review": 15,
     "est_sec_new": 30,
     "reminder_at": "21:00"
   }'::jsonb),
  ('profile', '{"name": "Mathieu", "subtitle": "Student"}'::jsonb)
on conflict (key) do update set value = excluded.value;

insert into public.pipeline_status (id, last_intake_at, last_intake_ok, message)
values (1, null, null, 'Nog geen intake gedraaid')
on conflict (id) do nothing;
