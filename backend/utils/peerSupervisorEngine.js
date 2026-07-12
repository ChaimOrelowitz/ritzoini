const Anthropic = require('@anthropic-ai/sdk');

const BASE       = 'https://thedscenter.insynchcs.com';
const CHROME_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCHOOL_START      = 8  * 60;   // 08:00
const SCHOOL_END        = 15 * 60;   // 15:00
const MAX_SESSION_MINS  = 180;
const SIMILARITY_THRESHOLD = 0.90;
const SESSION_TIMEOUT_MARKERS = [
  'InSync :: Session Timeout', '/SessionTimeOut',
  'Your session is expired.', 'RE-LOGIN',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bigram similarity — approximates Python SequenceMatcher.ratio()
function bigramSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const bigrams = s => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ba = bigrams(a), bb = bigrams(b);
  let intersect = 0;
  for (const [g, c] of ba) intersect += Math.min(c, bb.get(g) || 0);
  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 0 : (2 * intersect) / total;
}

class InsyncCoSignEngine {
  constructor({ username, password, anthropicKey, providerId, noSchoolStart, noSchoolEnd }) {
    this.username      = username;
    this.password      = password;
    this.anthropicKey  = anthropicKey;
    this.providerId    = providerId || '2317';
    this.noSchoolStart = noSchoolStart || '';
    this.noSchoolEnd   = noSchoolEnd   || '';
    this.jar           = new Map();
  }

  // ── Cookie jar ──────────────────────────────────────────────────────────────

  _addCookies(res) {
    for (const raw of (res.headers.getSetCookie?.() || [])) {
      const pair = raw.split(';')[0];
      const eq   = pair.indexOf('=');
      if (eq === -1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  _cookieStr() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _headers(extra = {}) {
    return { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9',
             'Cookie': this._cookieStr(), ...extra };
  }

  // ── Low-level fetch helpers ─────────────────────────────────────────────────

  async _get(path, { params, headers } = {}) {
    let url = path.startsWith('http') ? path : `${BASE}${path}`;
    if (params) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(params);
    const res = await fetch(url, { headers: this._headers(headers || {}), redirect: 'manual' });
    this._addCookies(res);
    return res;
  }

  async _post(path, data, { headers } = {}) {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    const res = await fetch(url, {
      method:  'POST',
      headers: this._headers({
        'Content-Type':       'application/x-www-form-urlencoded',
        'X-Requested-With':   'XMLHttpRequest',
        'Origin':             BASE,
        'Referer':            `${BASE}/CoSignEncounterList/CoSignature?action=-1`,
        ...headers,
      }),
      body: new URLSearchParams(data).toString(),
    });
    this._addCookies(res);
    return res;
  }

  // ── Login ───────────────────────────────────────────────────────────────────

  async login() {
    // Step 1: GET /account — seeds initial cookies
    await this._get('/account', { headers: { Accept: 'text/html,*/*' } });

    // Step 2: POST / with redirect-following (same as insync.js)
    let url = `${BASE}/`, method = 'POST';
    let body = new URLSearchParams({
      UserName: this.username, Password: this.password,
      GeoLocation: '', GeoErrorCode: '', GeoErrorMessage: '',
      IsAzureAd: 'False', PageID: 'PatientSearch',
      hdnPageListVal: 'PatientSearch', IsAutoLoginWithCookie: 'False',
    }).toString();

    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(url, {
        method,
        headers: this._headers({
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          Origin: BASE, Referer: `${BASE}/account`, Accept: 'text/html,*/*',
        }),
        body: method === 'POST' ? body : undefined,
        redirect: 'manual',
      });
      this._addCookies(res);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') || '';
        url    = loc.startsWith('http') ? loc : `${BASE}${loc}`;
        method = 'GET'; body = undefined;
      } else {
        const text = await res.text();
        if (text.includes('SIGN IN') && text.includes('Password'))
          throw new Error('InSync login failed — check credentials in ⚙ settings');
        break;
      }
    }

    if (!this.jar.size) throw new Error('InSync login returned no cookies');

    // Step 3: Bootstrap the CoSignature page — solidifies the authenticated session
    await this._get('/CoSignEncounterList/CoSignature?action=-1', {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });

    // Step 4: CRITICAL — CoSignSearchData must fire before BindCoSignList or it returns nothing
    await this._get('/CoSignEncounterList/CoSignSearchData', {
      params:  { _: String(Date.now()) },
      headers: {
        Accept: 'text/html,*/*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/CoSignEncounterList/CoSignature?action=-1`,
      },
    });
  }

  // ── Fetch all pages ─────────────────────────────────────────────────────────

  async fetchAllPages(onProgress) {
    const now  = new Date();
    const from = new Date(now); from.setDate(from.getDate() - 90);
    const fmt  = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

    const baseParams = {
      'searchParamter[PatientId]':                   '0',
      'searchParamter[FacilityIds]':                 '0',
      'searchParamter[ProviderIds]':                 '',
      'searchParamter[EncounterTypeIds]':            '',
      'searchParamter[VisitDateFrom]':               fmt(from),
      'searchParamter[VisitDateTo]':                 fmt(now),
      'searchParamter[AssignToProviderIDs]':         this.providerId,
      'searchParamter[CoSignStatus]':                '0',
      'searchParamter[EncounterCategoryIds]':        '',
      'searchParamter[ClosedDateFrom]':              '',
      'searchParamter[SortBy]':                      'VisitDateTime DESC',
      'searchParamter[ClosedDateTo]':                '',
      'searchParamter[PayerIds]':                    '',
      'searchParamter[ProgramIds]':                  '',
      'searchParamter[IsActive]':                    'true',
      'searchParamter[NotesNotCompletedOption]':     '',
      'searchParamter[NotesNotCompletedDaysFrom]':   '',
      'searchParamter[NotesNotCompletedDaysTo]':     '',
      'searchParamter[PatientCategoryIds]':          '',
      'searchParamter[EncounterCategoryName]':       '',
      'searchParamter[TPLetterStatus]':              '',
    };

    const rows = [], seen = new Set();
    let page = 1;

    while (page <= 50) {
      if (onProgress) onProgress(`Fetching page ${page} (${rows.length} notes so far)...`, Math.min(5 + page * 2, 18));
      try {
        const res = await this._post('/CoSignEncounterList/BindCoSignList',
          { ...baseParams, 'searchParamter[PageNumber]': String(page) });
        if (!res.ok) break;
        const html = await res.text();
        if (SESSION_TIMEOUT_MARKERS.some(m => html.includes(m)))
          throw new Error('InSync session expired during scan');
        const pageRows = this._parseRows(html, seen);
        rows.push(...pageRows);
        if (pageRows.length < 30) break;
        page++;
      } catch (err) {
        if (err.message.includes('session expired')) throw err;
        break;
      }
    }
    return rows;
  }

  _parseRows(html, seen) {
    const rows   = [];
    const epinRe = /<input[^>]*placeholder="EPIN"[^>]*>/gi;
    let m;

    while ((m = epinRe.exec(html)) !== null) {
      const attrs = {};
      const ar = /(\w+)=["']([^"']*)["']/g;
      let am;
      while ((am = ar.exec(m[0])) !== null) attrs[am[1]] = am[2];

      let eid = attrs.eid || '';
      if (!eid) { const im = /cosign_(\d+)/.exec(attrs.id || ''); if (im) eid = im[1]; }
      const pid = attrs.pid || '';
      if (!eid || !pid || seen.has(eid)) continue;
      seen.add(eid);

      const trM = new RegExp(`<tr[^>]*id="tr_${eid}"[^>]*>([\\s\\S]*?)</tr>`, 'i').exec(html);
      let name = '', dob = '', visit = '', peer = '', peerId = '';
      if (trM) {
        const th = trM[1];
        const nm  = /data-patientname="([^"]*)"/.exec(th);
        const dm  = /data-patientdob="([^"]*)"/.exec(th);
        const vm  = /data-visitdatetime="([^"]*)"/.exec(th);
        const pm  = /data-closedbyprovider="([^"]*)"/.exec(th);
        const pim = /data-providerid="([^"]*)"/.exec(th);
        if (nm)  name   = nm[1];
        if (dm)  dob    = dm[1];
        if (vm)  visit  = vm[1];
        if (pm)  peer   = pm[1];
        if (pim) peerId = pim[1];
      }

      rows.push({
        eid, pid,
        cosignId:    attrs.cosignid      || '118',
        cosignReqId: attrs.cosignrequestid || '',
        patientName: name, dobStr: dob, visitDatetime: visit,
        peerName: peer, peerId,
      });
    }
    return rows;
  }

  // ── Load note ───────────────────────────────────────────────────────────────

  async loadNote(row) {
    const { eid, pid } = row;
    const base = {
      'EncounterNoteBaseData[IsEncounterClose]':          'true',
      'EncounterNoteBaseData[IsNeedToGeneretePDF]':       'false',
      'EncounterNoteBaseData[EncounterID]':               eid,
      'EncounterNoteBaseData[PatientID]':                 pid,
      'EncounterNoteBaseData[IsSignatureControlDisplay]': 'false',
      'EncounterNoteBaseData[PracticeId]':                '200',
      'EncounterNoteBaseData[ConfigType]':                '0',
      'EncounterNoteBaseData[TPChartingElementName]':     '',
      'EncounterNoteBaseData[isFromCarePlan]':            'false',
    };

    let notesId = 242, filePath = '';
    try {
      const r = await this._post('/EncounterNote/GetDefaultNote', base);
      if (r.ok) { const d = (await r.json()).EncounterNoteStyle || {}; notesId = d.NotesId || 242; filePath = d.FilePath || ''; }
    } catch {}

    let noteUrl = null;
    try {
      const r = await this._post('/EncounterNote/GenerateEncounterNote', {
        ...base,
        'EncounterNoteBaseData[FilePath]':    filePath,
        'EncounterNoteBaseData[HTMLFontSize]': '11px',
        'EncounterNoteBaseData[HTMLFontName]': 'Arial',
        'EncounterNoteBaseData[NotesID]':      String(notesId),
      });
      if (r.ok) noteUrl = (await r.json()).StrEncounterNote;
    } catch {}

    if (!noteUrl) return null;
    try {
      const r = await fetch(noteUrl, { headers: this._headers() });
      return r.ok ? this._parseNote(await r.text(), row) : null;
    } catch { return null; }
  }

  _parseNote(html, row) {
    let text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Surgically excise InSync toolbar block from middle of note
    const junkStartMarkers = [
      'Re-BindGrid', 'Save as Draft', 'Send Fax Print',
      'This form is not yet saved', 'Save to Document Manager',
    ];
    const resumeMarkers = [
      'Diagnosis', 'Plan / Visit', 'Treatment Plan',
      'Electronically Signed', 'Provider NPI',
    ];

    let junkStart = text.length;
    for (const jm of junkStartMarkers) { const i = text.indexOf(jm); if (i !== -1) junkStart = Math.min(junkStart, i); }

    if (junkStart < text.length) {
      let resumeAt = null;
      for (const rm of resumeMarkers) {
        const i = text.indexOf(rm, junkStart);
        if (i !== -1) resumeAt = resumeAt === null ? i : Math.min(resumeAt, i);
      }
      text = resumeAt !== null
        ? (text.slice(0, junkStart).trim() + ' ' + text.slice(resumeAt)).trim()
        : text.slice(0, junkStart).trim();
    }

    for (const phrase of [
      'Re-BindGrid Save Save as Draft Clear Send Fax Print',
      'This form is not yet saved.', 'Save to Document Manager',
      'Add to Document Manager', 'Use Patient’s Pre-captured Signature',
      "Use Patient's Pre-captured Signature",
      'Click to view Encounter Note', 'Re-BindGrid', 'Save as Draft',
    ]) text = text.split(phrase).join(' ');
    text = text.replace(/\s+/g, ' ').trim();

    const stopLabels = ['Start Time','End Time','Total Time','Note of Session',
      'Encounter Type','POS','Visit Date','Persons Present',
      'Location of the Meeting','Focus of the meeting','MRN',
      'Phone','E-mail','Address','DOB','Age'];

    const field = lbl => {
      const escaped = escapeRe(lbl.replace(/:$/, '').trim());
      const others  = stopLabels.filter(s => s.toLowerCase() !== lbl.toLowerCase()).map(escapeRe);
      const re = new RegExp(escaped + String.raw`\s*[:\-]\s*(.*?)\s*(?:${others.join('|')}|$)`, 'i');
      const m  = re.exec(text);
      return m ? m[1].trim() : '';
    };

    const totalTime = field('Total Time:');
    const startStr  = field('Start Time:');
    const endStr    = field('End Time:');

    let dur = null;
    let tm = /(\d+)\s*hr[s]?\s*(?:(\d+)\s*min[s]?)?/i.exec(totalTime);
    if (tm) { dur = parseInt(tm[1]) * 60 + parseInt(tm[2] || 0); }
    else { tm = /(\d+)\s*min[s]?/i.exec(totalTime); if (tm) dur = parseInt(tm[1]); }

    const sessionNarrative = this._section(text, 'Note of Session', ['Diagnosis','Plan / Visit Codes','Electronically Signed']);
    const diagnosis        = this._section(text, 'Diagnosis',        ['Plan / Visit Codes','Treatment Plan','Electronically Signed']);
    const treatmentPlan    = this._section(text, 'Treatment Plan',   ['Electronically Signed','Provider NPI']);

    return {
      ...row,
      totalTime, startTimeStr: startStr, endTimeStr: endStr,
      durationMinutes: dur,
      startMins:    this._timeMins(startStr),
      endMins:      this._timeMins(endStr),
      age:          this._age(row.dobStr),
      visitDate:    row.visitDatetime ? row.visitDatetime.split(' ')[0] : '',
      visitDateObj: this._parseDate(row.visitDatetime),
      noteText:     text,
      sessionNarrative: sessionNarrative || text,
      diagnosis, treatmentPlan,
      fullNoteText: text,
    };
  }

  _section(text, startLabel, endLabels) {
    const si = text.toLowerCase().indexOf(startLabel.toLowerCase());
    if (si === -1) return '';
    const cs = si + startLabel.length;
    let end = text.length;
    for (const el of endLabels) {
      const ei = text.toLowerCase().indexOf(el.toLowerCase(), cs);
      if (ei !== -1) end = Math.min(end, ei);
    }
    return text.slice(cs, end).replace(/^[\s:,-]+/, '').trim();
  }

  _timeMins(t) {
    const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(t);
    if (!m) return null;
    let h = parseInt(m[1]);
    const mn = parseInt(m[2]), ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + mn;
  }

  _age(dobStr) {
    if (!dobStr) return null;
    try {
      const [mo, d, y] = dobStr.split('/').map(Number);
      const today = new Date(), dob = new Date(y, mo - 1, d);
      let age = today.getFullYear() - dob.getFullYear();
      if (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate())) age--;
      return age;
    } catch { return null; }
  }

  _parseDate(s) {
    if (!s) return null;
    const fmts = [
      /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
      /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2})/,
      /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    ];
    for (const fmt of fmts) {
      const m = fmt.exec(s.trim());
      if (!m) continue;
      const [, mo, d, y, h, mn, ap] = m;
      let hour = parseInt(h || 0);
      if (ap) { if (ap.toUpperCase() === 'PM' && hour !== 12) hour += 12; if (ap.toUpperCase() === 'AM' && hour === 12) hour = 0; }
      return new Date(parseInt(y), parseInt(mo) - 1, parseInt(d), hour, parseInt(mn || 0));
    }
    return null;
  }

  // ── Checks ──────────────────────────────────────────────────────────────────

  checkNote(note) {
    const flags = [];
    if (note.durationMinutes && note.durationMinutes > MAX_SESSION_MINS)
      flags.push(`Session over 3 hours (${note.totalTime})`);

    if (note.age !== null && note.age !== undefined && note.age < 18 && note.visitDateObj) {
      const dow = note.visitDateObj.getDay(); // 0=Sun, 6=Sat; 1-5=Mon-Fri
      if (dow >= 1 && dow <= 5 && !this._isNoSchool(note.visitDateObj)
          && note.startMins !== null && note.endMins !== null
          && note.startMins < SCHOOL_END && note.endMins > SCHOOL_START)
        flags.push(`Minor (age ${note.age}) during school hours on ${note.visitDate}`);
    }
    return flags;
  }

  _isNoSchool(visitDate) {
    if (!this.noSchoolStart || !this.noSchoolEnd) return false;
    try {
      const [sm, sd] = this.noSchoolStart.split('/').map(Number);
      const [em, ed] = this.noSchoolEnd.split('/').map(Number);
      const v = [visitDate.getMonth() + 1, visitDate.getDate()];
      const cmp = (a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
      const start = [sm, sd], end = [em, ed];
      if (cmp(start, end) <= 0) return cmp(start, v) <= 0 && cmp(v, end) <= 0;
      return cmp(v, start) >= 0 || cmp(v, end) <= 0;
    } catch { return false; }
  }

  // ── Clone detection ─────────────────────────────────────────────────────────

  detectClones(notes) {
    const flags    = {};
    const prepared = notes.map(n => {
      let norm = ((n.sessionNarrative || n.noteText) || '').toLowerCase().replace(/\s+/g, ' ').trim();
      for (const part of (n.patientName || '').toLowerCase().replace(',', ' ').split(' '))
        if (part.length > 2) norm = norm.split(part).join('');
      return norm;
    });

    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const a = prepared[i], b = prepared[j];
        if (a.length < 120 || b.length < 120) continue;
        const ratio = bigramSimilarity(a, b);
        if (ratio < SIMILARITY_THRESHOLD) continue;
        const na = notes[i], nb = notes[j];
        const pct      = Math.round(ratio * 100);
        const samePeer = na.peerId && na.peerId === nb.peerId;
        const fa = samePeer
          ? `Possible cloned note (${pct}% match): same peer as ${nb.patientName || 'another client'}`
          : `Possible cloned note (${pct}% match): matches ${nb.peerName || 'another peer'}'s note for ${nb.patientName || 'another client'}`;
        const fb = samePeer
          ? `Possible cloned note (${pct}% match): same peer as ${na.patientName || 'another client'}`
          : `Possible cloned note (${pct}% match): matches ${na.peerName || 'another peer'}'s note for ${na.patientName || 'another client'}`;
        if (!flags[na.eid]) flags[na.eid] = fa;
        if (!flags[nb.eid]) flags[nb.eid] = fb;
      }
    }
    return flags;
  }

  // ── AI review ───────────────────────────────────────────────────────────────

  async aiReview(note) {
    if (!this.anthropicKey || !note.noteText) return null;
    const anthropic  = new Anthropic({ apiKey: this.anthropicKey });
    const duration   = note.totalTime || 'unknown';
    const narrative  = (note.sessionNarrative || note.noteText || '').slice(0, 12000);
    const plan       = (note.treatmentPlan || '').slice(0, 8000);
    const dx         = (note.diagnosis || '').slice(0, 1500);

    const prompt = `You are a clinical documentation reviewer for peer support services. Review this session note for coherence. Apply MODERATE strictness: flag clear, defensible problems, not minor nitpicks.

The session Start Time, End Time, and Total Time are AUTHORITATIVE FACTS - the true reported length of the session. Do NOT re-add activity minutes to check the total; the total is given. Use the stated duration as the anchor for judging coherence.

STATED DURATION (authoritative): ${duration}

SESSION NARRATIVE (what the note says happened):
---
${narrative}
---

TREATMENT PLAN (the client documented goals and interventions):
---
${plan || '(not found in note)'}
---

DIAGNOSES (context only): ${dx || '(not found)'}

The above sections contain the COMPLETE note content — nothing is truncated. Do not remark on the note being cut off.

Evaluate TWO things and flag if EITHER shows a clear problem:

1. DURATION vs NARRATIVE DEPTH: Does the amount and depth of activity described plausibly fit the stated duration? A short session (e.g. 30 min) crammed with many deep interventions across multiple complex topics is implausible. A long session (e.g. 2 hr) described in one or two thin sentences is also implausible.

2. NARRATIVE vs TREATMENT PLAN: Do the focus, interventions, and goals described in the session align with the documented treatment plan? If the session describes work unrelated to any plan goal or intervention, flag it.

Respond ONLY with valid JSON, no other text:
{"flag": true or false, "reason": "one specific sentence naming the concern if flagged, null if coherent"}`;

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw    = msg.content[0].text.trim().replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(raw);
      return parsed.flag ? parsed.reason : null;
    } catch { return null; }
  }

  // ── Bulk sign ───────────────────────────────────────────────────────────────

  async bulkSign(notes) {
    const pin = process.env.INSYNC_PIN || '1111';
    let signed = 0, failed = 0;

    for (let i = 0; i < notes.length; i += 20) {
      const batch = notes.slice(i, i + 20);
      const xml = batch.map(n =>
        `<RowData><EncounterID>${n.eid}</EncounterID><CoSignNoteType>1</CoSignNoteType>` +
        `<NoteID></NoteID><FilePath></FilePath><CosignID>${n.cosignId || '118'}</CosignID>` +
        `<CoSignRequestID>${n.cosignReqId || ''}</CoSignRequestID></RowData>`
      ).join('');
      try {
        const r = await this._post('/CoSignEncounterList/CoSignEPIN', {
          EncounterIds:    batch.map(n => n.eid).join(','),
          CoSignReason:    '',
          EncounterIdxml:  `<CoSignEncounters>${xml}</CoSignEncounters>`,
          EPIN:            pin,
          IncludeOtherCosign: 'false',
        });
        if (r.ok) signed += batch.length; else failed += batch.length;
      } catch { failed += batch.length; }
      await sleep(500);
    }
    return { signed, failed };
  }

  // ── Full scan ───────────────────────────────────────────────────────────────

  async fullScan(onProgress) {
    const report = (m, p) => { if (onProgress) onProgress(m, p); };

    report('Logging into InSync...', 2);
    await this.login();

    const rows = await this.fetchAllPages(report);
    if (!rows.length) return { flagged: [], clean: [] };

    const total = rows.length;
    report(`Found ${total} notes. Loading content...`, 20);

    const notes = [], cantLoad = [];
    for (let i = 0; i < rows.length; i++) {
      if (i % 3 === 0) report(`Loading note ${i+1} of ${total}...`, 20 + Math.floor((i / total) * 40));
      const note = await this.loadNote(rows[i]);
      if (note) {
        notes.push(note);
      } else {
        cantLoad.push({
          ...rows[i],
          flags: ['Could not load note — manual review required'],
          aiFlag: null, totalTime: '', startTimeStr: '', endTimeStr: '',
          visitDate: rows[i].visitDatetime ? rows[i].visitDatetime.split(' ')[0] : '',
        });
      }
    }

    report('Checking for cloned notes...', 60);
    const cloneFlags = this.detectClones(notes);

    report('Running compliance checks...', 62);
    const flagged = [...cantLoad];
    const provClean = [];

    for (const note of notes) {
      const flags = this.checkNote(note);
      const cf    = cloneFlags[note.eid];
      if (cf) flags.push(cf);
      if (flags.length) flagged.push({ ...note, flags, aiFlag: null });
      else              provClean.push(note);
    }

    let clean = [];
    if (this.anthropicKey && provClean.length) {
      const n = provClean.length;
      for (let i = 0; i < provClean.length; i++) {
        report(`AI reviewing note ${i+1} of ${n}...`, 62 + Math.floor((i / n) * 35));
        const aiFlag = await this.aiReview(provClean[i]);
        if (aiFlag) flagged.push({ ...provClean[i], flags: [], aiFlag });
        else        clean.push({ ...provClean[i], aiFlag: null });
        await sleep(80);
      }
    } else {
      clean = provClean.map(n => ({ ...n, aiFlag: null }));
    }

    report('Done!', 100);

    // Strip non-serializable fields; keep fullNoteText on flagged only
    for (const note of flagged) { delete note.visitDateObj; delete note.noteText; }
    for (const note of clean)   { delete note.visitDateObj; delete note.noteText; delete note.fullNoteText; }

    flagged.sort((a, b) => (a.patientName || '').toLowerCase().localeCompare((b.patientName || '').toLowerCase()));
    return { flagged, clean };
  }
}

module.exports = { InsyncCoSignEngine };
