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
      return cfn === fn && cln === ln;
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

// ── InSync Live Sync ─────────────────────────────────────────────

const INSYNC_BASE   = 'https://thedscenter.insynchcs.com';
const INSYNC_URL    = `${INSYNC_BASE}/PatientSearch/BindPatientList`;
const INSYNC_UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

async function inSyncLogin(username, password) {
  const cookieJar = new Map();

  function addCookies(response) {
    for (const raw of (response.headers.getSetCookie?.() || [])) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  function cookieStr() {
    return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // Step 1: GET /account — collect initial cookies
  const step1 = await fetch(`${INSYNC_BASE}/account`, {
    headers: { 'User-Agent': INSYNC_UA, 'Accept': 'text/html,*/*' },
    redirect: 'manual',
  });
  addCookies(step1);

  // Step 2: POST / then follow all redirects manually, collecting cookies at each hop
  const loginBody = new URLSearchParams({
    UserName: username,
    Password: password,
    PageID: 'PatientSearch',
    hdnPageListVal: 'PatientSearch',
    IsAzureAd: 'False',
    IsAutoLoginWithCookie: 'False',
    GeoLocation: '',
    GeoErrorCode: '',
    GeoErrorMessage: '',
  });

  let url    = `${INSYNC_BASE}/`;
  let method = 'POST';
  let body   = loginBody.toString();

  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': INSYNC_UA,
        'Content-Type': method === 'POST' ? 'application/x-www-form-urlencoded' : undefined,
        'Origin': INSYNC_BASE,
        'Referer': `${INSYNC_BASE}/account`,
        'Cookie': cookieStr(),
        'Accept': 'text/html,*/*',
      },
      body: method === 'POST' ? body : undefined,
      redirect: 'manual',
    });

    addCookies(res);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      url    = loc.startsWith('http') ? loc : `${INSYNC_BASE}${loc}`;
      method = 'GET';
      body   = undefined;
    } else {
      const text = await res.text();
      if (text.includes('SIGN IN') && text.includes('Password')) {
        throw new Error('InSync login failed — check username/password in ⚙ settings');
      }
      break;
    }
  }

  if (!cookieJar.size) throw new Error('InSync login returned no cookies — login may have failed');
  return cookieStr();
}

const INSYNC_BODY = {
  draw: 1,
  columns: [
    { data: 'PatientId',          name: 'PatientId',          searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'BlankData',          name: 'Icons',              searchable: true, orderable: false, visible: true,  search: { value: '', regex: false } },
    { data: 'LastName',           name: 'LastName',           searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'FirstName',          name: 'FirstName',          searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'MRNNumber',          name: 'MRNNumber',          searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'DOB',                name: 'DOB',                searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'Gender',             name: 'Gender',             searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'PrimaryProviderName',name: 'PrimaryProvider',    searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'Address',            name: 'Address',            searchable: true, orderable: true,  visible: true,  search: { value: '', regex: false } },
    { data: 'MobileNo',           name: 'MobileNo',           searchable: true, orderable: true,  visible: false, search: { value: '', regex: false } },
    { data: 'PatientEmail',       name: 'PatientEmail',       searchable: true, orderable: true,  visible: false, search: { value: '', regex: false } },
    { data: 'BlankData',          name: 'Notes',              searchable: true, orderable: false, visible: true,  search: { value: '', regex: false } },
  ],
  order: [{ column: 0, dir: 'desc' }],
  start: 0,
  length: 500,
  search: { value: '', regex: false },
  SearchText: '',
  PatientDetails: JSON.stringify({
    IsAllowToSearchPatientOutsideOfBedBoard: 'True',
    IsAdvanceSearch: true,
    ServiceProvider: 0,
    PayerPlanId: 0,
    PatientStatus: '9,53,54',
    PrimaryProvider: '2317',
    PrimaryFacility: '199',
    IsSearchedWithSavedQuery: true,
    OrderingProviderID: 0,
    FamilyMemberID: 0,
    FamilyMemberName: '',
  }),
  PageName: '',
  IsIncludeInActive: false,
};

function parseDobMDY(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}

router.post('/sync-insync', requireAuth, async (req, res) => {
  // Load credentials from app_settings
  const [{ data: userSetting }, { data: passSetting }] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', 'insync_username').maybeSingle(),
    supabase.from('app_settings').select('value').eq('key', 'insync_password').maybeSingle(),
  ]);

  const username = userSetting?.value || process.env.INSYNC_USERNAME;
  const password = passSetting?.value || process.env.INSYNC_PASSWORD;
  if (!username || !password) return res.status(400).json({ error: 'InSync credentials not configured. Click ⚙ to set them.' });

  let cookie;
  try {
    cookie = await inSyncLogin(username, password);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  let insyncData;
  try {
    const response = await fetch(INSYNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookie,
        'Origin': INSYNC_BASE,
        'Referer': `${INSYNC_BASE}/PatientSearch/Index?PageName=caseloadexpand&caseLoadProvider=0&caseLoadFacility=199&caseLoadStatus=0`,
        'User-Agent': INSYNC_UA,
      },
      body: JSON.stringify(INSYNC_BODY),
    });
    if (!response.ok) return res.status(502).json({ error: `InSync returned ${response.status}` });
    insyncData = await response.json();
  } catch (err) {
    return res.status(502).json({ error: `Failed to reach InSync: ${err.message}` });
  }

  const rows = insyncData?.data;
  if (!Array.isArray(rows)) return res.status(502).json({ error: 'Unexpected InSync response — login may have failed' });

  let created = 0, updated = 0, skipped = 0;

  for (const row of rows) {
    const first = (row.FirstName || '').trim() || null;
    const last  = (row.LastName  || '').trim() || null;
    const dob   = parseDobMDY(row.DOB) || null;
    const mrn   = (row.MRNNumber || '').trim() || null;
    const sex   = row.Gender === 'F' ? 'F' : row.Gender === 'M' ? 'M' : null;
    const phone  = (row.PhoneNumber || '').trim() || null;
    const mobile = (row.MobileNumber || row.MobileNo || '').trim() || null;
    const email  = (row.Email || row.PatientEmail || '').trim() || null;
    const status = row.PatientActive === false ? 'inactive' : 'active';

    if (!first && !last) { skipped++; continue; }

    // Match by MRN first, then first+last+dob, then first+last
    let existing = null;
    if (mrn) {
      const { data } = await supabase.from('oo_clients').select('id').eq('mrn', mrn).maybeSingle();
      existing = data;
    }
    if (!existing && first && last) {
      let q = supabase.from('oo_clients').select('id').eq('first_name', first).eq('last_name', last);
      if (dob) q = q.eq('dob', dob);
      const { data } = await q.maybeSingle();
      existing = data;
    }

    const payload = {
      first_name: first, last_name: last, dob, mrn, sex, phone, mobile, email, status,
      insync_patient_id: row.PatientId || null,
      address:           (row.Address || '').trim() || null,
      payer_plan_name:   (row.PayerPlanName || '').trim() || null,
      eligibility_result:(row.EligibilityResult || '').trim() || null,
      referring_provider:(row.ReferringProviderName || '').trim() || null,
      counselor:         (row.Counselor || '').trim() || null,
      insync_data:       row,
      updated_at:        new Date().toISOString(),
    };

    if (existing) {
      const { error } = await supabase.from('oo_clients').update(payload).eq('id', existing.id);
      if (error) skipped++; else updated++;
    } else {
      const { error } = await supabase.from('oo_clients').insert({ ...payload });
      if (error) skipped++; else created++;
    }
  }

  res.json({ ok: true, created, updated, skipped, total: rows.length });
});

// ── Facesheet sync (diagnoses / problem list) ─────────────────────────────

function parseEncounterIds(html) {
  const matches = [...html.matchAll(/encounterid[="'\s:]+(\d{5,})/gi)];
  return [...new Set(matches.map(m => parseInt(m[1])))]; // already DESC by date
}

function parseTreatmentPlan(noteHtml) {
  const text = noteHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  // Find the last "Treatment Plan" heading (the actual TP section, not a field label)
  const markers = [...text.matchAll(/\bTreatment Plan\b/g)];
  if (!markers.length) return [];
  const tpStart = markers[markers.length - 1].index + 'Treatment Plan'.length;
  const tpText = text.slice(tpStart);

  // Each problem area looks like: "Name (category) (Last Review Date: ..., Next Review Date: ...)"
  const problemRegex = /([A-Z][^(]{3,60}\([^)]+\))\s*\(Last Review Date:[^)]+\)/g;
  const found = [];
  let m;
  while ((m = problemRegex.exec(tpText)) !== null) {
    found.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  if (!found.length) return [];

  return found.map((p, i) => {
    const chunk = tpText.slice(p.end, i + 1 < found.length ? found[i + 1].start : tpText.length);

    function extractItems(label) {
      const re = new RegExp(label + ' \\d+: (.*?)(?= ' + label.replace(/[()]/g,'\\$&') + ' \\d+| Long Term| Short Term| Intervention|$)', 'g');
      const items = [];
      let mm;
      while ((mm = re.exec(chunk)) !== null) {
        const val = mm[1].replace(/\s*\[Date Started:[^\]]+\]/g, '').trim();
        if (val) items.push(val);
      }
      return items;
    }

    return {
      problem:          p.name,
      long_term_goals:  extractItems('Long Term Goal\\(s\\)'),
      short_term_goals: extractItems('Short Term Goal\\(s\\)'),
      interventions:    extractItems('Intervention\\(s\\)'),
    };
  });
}

function parseProblemList(html) {
  const idx = html.indexOf('id="dvFSProblemList"');
  if (idx === -1) return [];
  const section = html.slice(idx, idx + 15000);

  const tbodyMatch = section.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const tbody = tbodyMatch[1];

  const diagnoses = [];
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRegex.exec(tbody)) !== null) {
    const row = m[1];
    const tds = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(t => ({ attrs: t[1], inner: t[2] }));
    if (tds.length < 3) continue;

    const dateOnset  = tds[0].inner.replace(/<[^>]+>/g, '').trim();
    const problem    = tds[1].attrs.match(/title="([^"]+)"/)?.[1]?.trim();
    const icd        = tds[2].attrs.match(/title="([^"]+)"/)?.[1]?.trim();
    const notes      = tds[3]?.attrs.match(/title="([^"]*)"/)?.[1]?.trim() || null;

    if (icd && problem) {
      diagnoses.push({ date_onset: dateOnset || null, problem, icd_10: icd, notes: notes || null });
    }
  }
  return diagnoses;
}

router.post('/:id/sync-facesheet', requireAuth, async (req, res) => {
  const { data: client, error: clientErr } = await supabase
    .from('oo_clients').select('id, insync_patient_id, insync_data').eq('id', req.params.id).single();
  if (clientErr) return res.status(404).json({ error: 'Client not found' });
  if (!client.insync_patient_id) return res.status(400).json({ error: 'No InSync Patient ID on file — sync from InSync first.' });

  const [{ data: userSetting }, { data: passSetting }] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', 'insync_username').maybeSingle(),
    supabase.from('app_settings').select('value').eq('key', 'insync_password').maybeSingle(),
  ]);
  const username = userSetting?.value || process.env.INSYNC_USERNAME;
  const password = passSetting?.value || process.env.INSYNC_PASSWORD;
  if (!username || !password) return res.status(400).json({ error: 'InSync credentials not configured.' });

  let cookie;
  try { cookie = await inSyncLogin(username, password); }
  catch (err) { return res.status(401).json({ error: err.message }); }

  const patientId = client.insync_patient_id;
  const priPhyId  = client.insync_data?.PrimaryPhysician || 0;
  const headers   = {
    'User-Agent': INSYNC_UA,
    'Cookie': cookie,
    'Origin': INSYNC_BASE,
    'Referer': `${INSYNC_BASE}/Dashboard/dashboard`,
    'X-Requested-With': 'XMLHttpRequest',
  };

  try {
    // Step 1: set patient context
    await fetch(`${INSYNC_BASE}/EncPatientRestrictAccess/CheckPatientRestriction`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ intpatientid: patientId, PageTitle: 'facesheet', PriPhyId: priPhyId }),
    });

    await fetch(`${INSYNC_BASE}/PatientSearch/SaveVisitedPatientLog`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `patientID=${patientId}`,
    });

    // Step 2: fetch facesheet HTML
    const fsRes = await fetch(`${INSYNC_BASE}/facesheet`, {
      headers: { ...headers, 'X-Requested-With': undefined, 'Accept': 'text/html,*/*' },
    });
    if (!fsRes.ok) return res.status(502).json({ error: `Facesheet returned ${fsRes.status}` });

    const html = await fsRes.text();
    if (html.includes('SIGN IN') && html.includes('Password')) {
      return res.status(401).json({ error: 'InSync session expired during facesheet load.' });
    }

    const diagnoses = parseProblemList(html);

    // Step 3: get encounter list (loaded separately via AJAX on facesheet)
    let encounterIds = [];
    let _dbg = { enc_status: null, enc_body_snippet: null, enc_ids: [], gen_status: null, tp_raw_len: 0, tp_parse_count: 0 };
    try {
      const encRes = await fetch(`${INSYNC_BASE}/Facesheet/FSEncounterReload`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `PatientID=${patientId}&PageSize=50&SortBy=VisitDateNTime+DESC`,
      });
      _dbg.enc_status = encRes.status;
      if (encRes.ok) {
        const encHtml = await encRes.text();
        _dbg.enc_body_snippet = encHtml.slice(0, 300);
        encounterIds = parseEncounterIds(encHtml);
        _dbg.enc_ids = encounterIds;
      }
    } catch (e) { _dbg.enc_err = e.message; }

    // Step 4: fetch treatment plan — try encounter IDs in order until one has note content
    let treatment_plan = client.insync_data?.treatment_plan || [];
    _dbg.tried_enc_ids = [];
    for (const encId of encounterIds.slice(0, 20)) {
      const genBody = new URLSearchParams({
        'EncounterNoteBaseData[IsNeedToGeneretePDF]': 'true',
        'EncounterNoteBaseData[EncounterID]':         String(encId),
        'EncounterNoteBaseData[PatientID]':            String(patientId),
        'EncounterNoteBaseData[IsSignatureControlDisplay]': 'true',
        'EncounterNoteBaseData[PracticeId]':           '200',
        'EncounterNoteBaseData[ConfigType]':           '0',
        'EncounterNoteBaseData[TPChartingElementName]': '',
        'EncounterNoteBaseData[isFromCarePlan]':       'false',
        'EncounterNoteBaseData[FilePath]':             '',
        'EncounterNoteBaseData[HTMLFontSize]':         '11px',
        'EncounterNoteBaseData[HTMLFontName]':         'Arial',
        'EncounterNoteBaseData[ReferingPhyID]':        '0',
        'EncounterNoteBaseData[IsEncounterClose]':     'false',
        'EncounterNoteBaseData[NotesID]':              '0',
      });

      const genRes = await fetch(`${INSYNC_BASE}/EncounterNote/GenerateEncounterNote`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${INSYNC_BASE}/EncounterNote/EncounterNote` },
        body: genBody.toString(),
      });

      _dbg.gen_status = genRes.status;
      if (!genRes.ok) break;
      const genJson = await genRes.json();
      const noteHtml = genJson.StrEncounterNote || '';
      _dbg.tried_enc_ids.push({ id: encId, len: noteHtml.length });
      if (!noteHtml) continue;

      _dbg.tp_raw_len = noteHtml.length;
      const parsed = parseTreatmentPlan(noteHtml);
      _dbg.tp_parse_count = parsed.length;
      if (parsed.length) { treatment_plan = parsed; break; }
    }

    // Merge into insync_data
    const updatedInsyncData = {
      ...(client.insync_data || {}),
      diagnoses,
      treatment_plan,
      facesheet_synced_at: new Date().toISOString(),
    };
    await supabase.from('oo_clients').update({ insync_data: updatedInsyncData, updated_at: new Date().toISOString() }).eq('id', client.id);

    res.json({ ok: true, diagnoses_count: diagnoses.length, tp_count: treatment_plan.length, _dbg });
  } catch (err) {
    res.status(502).json({ error: `Facesheet sync failed: ${err.message}` });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('oo_clients')
    .select('*, oo_referral_sources(id, name, notes_email)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Client not found' });
  res.json(data);
});

module.exports = router;
