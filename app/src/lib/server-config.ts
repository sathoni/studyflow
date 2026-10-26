// Where the app talks to its backend (Supabase project "studyflow", ref fshdvzqsyzqvsvodxxwh).
//
// SUPABASE_KEY is the *publishable* key: it is public by design and only makes the request
// run as the role "anon". On its own it can read nothing: every table policy also needs the
// personal key in the header  x-sf-key  (docs/SCHEMA.md "Access rule"). The personal key is
// never in this repo; it arrives through Mathieu's link (?k=...).

export const SUPABASE_URL = "https://fshdvzqsyzqvsvodxxwh.supabase.co";
export const SUPABASE_KEY = "sb_publishable_3nSYt4M6tbmTF23rOggz9g_0xSDcpQp";

// Edge Function that turns slide paths into signed image URLs (sends x-sf-key as well).
export const MEDIA_URL = `${SUPABASE_URL}/functions/v1/media`;
