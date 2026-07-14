const supabase = require('../db/supabase');
const { sendSoapNoteEmail } = require('./mailer');
const { postSoapNoteToZoho } = require('./zohoCrm');

// How a completed session's SOAP note is delivered.
//   'zoho'  → post as a Note in Zoho CRM (default)
//   'email' → send via Resend (legacy behaviour)
//   'both'  → attempt both, independently
// In-memory cache — loaded from Supabase on startup, persisted on change.
const VALID = ['zoho', 'email', 'both'];
let mode = VALID.includes(process.env.SOAP_NOTE_DELIVERY) ? process.env.SOAP_NOTE_DELIVERY : 'zoho';

async function loadDeliveryMode() {
  try {
    const { data } = await supabase
      .from('app_config').select('value').eq('key', 'soap_note_delivery').single();
    if (data && VALID.includes(data.value)) mode = data.value;
  } catch (err) {
    console.warn('[delivery] Could not load soap_note_delivery from DB, using env default:', err.message);
  }
}

function getDeliveryMode() { return mode; }

async function setDeliveryMode(val) {
  if (!VALID.includes(val)) throw new Error(`Invalid delivery mode: ${val}`);
  mode = val;
  try {
    await supabase.from('app_config').upsert({ key: 'soap_note_delivery', value: val });
  } catch (err) {
    console.error('[delivery] Failed to persist soap_note_delivery:', err.message);
  }
}

// Deliver a session's SOAP note per the configured mode. Each channel is
// attempted independently so one failing does not suppress the other.
// Pass { throwErrors: true } (used by the manual send button) to surface a
// failure to the caller instead of only logging it.
async function deliverSoapNote(sessionId, { throwErrors = false } = {}) {
  const run = (label, p) =>
    throwErrors ? p : p.catch(e => console.error(`[delivery:${label}]`, e.message));

  const tasks = [];
  if (mode === 'email' || mode === 'both') tasks.push(run('email', sendSoapNoteEmail(sessionId)));
  if (mode === 'zoho'  || mode === 'both') tasks.push(run('zoho',  postSoapNoteToZoho(sessionId)));
  await Promise.all(tasks);
}

module.exports = { deliverSoapNote, getDeliveryMode, setDeliveryMode, loadDeliveryMode };
