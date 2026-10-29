/**
 * Web Push, written out by hand.
 *
 * Two standards do all the work:
 *
 *   RFC 8291  encrypts the message, so only the phone it is addressed to can
 *             read it. Apple carries it without being able to open it.
 *   RFC 8292  (VAPID) signs the request, so Apple knows it comes from us and
 *             not from someone who happened to learn a phone's address.
 *
 * Both use only the standard Web Crypto that Deno (on the server) and Node (in
 * the tests) share, so this one file runs in both places — and the tests check
 * it byte for byte against the worked example printed in RFC 8291 itself.
 * No library: one less thing to trust, and nothing to download from anywhere.
 */

const text = new TextEncoder();

/* ------------------------------------------------------------------ *
 * Bytes and base64url
 * ------------------------------------------------------------------ */

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean + '==='.slice((clean.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Exactly these bytes, as a plain ArrayBuffer.
 *
 * What Web Crypto and fetch want. A Uint8Array can be a window onto a larger or
 * shared buffer, and newer type checkers insist on the difference; copying the
 * bytes out settles it at no real cost for messages this small.
 */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    buf(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, buf(data)));
}

/* ------------------------------------------------------------------ *
 * RFC 8291: encrypting the message
 * ------------------------------------------------------------------ */

export interface EncryptOptions {
  /** Only the tests set these. In real use both are fresh every time. */
  salt?: Uint8Array;
  serverKeys?: CryptoKeyPair;
}

/**
 * Encrypt a message for one phone.
 *
 * `uaPublic` and `authSecret` are the two values the phone handed over when it
 * subscribed (its "p256dh" and "auth"). The result is the whole request body:
 * an 86-byte header followed by the ciphertext, as a single record.
 */
export async function encrypt(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const serverKeys =
    options.serverKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw',
    buf(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256),
  );

  // HKDF, spelled out as HMACs: every expansion here is 32 bytes or shorter,
  // so each one is a single HMAC over (info || 0x01).
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(text.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(prk, concat(text.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))
  ).slice(0, 16);
  const nonce = (
    await hmac(prk, concat(text.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))
  ).slice(0, 12);

  // One record, marked as the last one with the 0x02 delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aesKey, buf(record)),
  );

  // salt (16) || record size (4, big-endian) || key length (1) || server key (65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
}

/* ------------------------------------------------------------------ *
 * RFC 8292: signing the request
 * ------------------------------------------------------------------ */

export interface Vapid {
  /** The public key, 65 raw bytes in base64url. The app holds the same value. */
  publicKey: string;
  /** The private key. It is made on the server and never leaves it. */
  privateJwk: JsonWebKey;
  /** Who to contact about these messages: an https or mailto address. */
  subject: string;
}

/** A fresh signing key pair. Called once, ever, by the setup action. */
export async function generateVapid(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    publicKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

/**
 * The Authorization header for one push service.
 *
 * A short-lived signed token naming the push service it is meant for, so it is
 * useless anywhere else. Twelve hours is well inside the 24 the standard allows.
 */
export async function vapidHeader(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const header = b64urlEncode(text.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    text.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    'jwk',
    vapid.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // Web Crypto signs in the raw r||s form, which is exactly what a JWT wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(text.encode(`${header}.${claims}`))),
  );
  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  status: number;
  ok: boolean;
  /** The phone has gone: uninstalled, or notifications switched off. Forget it. */
  gone: boolean;
  detail?: string;
}

export async function sendPush(
  subscription: Subscription,
  payload: unknown,
  vapid: Vapid,
  options: { ttlSeconds?: number; urgency?: 'normal' | 'high' } = {},
): Promise<SendResult> {
  const body = await encrypt(
    text.encode(JSON.stringify(payload)),
    b64urlDecode(subscription.p256dh),
    b64urlDecode(subscription.auth),
  );
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      // How long Apple may hold it if the phone is off. A bedtime reminder
      // arriving the next afternoon would be worse than none.
      TTL: String(options.ttlSeconds ?? 6 * 3600),
      Urgency: options.urgency ?? 'normal',
    },
    body: buf(body),
  });
  const detail = response.ok ? undefined : (await response.text()).slice(0, 300);
  return {
    status: response.status,
    ok: response.ok,
    gone: response.status === 404 || response.status === 410,
    detail,
  };
}
