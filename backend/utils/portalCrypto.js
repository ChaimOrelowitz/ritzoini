// Credential encryption for the Portal POC.
//
// portal_peers holds several peers' real InSync passwords and signing PINs —
// the highest-risk data in this repo. They are encrypted with AES-256-GCM under
// a key that lives in the Render environment (PORTAL_CRED_KEY), NOT in Supabase.
// That split is the point: a leak of the database alone yields ciphertext, and a
// leak of the env alone yields nothing to decrypt.
//
// Rules enforced elsewhere: ciphertext never leaves the backend (the peers API
// returns booleans, not secrets), and plaintext is used to open one InSync
// session and then dropped — it is never logged, never put in an error message,
// and never written to portal_run_events.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  const raw = process.env.PORTAL_CRED_KEY;
  if (!raw) {
    throw new Error(
      'PORTAL_CRED_KEY is not set — peer InSync credentials cannot be stored or read. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('PORTAL_CRED_KEY must be 32 bytes, base64-encoded');
  }
  cachedKey = buf;
  return cachedKey;
}

// Returns "v1.<iv>.<tag>.<ciphertext>", all base64. The version prefix leaves
// room to rotate the scheme without guessing at what a stored blob is.
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored credential is not in the expected v1 format');
  }
  const [, iv, tag, data] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  // A wrong key or tampered row throws here rather than returning garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// True when PORTAL_CRED_KEY is usable — lets the UI say "credentials are not
// configured" instead of every peer save blowing up with a 500.
function isConfigured() {
  try { key(); return true; } catch { return false; }
}

// Belt-and-braces for anything heading to portal_run_events or console: strips
// values that look like the secrets we hold, in case one ever reaches a log line.
function scrub(text, ...secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 3) {
      out = out.split(String(s)).join('«redacted»');
    }
  }
  return out;
}

module.exports = { encrypt, decrypt, isConfigured, scrub };
