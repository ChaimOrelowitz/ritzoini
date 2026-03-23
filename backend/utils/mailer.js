const { Resend } = require('resend');
const supabase = require('../db/supabase');

const resend = new Resend(process.env.RESEND_API_KEY);

let emailEnabled = process.env.EMAIL_ENABLED === 'true';

function getEmailEnabled() { return emailEnabled; }
function setEmailEnabled(val) { emailEnabled = !!val; }

const DAY_ABBREVS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-');
  return `${mo}/${d}/${y}`;
}

function buildSubject(internalName, session) {
  const dayAbbrev = session.session_day_of_week != null
    ? DAY_ABBREVS[session.session_day_of_week]
    : '';
  const ecwTime   = (session.ecw_time   || '').slice(0, 5);
  const startTime = (session.start_time || '').slice(0, 5);
  const ecwStr    = fmt12(ecwTime);
  const startParen = (startTime && startTime !== ecwTime) ? ` (${fmt12(startTime)})` : '';
  const dateStr   = fmtDate(session.session_date || session.scheduled_date);
  return `${internalName} ${dayAbbrev} ${ecwStr}${startParen} ${dateStr}`.trim();
}

async function sendSoapNoteEmail(sessionId) {
  if (!emailEnabled) return;
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select(`
        id, session_number, session_date, scheduled_date, session_day_of_week, ecw_time, start_time, soap_note, notes,
        group:groups!group_id(
          internal_name, group_name, name,
          supervisor:profiles!supervisor_id(email)
        )
      `)
      .eq('id', sessionId)
      .single();

    if (!session) return;

    const group = session.group;
    const internalName = group?.internal_name || '';
    const groupName = group?.group_name || group?.name || internalName;
    const soapNote = session.soap_note || session.notes || '';
    const supervisorEmail = group?.supervisor?.email;

    const subject = buildSubject(internalName, session);
    const bodyHtml = soapNote
      ? soapNote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
      : '<em>(no notes)</em>';
    const html = `<p><strong>${groupName}</strong></p><p>${bodyHtml}</p>`;

    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: process.env.TO_EMAIL,
      reply_to: supervisorEmail || process.env.FROM_EMAIL,
      subject,
      html,
    });

    await supabase.from('sessions').update({ email_sent: true }).eq('id', sessionId);

    console.log(`[mailer] Sent SOAP note email for session ${sessionId}`);
  } catch (err) {
    console.error(`[mailer] Failed to send email for session ${sessionId}:`, err.message);
  }
}

module.exports = { sendSoapNoteEmail, getEmailEnabled, setEmailEnabled };
