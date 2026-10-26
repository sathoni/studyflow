-- Some overhoor-instrumenten belong to a whole course (Formularium, Begrippenlijst), not to one chapter.
alter table public.instruments alter column chapter_id drop not null;
