# Ritzoini CRM Session (Chrome extension)

Lets Ritzoini pull and approve/reopen peer notes from the CRM
(`portal.linksnetwork.com`). The CRM makes every new device click a one-time
emailed link, so Ritzoini's server can't sign in on its own. This extension sends
the CRM session of a Chrome that is already logged in; Ritzoini checks it against
the CRM and uses it until the CRM ends it.

## Install (each machine you use)
1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this `crm-session-extension` folder.
3. In Ritzoini: **Co-Sign → ⚙ Settings → CRM Connection → Make extension token**, copy it.
4. Click the extension icon → paste the token, name the machine → **Send session now**.
   Green "Connected as …" means Ritzoini can use the session from its server.
5. Stay logged into the CRM in that Chrome.

One token works on every machine. Making a new token in Settings disables the old one.

## When it sends
- When the CRM login cookies change (you just logged in) — after ~10 seconds.
- Every hour while Chrome is running.
- When you press **Send session now**.

Ritzoini keeps using the last good session between sends, so Chrome only needs to be
open often enough to replace it before the CRM expires it. Settings → CRM Connection
shows how long sessions have been lasting.
