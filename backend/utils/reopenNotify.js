const PDFDocument = require('pdfkit');
const { Resend } = require('resend');
const supabase = require('../db/supabase');

const resend = new Resend(process.env.RESEND_API_KEY);

// Render the note's segments (the SAME segmentNote output the Read view uses,
// sent from the client) to a PDF that mirrors the NoteBody component: uppercase
// section labels, section text, dividers, and NoteBody's drop-empty-banner rule.
function renderNotePdf({ segments, header }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const rightEdge = doc.page.width - doc.page.margins.right;

      if (header) {
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#101828').text(header.title || 'Encounter Note');
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(9).fillColor('#475569');
        (header.lines || []).forEach(l => doc.text(l));
        doc.moveDown(0.5);
        doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(doc.page.margins.left, doc.y).lineTo(rightEdge, doc.y).stroke();
        doc.moveDown(0.7);
      }

      for (const seg of (segments || [])) {
        const value = (seg.value || '').trim();
        const hasValue = value.length > 0;
        // Mirror NoteBody: drop empty banner headers except Treatment Plan.
        if (seg.divider && !hasValue && seg.label !== 'Treatment Plan') continue;
        if (!seg.label && !hasValue) continue;

        if (seg.divider) {
          doc.moveDown(0.4);
          doc.strokeColor('#eef1f5').lineWidth(1).moveTo(doc.page.margins.left, doc.y).lineTo(rightEdge, doc.y).stroke();
          doc.moveDown(0.4);
        }
        if (seg.label) {
          doc.font('Helvetica-Bold').fontSize(seg.divider ? 10 : 8.5).fillColor('#1e3a5f')
             .text(String(seg.label).toUpperCase(), { characterSpacing: 0.4 });
          doc.moveDown(0.15);
        }
        if (hasValue) {
          doc.font('Helvetica').fontSize(9.5).fillColor('#334155').text(value, { lineGap: 2 });
        }
        doc.moveDown(0.5);
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

// "YYYY-MM-DD" → "MM/DD/YYYY"
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || '');
}

// "9:00 AM" → "9:00am" (human time, per QA spec)
function fmtTime(t) {
  return (t || '').replace(/\s+/g, '').toLowerCase();
}

function timeRange(note) {
  return [fmtTime(note.startTime), fmtTime(note.endTime)].filter(Boolean).join(' - ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Reopen QA email: PDF of the note + 4-line body. Never throws — returns a
// status the caller attaches to the reopen result; failures are logged and
// recorded but must not roll back the reopen.
async function sendReopenNotification({ note, reason, settings }) {
  const recipient = (settings.ps_qa_email || '').trim();
  const client    = note.client || note.patientName || 'Unknown client';
  const peer      = note.peer || 'unknown';
  const dateStr   = fmtDate(note.visitDate);
  const timeStr   = timeRange(note);
  const sessionDT = [dateStr, timeStr].filter(Boolean).join(' ');
  // Subject: Reopened note: {Peer} {date} {human time of session}
  const subject   = `Reopened note: ${[peer, sessionDT].filter(Boolean).join(' ')}`.trim();

  if (!recipient) {
    return logAndReturn({ recipient: '', eid: note.eid, client, subject, error: 'No QA recipient configured (ps_qa_email)' });
  }

  const from    = (settings.ps_reopen_from || process.env.FROM_EMAIL || '').trim();
  const replyTo = (settings.ps_reopen_reply_to || '').trim() || undefined;
  const cc       = (settings.ps_qa_cc || '').trim() || undefined;

  // Bold headings, blank line between each row (per QA spec).
  const rows = [
    ['Session Date & Time', sessionDT],
    ['Peer', peer],
    ['Client', client],
    ['Reopen reason', reason || ''],
  ];
  const html = rows
    .map(([h, v]) => `<p style="margin:0 0 14px"><strong>${escapeHtml(h)}:</strong> ${escapeHtml(v)}</p>`)
    .join('');
  const text = rows.map(([h, v]) => `${h}: ${v}`).join('\n\n');

  let pdf;
  try {
    pdf = await renderNotePdf({
      segments: note.segments || [],
      header: {
        title: `${client} — Encounter Note`,
        lines: [
          sessionDT,
          note.peer && `Peer: ${note.peer}`,
        ].filter(Boolean),
      },
    });
  } catch (e) {
    return logAndReturn({ recipient, cc, eid: note.eid, client, subject, error: 'PDF render failed: ' + e.message });
  }

  const safe = client.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'note';
  try {
    const result = await resend.emails.send({
      // Resend v6 SDK reads `replyTo` (camelCase); `reply_to` is silently ignored.
      from, to: recipient, cc, replyTo, subject, html, text,
      attachments: [{ filename: `reopened-note-${safe}.pdf`, content: pdf.toString('base64') }],
    });
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    return logAndReturn({ recipient, cc, eid: note.eid, client, subject, messageId: result.data?.id });
  } catch (e) {
    return logAndReturn({ recipient, cc, eid: note.eid, client, subject, error: e.message });
  }
}

async function logAndReturn({ recipient, cc, eid, client, subject, messageId, error }) {
  const ok = !error;
  try {
    await supabase.from('ps_reopen_emails').insert({
      recipient: recipient || null, cc: cc || null, note_eid: eid || null,
      client, subject, status: ok ? 'sent' : 'failed',
      message_id: messageId || null, error: error || null,
    });
  } catch (e) { console.error('[reopen-email] log insert failed:', e.message); }
  if (ok) console.log(`[reopen-email] sent to ${recipient} for eid=${eid} (${client}) msg=${messageId}`);
  else    console.error(`[reopen-email] FAILED to ${recipient || '(none)'} for eid=${eid}: ${error}`);
  return { emailSent: ok, emailError: error || null, recipient: recipient || null };
}

module.exports = { sendReopenNotification, renderNotePdf };
