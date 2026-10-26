-- StudyFlow 0002_storage: the private bucket "slides" for full page renders.
-- Data contract: docs/SCHEMA.md ("Storage").
--
-- * Private bucket, WebP only, at most 4 MB per object (a 2000 px page at quality ~72 is
--   normally 100-600 kB).
-- * NO client policies on storage.objects: anon and authenticated can neither list, read
--   nor write anything in it.
-- * Uploads only through signed upload URLs from the Edge Function "ingest" (PC token).
-- * Reads only through signed GET URLs from the Edge Function "media" (x-sf-key or routine token).
-- * Object paths: CHAPTER/pNNN.webp, e.g. SCM-H3/p006.webp, FB-BOEK/p036.webp.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slides', 'slides', false, 4194304, array['image/webp'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
