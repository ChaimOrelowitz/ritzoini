const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });

// ── Referral Sources ─────────────────────────────────────────────

router.get('/referral-sources', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('oo_referral_sources')
    .select('*')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/referral-sources', requireAuth, async (req, res) => {
  const { name, notes_email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase
    .from('oo_referral_sources')
    .insert({ name: name.trim(), notes_email: notes_email?.trim() || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/referral-sources/:id', requireAuth, async (req, res) => {
  const { name, notes_email } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (notes_email !== undefined) updates.notes_email = notes_email?.trim() || null;
  const { data, error } = await supabase
    .from('oo_referral_sources')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/referral-sources/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('oo_referral_sources')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Clients ──────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('oo_clients')
    .select('*, oo_referral_sources(id, name)')
    .order('last_name')
    .order('first_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', requireAuth, async (req, res) => {
  const { first_name, last_name, dob, sex, phone, mobile, email, mrn,
          referral_source_id, program, status } = req.body;
  const { data, error } = await supabase
    .from('oo_clients')
    .insert({
      first_name: first_name?.trim() || null,
      last_name:  last_name?.trim()  || null,
      dob:        dob  || null,
      sex:        sex  || null,
      phone:      phone?.trim()  || null,
      mobile:     mobile?.trim() || null,
      email:      email?.trim()  || null,
      mrn:        mrn?.trim()    || null,
      referral_source_id: referral_source_id || null,
      program:    program?.trim() || null,
      status:     status || 'active',
    })
    .select('*, oo_referral_sources(id, name)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/:id', requireAuth, async (req, res) => {
  const { first_name, last_name, dob, sex, phone, mobile, email, mrn,
          referral_source_id, program, status } = req.body;
  const updates = {};
  if (first_name  !== undefined) updates.first_name  = first_name?.trim()  || null;
  if (last_name   !== undefined) updates.last_name   = last_name?.trim()   || null;
  if (dob         !== undefined) updates.dob         = dob || null;
  if (sex         !== undefined) updates.sex         = sex || null;
  if (phone       !== undefined) updates.phone       = phone?.trim()  || null;
  if (mobile      !== undefined) updates.mobile      = mobile?.trim() || null;
  if (email       !== undefined) updates.email       = email?.trim()  || null;
  if (mrn         !== undefined) updates.mrn         = mrn?.trim()    || null;
  if (referral_source_id !== undefined) updates.referral_source_id = referral_source_id || null;
  if (program     !== undefined) updates.program     = program?.trim() || null;
  if (status      !== undefined) updates.status      = status;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('oo_clients')
    .update(updates)
    .eq('id', req.params.id)
    .select('*, oo_referral_sources(id, name)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('oo_clients')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── InSync Excel Import ──────────────────────────────────────────

router.post('/import/insync', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) return res.status(400).json({ error: 'Empty file' });

  const normalize = (v) => (v || '').toString().trim();

  function parseDob(raw) {
    if (!raw) return null;
    if (raw instanceof Date) return raw.toISOString().split('T')[0];
    const s = raw.toString().trim();
    if (!s) return null;
    // MM/DD/YYYY or MM-DD-YYYY
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const yr = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    }
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().split('T')[0];
  }

  const clients = rows.map(row => ({
    first_name: normalize(row['First Name'])  || null,
    last_name:  normalize(row['Last Name'])   || null,
    dob:        parseDob(row['DOB'])           || null,
    phone:      normalize(row['Phone Number']) || null,
    mobile:     normalize(row['Mobile Number'])|| null,
    program:    normalize(row['Program'])      || null,
    status:     normalize(row['Patient Status']).toLowerCase() === 'inactive' ? 'inactive' : 'active',
  })).filter(c => c.first_name || c.last_name);

  if (!clients.length) return res.status(400).json({ error: 'No valid rows found — check column headers' });

  // Upsert by first+last+dob; if no dob match just insert
  let created = 0, updated = 0, skipped = 0;

  for (const client of clients) {
    // Try to find existing match
    let query = supabase
      .from('oo_clients')
      .select('id')
      .eq('first_name', client.first_name || '')
      .eq('last_name',  client.last_name  || '');
    if (client.dob) query = query.eq('dob', client.dob);

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('oo_clients')
        .update({ ...client, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) { skipped++; } else { updated++; }
    } else {
      const { error } = await supabase
        .from('oo_clients')
        .insert(client);
      if (error) { skipped++; } else { created++; }
    }
  }

  res.json({ ok: true, created, updated, skipped, total: clients.length });
});

// ── Assign Referral Source from Pasted List ──────────────────────

function parseDobStr(s) {
  if (!s) return null;
  s = s.trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return null;
}

function parseReferralPaste(text) {
  const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  let pendingFirst = null;

  for (const line of lines) {
    const dateMatch = line.match(DATE_RE);
    if (dateMatch) {
      const dob = parseDobStr(dateMatch[1]);
      const namePart = line.replace(dateMatch[0], '').trim();
      const words = namePart.split(/\s+/).filter(Boolean);
      let first = null, last = null;
      if (words.length >= 2) {
        first = words[0];
        last = words.slice(1).join(' ');
        pendingFirst = null;
      } else if (words.length === 1) {
        last = words[0];
        first = pendingFirst;
        pendingFirst = null;
      } else {
        pendingFirst = null;
        continue;
      }
      if (first || last) results.push({ first_name: first || '', last_name: last || '', dob });
    } else {
      const words = line.split(/\s+/).filter(Boolean);
      pendingFirst = words.length >= 1 ? line : null;
    }
  }
  return results;
}

router.post('/assign-referral', requireAuth, async (req, res) => {
  const { referral_source_id, paste_text } = req.body;
  if (!referral_source_id) return res.status(400).json({ error: 'referral_source_id required' });
  if (!paste_text)         return res.status(400).json({ error: 'paste_text required' });

  const parsed = parseReferralPaste(paste_text);
  if (!parsed.length) return res.status(400).json({ error: 'No clients found in pasted text' });

  const { data: allClients } = await supabase
    .from('oo_clients')
    .select('id, first_name, last_name, dob');

  const matched = [];
  const unmatched = [];

  for (const p of parsed) {
    const fn = (p.first_name || '').toLowerCase().trim();
    const ln = (p.last_name  || '').toLowerCase().trim();
    const dob = p.dob;

    const hit = allClients.find(c => {
      const cfn = (c.first_name || '').toLowerCase().trim();
      const cln = (c.last_name  || '').toLowerCase().trim();
      const nameMatch = cfn === fn && cln === ln;
      if (!nameMatch) return false;
      if (dob && c.dob) return c.dob === dob;
      return nameMatch;
    });

    if (hit) {
      matched.push({ ...hit, parsed_dob: dob });
    } else {
      unmatched.push(p);
    }
  }

  res.json({ matched, unmatched, parsed, total: parsed.length });
});

router.post('/assign-referral/confirm', requireAuth, async (req, res) => {
  const { referral_source_id, client_ids } = req.body;
  if (!referral_source_id || !client_ids?.length)
    return res.status(400).json({ error: 'referral_source_id and client_ids required' });

  const { error } = await supabase
    .from('oo_clients')
    .update({ referral_source_id, updated_at: new Date().toISOString() })
    .in('id', client_ids);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, updated: client_ids.length });
});

module.exports = router;
