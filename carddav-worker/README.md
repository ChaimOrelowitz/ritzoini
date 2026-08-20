# CardDAV bridge Worker

Render's edge answers **405 to `PROPFIND` and `REPORT` before the application
sees them**. This was measured, not inferred: a temporary middleware counted the
HTTP method of every inbound request as the first thing in the Express stack,
and three DAV requests (authenticated and not) never incremented it while a
control `GET` did. A `server: cloudflare` header on the 405 was suggestive; the
counter was proof.

Cloudflare Workers *do* receive those methods — also measured, with a throwaway
Worker on a temporary preview account that echoed `PROPFIND` and `REPORT` back
and logged both.

So this Worker fronts the CardDAV hostname and relays the blocked methods to
Ritzoini as an ordinary signed `POST`.

```
iPhone Contacts
      │  PROPFIND / REPORT / OPTIONS          │  GET / HEAD
      ▼                                       ▼
┌─────────────────────────────────────────────────────────┐
│ Worker  ritzoini-contacts.<subdomain>.workers.dev       │
│  · read-only method allowlist                           │
│  · HMAC-SHA256 envelope  · passthrough for GET/HEAD     │
└─────────────────────────────────────────────────────────┘
      │  POST /internal/dav-bridge            │  GET /carddav/…
      ▼                                       ▼
┌─────────────────────────────────────────────────────────┐
│ Render  ritzoini.onrender.com                           │
│  verify signature → handleDav() → Basic auth → Supabase │
└─────────────────────────────────────────────────────────┘
```

The Worker is a **transport, never an authorisation**. The client's
`Authorization` header is passed through for Ritzoini's own Basic-auth check; a
perfectly signed envelope with no CardDAV credentials still gets a `401`. Two
independent secrets stand between the internet and a contact.

## What the envelope binds

`src/envelope.js` and `backend/utils/davEnvelope.js` are byte-identical
implementations of the same canonical form. The HMAC covers:

| Field | Why |
|---|---|
| method | a REPORT must not become a PROPFIND |
| exact path + query | one book's URL must not become another's |
| timestamp | ±300s freshness window |
| nonce | single-use; replays are refused |
| SHA-256 of the raw body | the XML request cannot be swapped |
| DAV headers (`depth`, `content-type`, `if-none-match`, `if-match`, `brief`, `prefer`) | `Depth: 0` must not become `Depth: 1` |
| SHA-256 of `Authorization` | a captured envelope cannot be reused with different credentials |

The credential itself is never signed in the clear, never logged, and never
stored — only its digest travels inside the envelope.

If the two implementations ever drift, every request fails signature
verification. That is the intended failure mode: loud and immediate, rather than
a silent divergence. `test/envelope.test.js` compares them directly.

## Deploy

```bash
cd carddav-worker
cp wrangler.toml.example wrangler.toml     # no secrets in this file
npx wrangler login                          # a free Cloudflare account is enough
npx wrangler secret put DAV_BRIDGE_SECRET   # same value as Render's
npx wrangler deploy
```

`workers_dev = true` publishes `https://ritzoini-contacts.<your-subdomain>.workers.dev`.
No zone, no DNS record, nothing about `corsolutions.io` changes.

Set the identical `DAV_BRIDGE_SECRET` in Render → the backend service →
Environment. Generate both with `node ../backend/scripts/make-contact-credentials.js`.

## Tests

```bash
npm test    # envelope parity + full end-to-end chain
```

`test/integration.test.js` runs the real Worker source against a real backend in
one process — the Worker uses only Web Crypto, `fetch`, `Request` and
`Response`, all of which Node provides — so the whole chain is exercised without
deploying anything.

## Limitations

- **The Worker sees the CardDAV password.** It terminates TLS and must pass the
  header through. Unavoidable for any proxy.
- **Replay protection is per-instance.** The nonce cache lives in memory on
  Render, which holds while it runs as a single web service. Scaling out would
  give each instance its own view and reopen the window; Cloudflare KV is the
  fix if that ever changes.
- **Origin-side rate limiting sees one client.** Every request arrives from
  Cloudflare, so `req.ip` is the Worker, not the phone. In practice there is one
  legitimate client.
- Free Workers plan: 100k requests/day and 10ms CPU — an HMAC over a small XML
  body is nowhere near either.
