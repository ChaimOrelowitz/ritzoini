const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

// GET /api/email/oauth-init — visit this once in browser to authorize
router.get('/oauth-init', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  });
  res.redirect(url);
});

// GET /api/email/oauth-callback — Google redirects here after authorization
router.get('/oauth-callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Store refresh token in DB so it survives server restarts
    await supabase.from('app_config').upsert({ key: 'gmail_refresh_token', value: tokens.refresh_token });

    res.send('✅ Gmail authorized successfully. You can close this tab.');
  } catch (err) {
    console.error('[email oauth-callback]', err.message);
    res.status(500).send('Authorization failed: ' + err.message);
  }
});

// Returns an authenticated Gmail client using stored refresh token
async function getGmailClient() {
  const { data } = await supabase.from('app_config').select('value').eq('key', 'gmail_refresh_token').single();
  if (!data?.value) throw new Error('Gmail not authorized. Visit /api/email/oauth-init first.');

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: data.value });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Parse session info from email subject — subject format:
// "{internal_name} DAY HH:MM AM/PM (HH:MM AM/PM) MM/DD/YYYY"
// Reply subjects are prefixed with "Re: "
function extractSubjectInfo(subject) {
  const clean = subject.replace(/^(re:\s*)+/i, '').trim();
  // Extract date MM/DD/YYYY from end of subject
  const dateMatch = clean.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!dateMatch) return null;
  const [, m, d, y] = dateMatch;
  const sessionDate = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  // Everything before the date (minus trailing day/time tokens) is the internal name
  const beforeDate = clean.slice(0, dateMatch.index).trim();
  return { sessionDate, subjectPrefix: beforeDate };
}

// POST /api/email/check-replies — called by cron to check for Fern's replies
router.post('/check-replies', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const gmail = await getGmailClient();

    // Search for unread emails containing Fern's signature phrase
    const { data: list } = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread "ready for you to review and lock"',
      maxResults: 20,
    });

    const messages = list.messages || [];
    let processed = 0, skipped = 0;

    for (const msg of messages) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject'],
      });

      const subjectHeader = full.payload?.headers?.find(h => h.name === 'Subject');
      const subject = subjectHeader?.value || '';

      const info = extractSubjectInfo(subject);
      if (!info) { skipped++; continue; }

      // Find the session by date and internal name prefix match
      const { data: sessions } = await supabase
        .from('sessions')
        .select('id, ready_to_lock, group:groups!group_id(internal_name)')
        .eq('session_date', info.sessionDate)
        .eq('status', 'completed');

      const match = (sessions || []).find(s => {
        const internal = s.group?.internal_name || '';
        return info.subjectPrefix.toLowerCase().startsWith(internal.toLowerCase().slice(0, 20));
      });

      if (!match) { skipped++; continue; }
      if (match.ready_to_lock) { skipped++; continue; }

      await supabase.from('sessions').update({ ready_to_lock: true }).eq('id', match.id);
      processed++;
      console.log(`[email] Marked ready_to_lock for session ${match.id}`);
    }

    console.log(`[email] check-replies: processed=${processed} skipped=${skipped}`);
    res.json({ processed, skipped });
  } catch (err) {
    console.error('[email] check-replies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.getGmailClient = getGmailClient;
