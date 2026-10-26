// StudyFlow Edge Function "media": signed GET URLs for the private bucket "slides".
// Contract: docs/SCHEMA.md ("Storage", "Edge Functions"). Deployed with verify_jwt = false;
// this function checks its own header instead.
//
// Who may call it:
//   * the cloud routine:  header x-routine-token = ROUTINE_TOKEN       -> URLs valid 600 s
//   * the app:            header x-sf-key = the personal key (APP_KEY) -> URLs valid 1 h
//     (its SHA-256 must match a non-revoked row in private.app_keys; checked with the
//     service role through public.sf_token_ok)
//
// Request:  POST {"action": "sign_download", "paths": ["SCM-H3/p006.webp", ...]}  (max 60)
// Response: {"expires_in": 3600, "urls": [{"path", "signed_url", "error"}]}
//
// CORS: https://sathoni.github.io and http://localhost:<any port>, including OPTIONS.
// No dependencies: plain fetch against the Storage and REST APIs.

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const BUCKET = "slides";
const PATH_RE = /^[A-Z]{2,5}-[A-Z0-9]{1,8}\/p\d{3}\.webp$/;
const MAX_PATHS = 60;
const ORIGIN_RE = /^(https:\/\/sathoni\.github\.io|http:\/\/localhost(:\d{1,5})?)$/;

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

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = { Vary: "Origin" };
  if (ORIGIN_RE.test(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] =
      "content-type, x-sf-key, x-routine-token, apikey, authorization, x-client-info";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(req) },
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

// kind 'app' | 'routine'. Only the SHA-256 of the header value reaches the database.
async function tokenOk(kind: "app" | "routine", value: string | null): Promise<boolean> {
  if (!value || value.length < 16 || value.length > 256) return false;
  if (kind === "routine") {
    const secret = Deno.env.get("ROUTINE_TOKEN");
    if (secret && await safeEqual(value, secret)) return true;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sf_token_ok`, {
    method: "POST",
    headers: serverHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ p_kind: kind, p_hash: hex(await sha256(value)) }),
  });
  if (!res.ok) throw new Error(`token check failed (${res.status})`);
  return (await res.json()) === true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return json(req, 405, { error: "use POST" });

  try {
    const routineToken = req.headers.get("x-routine-token");
    const appKey = req.headers.get("x-sf-key");
    let who: "routine" | "app" | null = null;
    if (routineToken) {
      if (await tokenOk("routine", routineToken)) who = "routine";
    } else if (appKey) {
      if (await tokenOk("app", appKey)) who = "app";
    }
    if (!who) return json(req, 401, { error: "unauthorized" });

    let body: { action?: unknown; paths?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "body must be JSON" });
    }
    if (body?.action !== "sign_download") {
      return json(req, 400, { error: 'unknown action (use "sign_download")' });
    }
    const paths = body.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
      return json(req, 400, { error: `paths: an array of 1-${MAX_PATHS} object paths` });
    }
    const bad = paths.filter((p) => typeof p !== "string" || !PATH_RE.test(p));
    if (bad.length) {
      return json(req, 400, { error: "paths must look like SCM-H3/p006.webp", bad: bad.slice(0, 5) });
    }
    const unique = [...new Set(paths as string[])];
    const expiresIn = who === "routine" ? 600 : 3600;

    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
      method: "POST",
      headers: serverHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn, paths: unique }),
    });
    if (!res.ok) {
      return json(req, 502, { error: `storage refused (${res.status})`, detail: (await res.text()).slice(0, 300) });
    }
    const signed = (await res.json()) as Array<{ path: string; signedURL?: string | null; error?: string | null }>;
    const urls = signed.map((s) => ({
      path: s.path,
      signed_url: s.signedURL ? `${SUPABASE_URL}/storage/v1${s.signedURL}` : null,
      error: s.error ?? null,
    }));
    return json(req, 200, { expires_in: expiresIn, urls });
  } catch (err) {
    console.error("media:", err instanceof Error ? err.message : err);
    return json(req, 500, { error: "internal error" });
  }
});
