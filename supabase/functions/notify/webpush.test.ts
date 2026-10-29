/**
 * The encryption checked against the standard's own worked example.
 *
 * RFC 8291 prints every input and the exact bytes that must come out
 * (Appendix A). If this matches, the phone can read what the server sends;
 * there is no "close enough" in cryptography.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, b64urlDecode, b64urlEncode, generateVapid, vapidHeader } from './webpush.ts';

const rfc = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml ' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8',
  ciphertext:
    '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs ' + 'bI_0LpXMuGvnzQ',
};

async function rfcServerKeys(): Promise<CryptoKeyPair> {
  const raw = b64urlDecode(rfc.asPublic);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: rfc.asPrivate,
    x: b64urlEncode(raw.slice(1, 33)),
    y: b64urlEncode(raw.slice(33, 65)),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  return { privateKey, publicKey };
}

test('base64url survives a round trip, with and without padding lengths', () => {
  for (const length of [0, 1, 2, 3, 16, 65, 86]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
  }
});

test('encryption reproduces RFC 8291 Appendix A exactly, byte for byte', async () => {
  const body = await encrypt(
    new TextEncoder().encode(rfc.plaintext),
    b64urlDecode(rfc.uaPublic),
    b64urlDecode(rfc.auth),
    { salt: b64urlDecode(rfc.salt), serverKeys: await rfcServerKeys() },
  );
  const header = b64urlDecode(rfc.header);
  const ciphertext = b64urlDecode(rfc.ciphertext);

  assert.equal(header.length, 86, 'the RFC header is 86 bytes');
  assert.deepEqual(body.slice(0, 86), header, 'header: salt, record size 4096, server key');
  assert.deepEqual(body.slice(86), ciphertext, 'ciphertext and authentication tag');
});

test('a fresh message uses a new salt and a new server key every time', async () => {
  const phone = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', phone.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const message = new TextEncoder().encode('{"title":"hello"}');

  const a = await encrypt(message, uaPublic, auth);
  const b = await encrypt(message, uaPublic, auth);
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16), 'salt differs');
  assert.notDeepEqual(a.slice(21, 86), b.slice(21, 86), 'server key differs');
  // header (86) + message + delimiter (1) + GCM tag (16)
  assert.equal(a.length, 86 + message.length + 1 + 16);
});

test('the VAPID signature verifies with the public key the app will hold', async () => {
  const { publicKey, privateJwk } = await generateVapid();
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  const header = await vapidHeader(
    'https://web.push.apple.com/QGuQyavXutnMH-anything',
    { publicKey, privateJwk, subject: 'https://sathoni.github.io/phase0-check/' },
    now,
  );

  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, 'shape: vapid t=<jwt>, k=<key>');
  const [, head, claims, signature, key] = match!;
  assert.equal(key, publicKey);

  const decoded = JSON.parse(new TextDecoder().decode(b64urlDecode(claims)));
  assert.equal(decoded.aud, 'https://web.push.apple.com', 'audience is the push service origin');
  assert.equal(decoded.exp, Math.floor(now / 1000) + 12 * 3600);
  assert.equal(decoded.sub, 'https://sathoni.github.io/phase0-check/');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(head))), {
    typ: 'JWT',
    alg: 'ES256',
  });

  const verifier = await crypto.subtle.importKey(
    'raw',
    b64urlDecode(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const sig = b64urlDecode(signature);
  assert.equal(sig.length, 64, 'raw r||s, as JWT requires, not DER');
  assert.ok(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      sig,
      new TextEncoder().encode(`${head}.${claims}`),
    ),
  );
});
