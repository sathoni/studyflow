// StudyFlow Edge Function "ingest": the PC pipeline's only way to write slide images and
// slide rows. Contract: docs/SCHEMA.md ("Storage", "Edge Functions").
// Deployed with verify_jwt = false; this function checks its own header instead.
//
// Header: x-ingest-token = INGEST_TOKEN (from C:\Users\User\.studyflow\tokens.json).
//
// Actions (POST, JSON body):
//   {"action": "sign_upload", "paths": ["SCM-H3/p006.webp", ...], "content_type": "image/webp"}
//       -> {"urls": [{"path", "signed_url", "token"}]}   (max 100 paths; then PUT the WebP
//          bytes to signed_url with Content-Type image/webp; an existing object is replaced)
//   {"action": "upsert_slides", "rows": [{key, chapter_id, page_idx, printed_no, title, text,
//                                         image_path, w, h}, ...]}
//       -> {"upserted": n}                                (max 500 rows, upsert by key)
//   {"action": "remove", "paths": ["SCM-H3/p999.webp", ...]}
//       -> {"removed": [paths]}                           (max 100; objects only, not rows)
//   {"action": "add_session", "payload": {...}}
//       -> the result of public.sf_add_session(payload)   (bulk card loads from the PC)
//
// No CORS: only the PC calls it. No dependencies: plain fetch against Storage and REST.

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const BUCKET = "slides";
const PATH_RE = /^[A-Z]{2,5}-[A-Z0-9]{1,8}\/p\d{3}\.webp$/;
const KEY_RE = /^[A-Z]{2,5}-[A-Z0-9]{1,8}\/p\d{3}$/;
const MAX_PATHS = 100;
const MAX_ROWS = 500;
const SLIDE_COLUMNS = ["key", "chapter_id", "page_idx", "printed_no", "title", "text", "image_path", "w", "h"];

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (typeof keys.default === "string") return keys.default;
  } catch { /* fall through */ }
  throw new Error("no service key in the function environment");
}

function serverHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = serviceKey();
  const h: Record<string, string> = { apikey: key, ...extra };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`; // legacy JWT key
  return h;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time: both sides are hashed to 32 bytes first, then every byte is compared.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// The INGEST_TOKEN function secret, if one is set, or else its SHA-256 in
// private.function_tokens (checked through public.sf_token_ok with the service role).
async function ingestTokenOk(value: string | null): Promise<boolean> {
  if (!value || value.length < 16 || value.length > 256) return false;
  const secret = Deno.env.get("INGEST_TOKEN");
  if (secret && await safeEqual(value, secret)) return true;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sf_token_ok`, {
    method: "POST",
    headers: serverHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ p_kind: "ingest", p_hash: hex(await sha256(value)) }),
  });
  if (!res.ok) throw new Error(`token check failed (${res.status})`);
  return (await res.json()) === true;
}

function checkPaths(paths: unknown): string[] | Response {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    return json(400, { error: `paths: an array of 1-${MAX_PATHS} object paths` });
  }
  const bad = paths.filter((p) => typeof p !== "string" || !PATH_RE.test(p));
  if (bad.length) return json(400, { error: "paths must look like SCM-H3/p006.webp", bad: bad.slice(0, 5) });
  return [...new Set(paths as string[])];
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function signUpload(body: Record<string, unknown>): Promise<Response> {
  const contentType = body.content_type ?? "image/webp";
  if (contentType !== "image/webp") return json(400, { error: "only image/webp can be uploaded" });
  const paths = checkPaths(body.paths);
  if (paths instanceof Response) return paths;

  const urls: Array<{ path: string; signed_url: string | null; token: string | null; error?: string }> = [];
  for (let i = 0; i < paths.length; i += 10) {
    const batch = await Promise.all(paths.slice(i, i + 10).map(async (path) => {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodePath(path)}`, {
        method: "POST",
        headers: serverHeaders({ "x-upsert": "true" }),
      });
      if (!res.ok) {
        return { path, signed_url: null, token: null, error: `storage refused (${res.status}): ${(await res.text()).slice(0, 200)}` };
      }
      const out = (await res.json()) as { url: string };
      const full = `${SUPABASE_URL}/storage/v1${out.url}`;
      return { path, signed_url: full, token: new URL(full).searchParams.get("token") };
    }));
    urls.push(...batch);
  }
  return json(200, { urls });
}

async function upsertSlides(body: Record<string, unknown>): Promise<Response> {
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) {
    return json(400, { error: `rows: an array of 1-${MAX_ROWS} slide rows` });
  }
  const clean: Record<string, unknown>[] = [];
  for (const [i, r] of rows.entries()) {
    if (typeof r !== "object" || r === null) return json(400, { error: `rows[${i}]: must be an object` });
    const row = r as Record<string, unknown>;
    if (typeof row.key !== "string" || !KEY_RE.test(row.key)) {
      return json(400, { error: `rows[${i}].key: like "SCM-H3/p006"` });
    }
    const out: Record<string, unknown> = {};
    for (const col of SLIDE_COLUMNS) out[col] = row[col] ?? null;
    out.chapter_id ??= (row.key as string).split("/")[0];
    out.image_path ??= `${row.key}.webp`;
    clean.push(out);
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/slides?on_conflict=key`, {
    method: "POST",
    headers: serverHeaders({
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(clean),
  });
  if (!res.ok) {
    return json(400, { error: `the database refused the rows (${res.status})`, detail: (await res.text()).slice(0, 500) });
  }
  return json(200, { upserted: clean.length });
}

async function remove(body: Record<string, unknown>): Promise<Response> {
  const paths = checkPaths(body.paths);
  if (paths instanceof Response) return paths;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: serverHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) {
    return json(502, { error: `storage refused (${res.status})`, detail: (await res.text()).slice(0, 300) });
  }
  const gone = (await res.json()) as Array<{ name: string }>;
  return json(200, { removed: gone.map((o) => o.name) });
}

// Bulk loads from the PC (migration, reloads) go through here, so the card JSON never has
// to pass through a chat. Same contract and checks as calling sf_add_session directly.
async function addSession(body: Record<string, unknown>): Promise<Response> {
  if (typeof body.payload !== "object" || body.payload === null) {
    return json(400, { error: "payload: the sf_add_session object" });
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sf_add_session`, {
    method: "POST",
    headers: serverHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ payload: body.payload }),
  });
  const text = await res.text();
  if (!res.ok) return json(400, { error: `sf_add_session refused (${res.status})`, detail: text.slice(0, 2000) });
  return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "use POST" });
  try {
    if (!(await ingestTokenOk(req.headers.get("x-ingest-token")))) {
      return json(401, { error: "unauthorized" });
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    switch (body?.action) {
      case "sign_upload":
        return await signUpload(body);
      case "upsert_slides":
        return await upsertSlides(body);
      case "remove":
        return await remove(body);
      case "add_session":
        return await addSession(body);
      default:
        return json(400, { error: 'unknown action (use "sign_upload", "upsert_slides", "remove" or "add_session")' });
    }
  } catch (err) {
    console.error("ingest:", err instanceof Error ? err.message : err);
    return json(500, { error: "internal error" });
  }
});
