// Byte-identical counterpart to backend/utils/davEnvelope.js.
//
// If these two drift, every request fails signature verification — a loud,
// immediate failure rather than a silent security hole. That is deliberate:
// keep the canonical form dumb and easy to eyeball on both sides.
//
// Web Crypto here, node:crypto there; the bytes must come out the same.

export const VERSION = 'v1';

export const SIGNED_DAV_HEADERS = ['depth', 'content-type', 'if-none-match', 'if-match', 'brief', 'prefer'];

export const MAX_BODY_BYTES = 256 * 1024;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

// Must match backend/utils/davEnvelope.js canonicalString() exactly.
export function canonicalString({ method, path, query, timestamp, nonce, bodyHash, authHash, davHeaders }) {
  const pairs = Object.entries(davHeaders || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [String(k).toLowerCase(), String(v)])
    .filter(([k]) => SIGNED_DAV_HEADERS.includes(k))
    .sort((a, b) => a[0].localeCompare(b[0]));

  return JSON.stringify([
    VERSION,
    String(method).toUpperCase(),
    String(path),
    String(query || ''),
    String(timestamp),
    String(nonce),
    String(bodyHash),
    String(authHash),
    JSON.stringify(pairs),
  ]);
}

export async function sign(canonical, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
}

export function pickDavHeaders(headers) {
  const out = {};
  for (const name of SIGNED_DAV_HEADERS) {
    const v = headers.get(name);
    if (v !== null && v !== undefined && v !== '') out[name] = String(v);
  }
  return out;
}

export function newNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(24)));
}
