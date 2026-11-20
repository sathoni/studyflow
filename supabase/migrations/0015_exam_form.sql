-- ===========================================================================
-- 0015 · The exam form per course, the mock exam, a free picture (20/11)
--
-- Applied through the Supabase migration history as `exam_scope` and
-- `auto_visual`; this file documents them.
--
-- 1. quiz_attempts.scope also accepts 'examen:<course_id>' (the mock exam the
--    app builds per course: quiz.ts EXAM_FORMS, sampleExam).
-- 2. public.sf_auto_visual(payload): a card of type schema or formule without
--    a picture, whose source.slide is an uploaded slide, gets that whole slide
--    as answer.visual ({slide, crop: null, caption: null}). sf_add_session
--    calls it after the content check, so no model has to look at an image.
--    The same was done once for the existing cards (14: OR 9, IFHT 3, BR 2).
-- 3. Content: 34 mcq items whose right option was clearly the longest got
--    options of about the same length (the share "right option is the longest"
--    is now 24%, which is chance); 2 IFHT cloze stems reworded, 2 got more
--    accepted words, 1 retired. Backup: public._backup_quiz_items_20261120b.
-- ===========================================================================

alter table public.quiz_attempts drop constraint quiz_attempts_scope_format;
alter table public.quiz_attempts add constraint quiz_attempts_scope_format check (
  scope is null or scope ~ '^((sessie|fouten):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|hoofdstuk:[A-Z]{2,5}-[A-Z0-9]{1,8}|(vak|examen):[A-Z]{2,5})$'
);
