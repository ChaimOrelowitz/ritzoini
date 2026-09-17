// Ritzoini CRM Session — hands this browser's CRM login to Ritzoini.
//
// The CRM (portal.linksnetwork.com) makes every new device confirm a one-time
// emailed link by clicking it, so Ritzoini's server can't sign in by itself. This
// browser already is signed in, so the extension sends its CRM cookies to
// Ritzoini, which checks them against the CRM and uses them for pulls, approvals
// and reopens until the CRM ends the session.
//
// Sends: when the CRM cookies change (you just logged in), every hour, and when
// you press "Send now" in the popup. Nothing is sent without a token.

const CRM_URL     = 'https://portal.linksnetwork.com';
const DEFAULT_API = 'https://ritzoini.onrender.com';
const ALARM       = 'ritzoini-crm-session';

function ensureAlarm() {
  chrome.alarms.get(ALARM, a => { if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 60 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); sendSession('browser started'); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) sendSession('hourly'); });

// A login rewrites several cookies at once — wait for it to settle.
let debounce = null;
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (removed || !cookie.domain.replace(/^\./, '').endsWith('portal.linksnetwork.com')) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => sendSession('CRM login changed'), 10000);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'sendNow') { sendSession('sent from popup').then(reply); return true; }
});

async function sendSession(reason) {
  const { token, apiBase, machineName } = await chrome.storage.local.get(['token', 'apiBase', 'machineName']);
  const record = async result => {
    const last = { ...result, reason, at: new Date().toISOString() };
    await chrome.storage.local.set({ last });
    return last;
  };
  if (!token) return record({ ok: false, message: 'No token — paste the one from Ritzoini Co-Sign ⚙ Settings' });

  const list = await chrome.cookies.getAll({ url: CRM_URL });
  if (!list.length) return record({ ok: false, message: 'Not logged into the CRM in this browser' });
  const cookies = Object.fromEntries(list.map(c => [c.name, c.value]));

  const platform = await chrome.runtime.getPlatformInfo().then(p => p.os).catch(() => '');
  const sentFrom = (machineName || '').trim() || `Chrome on ${platform || 'unknown'}`;

  try {
    const res = await fetch(`${(apiBase || DEFAULT_API).replace(/\/+$/, '')}/api/ps/cosign/crm-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-extension-token': token },
      body: JSON.stringify({ cookies, sentFrom }),
    });
    let j = {};
    try { j = await res.json(); } catch {}
    if (res.ok && j.accepted) return record({ ok: true, message: j.message || 'Connected' });
    return record({ ok: false, message: j.message || j.error || `Ritzoini answered HTTP ${res.status}` });
  } catch (err) {
    return record({ ok: false, message: `Could not reach Ritzoini: ${err.message}` });
  }
}
