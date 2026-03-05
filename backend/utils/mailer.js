const nodemailer = require('nodemailer');
const supabase = require('../db/supabase');

let emailEnabled = process.env.EMAIL_ENABLED === 'true';

function getEmailEnabled() { return emailEnabled; }
function setEmailEnabled(val) { emailEnabled = !!val; }

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

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

async function sendSoapNoteEmail(sessionId) {
  if (!emailEnabled) return;
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select(`
        id, session_number, session_date, scheduled_date, ecw_time, start_time, soap_note, notes,
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
    const timeStr = fmt12(session.ecw_time || session.start_time);
    const dateStr = fmtDate(session.session_date || session.scheduled_date);
    const soapNote = session.soap_note || session.notes || '';
    const supervisorEmail = group?.supervisor?.email;

    const subject = `${internalName} ${timeStr} ${dateStr}`.trim();
    const bodyHtml = soapNote
      ? soapNote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
      : '<em>(no notes)</em>';
    const html = `<p><strong>${groupName}</strong></p><p>${bodyHtml}</p>`;

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.TO_EMAIL,
      replyTo: supervisorEmail || process.env.GMAIL_USER,
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
