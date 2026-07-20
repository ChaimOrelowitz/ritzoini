const Anthropic = require('@anthropic-ai/sdk');

const BASE       = 'https://thedscenter.insynchcs.com';
const CHROME_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCHOOL_START      = 8  * 60;   // 08:00
const SCHOOL_END        = 15 * 60;   // 15:00
const MAX_SESSION_MINS  = 180;
// Bigram similarity is only a candidate net now — cast wide, the AI judge
// decides. CANDIDATE_THRESHOLD is intentionally loose; MAX_CANDIDATE_PAIRS
// bounds the number of AI judge calls per scan.
const CANDIDATE_THRESHOLD  = 0.60;
const MAX_CANDIDATE_PAIRS  = 100;
const SESSION_TIMEOUT_MARKERS = [
  'InSync :: Session Timeout', '/SessionTimeOut',
  'Your session is expired.', 'RE-LOGIN',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── AI prompts ────────────────────────────────────────────────────────────────
// Both prompts are editable from the PS Settings tab (persisted in app_settings)
// so the QA criteria can be tuned without a deploy. They use {{token}}
// placeholders filled by renderPrompt below — deliberately NOT JS template
// literals, so an operator-edited string is only ever substituted into, never
// executed. An unknown token renders empty rather than throwing.

const DEFAULT_COHERENCE_PROMPT = `You are a QA reviewer for peer support session documentation. Review this note and flag clear, defensible problems (not minor nitpicks).

STATED TOTAL DURATION: {{duration}}

SESSION NARRATIVE (what the note says happened, including any per-activity minute breakdown):
---
{{narrative}}
---

TREATMENT PLAN (the client's documented goals and interventions — this is the ANCHOR for judging clinical fit):
---
{{plan}}
---

DIAGNOSES (context only): {{dx}}

The above sections contain the COMPLETE note content — nothing is truncated. Do not remark on the note being cut off.

Evaluate THREE things and flag if ANY shows a clear problem:

1. ACTIVITY-TIME ARITHMETIC: The narrative often breaks the session into timed chunks (e.g. "the first 30 minutes...", "the next 25 minutes..."). If it does, add those minutes up and compare to the STATED TOTAL DURATION. Flag a clear mismatch — the chunks summing to well under the total (padded/over-billed time) or well over it. Allow small rounding differences; only flag a material gap. If the narrative gives no per-activity minutes, skip this check.

2. DURATION vs NARRATIVE DEPTH: Does the amount and depth of activity described plausibly fit the stated total duration? A short session (e.g. 30 min) crammed with many deep interventions is implausible; a long session (e.g. 2 hr) described in one or two thin sentences is also implausible.

3. SESSION vs TREATMENT PLAN (anchor): Do the focus, activities, and interventions in the session align with the documented treatment plan? If the session describes work unrelated to any plan goal or intervention, flag it. Use the treatment plan as the anchor; the diagnosis is only supporting context.

Respond ONLY with valid JSON, no other text:
{"flag": true or false, "reason": "one specific sentence naming the concern if flagged (for an arithmetic mismatch, state the numbers — e.g. 'activities sum to 80 min but 2 hr billed'), null if coherent"}`;

const DEFAULT_CLONE_PROMPT = `You are a documentation-integrity reviewer for peer support services. You are given TWO session notes. Decide whether one appears COPIED from the other (or both pasted from a shared template) rather than genuinely written for each specific session.

Do NOT flag legitimate similarity. Peer support sessions legitimately recur: the same client, or different clients, may do the same activities (e.g. go for a walk), use the same interventions, and be documented in the peer's consistent writing style. Similar structure, similar activities, and a repetitive "Patient's Response/Content" section are NORMAL and are NOT evidence of copying on their own.

DO flag as a copy when there is clear evidence the note was not individually written for this session, such as:
- Long verbatim or near-verbatim passages describing what happened (especially the "Focus of the meeting" and activities narrative) that are essentially identical between the two notes.
- A note that references the WRONG person — a different client's name, or mismatched gender/pronouns — a tell that another client's note was pasted.
- Generic boilerplate with no concrete detail specific to this particular session.
- Internal contradictions that indicate careless copying.

This applies whether the two notes are for the SAME client (a prior session recycled) or DIFFERENT clients (one client's note reused for another).

NOTE A — client: {{a_name}}, date: {{a_date}}:
---
{{a_content}}
---
NOTE B — client: {{b_name}}, date: {{b_date}}:
---
{{b_content}}
---

Respond ONLY with valid JSON, no other text:
{"copy": true or false, "reason": "one specific sentence naming the concrete evidence (verbatim passage, wrong name/pronoun, etc.) if copy is true, else null"}`;

function renderPrompt(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_m, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]));
}

// Bigram count map for a string (built once per note, reused across compares).
function bigramMap(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

// Bigram (Sørensen-Dice) similarity from two precomputed maps + string lengths.
// Approximates Python SequenceMatcher.ratio(); iterate the smaller map.
function bigramSimFromMaps(ma, la, mb, lb) {
  const [small, big] = ma.size <= mb.size ? [ma, mb] : [mb, ma];
  let intersect = 0;
  for (const [g, c] of small) intersect += Math.min(c, big.get(g) || 0);
  const total = (la - 1) + (lb - 1);
  return total <= 0 ? 0 : (2 * intersect) / total;
}

class InsyncCoSignEngine {
  constructor({ username, password, anthropicKey, providerId, noSchoolStart, noSchoolEnd,
                coherencePrompt, clonePrompt } = {}) {
    this.username      = username;
    this.password      = password;
    this.anthropicKey  = anthropicKey;
    this.providerId    = providerId || '2317';
    this.noSchoolStart = noSchoolStart || '';
    this.noSchoolEnd   = noSchoolEnd   || '';
    // Operator-editable (PS Settings tab); fall back to the shipped defaults.
    this.coherencePrompt = (coherencePrompt || '').trim() || DEFAULT_COHERENCE_PROMPT;
    this.clonePrompt     = (clonePrompt     || '').trim() || DEFAULT_CLONE_PROMPT;
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

  // Raw-body POST with a JSON content-type. InSync's reopen endpoints expect a
  // loosely-formatted body string (unquoted keys, URL-encoded values) — not
  // form-encoding — so we pass the exact string through rather than serializing.
  async _postRaw(path, rawBody, { headers } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method:  'POST',
      headers: this._headers({
        'Content-Type':     'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin':           BASE,
        'Referer':          `${BASE}/CoSignEncounterList/CoSignature?action=-1`,
        ...headers,
      }),
      body: rawBody,
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
    const mrn       = field('MRN');

    let dur = null;
    let tm = /(\d+)\s*hr[s]?\s*(?:(\d+)\s*min[s]?)?/i.exec(totalTime);
    if (tm) { dur = parseInt(tm[1]) * 60 + parseInt(tm[2] || 0); }
    else { tm = /(\d+)\s*min[s]?/i.exec(totalTime); if (tm) dur = parseInt(tm[1]); }

    const sessionNarrative = this._section(text, 'Note of Session', ['Diagnosis','Plan / Visit Codes','Electronically Signed']);
    const sessionContent   = this._sessionContent(text);
    const diagnosis        = this._section(text, 'Diagnosis',        ['Plan / Visit Codes','Treatment Plan','Electronically Signed']);
    const treatmentPlan    = this._section(text, 'Treatment Plan',   ['Electronically Signed','Provider NPI']);

    return {
      ...row,
      mrn,
      totalTime, startTimeStr: startStr, endTimeStr: endStr,
      durationMinutes: dur,
      startMins:    this._timeMins(startStr),
      endMins:      this._timeMins(endStr),
      age:          this._age(row.dobStr),
      visitDate:    row.visitDatetime ? row.visitDatetime.split(' ')[0] : '',
      visitDateObj: this._parseDate(row.visitDatetime),
      noteText:     text,
      sessionNarrative: sessionNarrative || text,
      sessionContent,
      diagnosis, treatmentPlan,
      fullNoteText: text,
    };
  }

  // The genuinely session-specific free text: "Focus of the meeting" through
  // "Plan", stopping before the diagnosis codes / visit codes / treatment plan /
  // signature. This is the part a peer actually writes per-session (and clones);
  // everything outside it (demographics, times, ICD codes, the templated
  // treatment-plan goals) is boilerplate that shouldn't drive clone matching.
  _sessionContent(text) {
    const sm = /Focus of the meeting\s*[:\-]/i.exec(text);
    if (!sm) return '';
    const start = sm.index;
    const tail  = text.slice(start);
    let end = tail.length;
    for (const re of [/\bF\d{2}\.\d/, /Visit Codes\s*[:\-]/i, /Treatment Plan/, /Electronically Signed/i, /Provider NPI/i]) {
      const mm = re.exec(tail);
      if (mm && mm.index > 0) end = Math.min(end, mm.index);
    }
    return tail.slice(0, end).replace(/\s+/g, ' ').trim();
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

  // ── Clone candidate finding ───────────────────────────────────────────────────

  // The bigram similarity is no longer the verdict — it's a cheap WIDE NET that
  // surfaces candidate pairs for the AI judge (aiCloneJudge) to rule on. Cast
  // loose (CANDIDATE_THRESHOLD) so borderline/legit-looking pairs still reach the
  // AI, which has the judgment the math lacks. Compares only the per-session
  // narrative (Focus → Plan); notes without one are skipped. Each note is placed
  // in at most one pair (greedy by score) to bound the number of AI calls, and
  // the total is capped. Same-client AND cross-client pairs are both eligible.
  cloneCandidates(notes) {
    const prepared = notes.map(n => {
      let norm = (n.sessionContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
      for (const part of (n.patientName || '').toLowerCase().replace(',', ' ').split(' '))
        if (part.length > 2) norm = norm.split(part).join('');
      return norm;
    });
    // Precompute each note's bigram map once (instead of rebuilding per compare).
    const maps = prepared.map(s => s.length >= 120 ? bigramMap(s) : null);

    const pairs = [];
    for (let i = 0; i < notes.length; i++) {
      if (!maps[i]) continue;
      for (let j = i + 1; j < notes.length; j++) {
        if (!maps[j]) continue;
        const ratio = bigramSimFromMaps(maps[i], prepared[i].length, maps[j], prepared[j].length);
        if (ratio >= CANDIDATE_THRESHOLD) pairs.push({ i, j, pct: Math.round(ratio * 100) });
      }
    }
    pairs.sort((a, b) => b.pct - a.pct);

    const used = new Set(), out = [];
    for (const p of pairs) {
      if (used.has(p.i) || used.has(p.j)) continue;
      used.add(p.i); used.add(p.j);
      out.push({ a: notes[p.i], b: notes[p.j], pct: p.pct });
      if (out.length >= MAX_CANDIDATE_PAIRS) break;
    }
    return out;
  }

  // AI judge for a candidate pair: is one note COPIED from the other (verbatim
  // reuse / not individualized), or is this legitimate recurring work? Returns
  // { copy, reason }. Framed to let legitimate similarity through.
  async aiCloneJudge(a, b) {
    if (!this.anthropicKey) return { copy: false, reason: null };
    const anthropic = new Anthropic({ apiKey: this.anthropicKey });
    const clip = s => (s || '').slice(0, 6000);

    const prompt = renderPrompt(this.clonePrompt, {
      a_name:    a.patientName || 'unknown',
      a_date:    a.visitDate || a.visitDatetime || 'unknown',
      a_content: clip(a.sessionContent),
      b_name:    b.patientName || 'unknown',
      b_date:    b.visitDate || b.visitDatetime || 'unknown',
      b_content: clip(b.sessionContent),
    });

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 250,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw    = msg.content[0].text.trim().replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(raw);
      return { copy: !!parsed.copy, reason: parsed.copy ? parsed.reason : null };
    } catch { return { copy: false, reason: null }; }
  }

  // ── AI review ───────────────────────────────────────────────────────────────

  async aiReview(note) {
    if (!this.anthropicKey || !note.noteText) return null;
    const anthropic  = new Anthropic({ apiKey: this.anthropicKey });
    const duration   = note.totalTime || 'unknown';
    const narrative  = (note.sessionContent || note.sessionNarrative || note.noteText || '').slice(0, 12000);
    const plan       = (note.treatmentPlan || '').slice(0, 8000);
    const dx         = (note.diagnosis || '').slice(0, 1500);

    const prompt = renderPrompt(this.coherencePrompt, {
      duration,
      narrative,
      plan: plan || '(not found in note)',
      dx:   dx   || '(not found)',
    });

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 200,
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

  // ── Reopen (send back for revision) ───────────────────────────────────────────

  // Returns { allowed, message }. Reopen is hard-blocked once a billing claim has
  // been generated for the encounter (InSync's RestrictedToReopenAfterClaimGen).
  async checkReopenable(eid) {
    const r = await this._postRaw('/EncounterDetail/RestrictedToReopenAfterClaimGen', `{EncounterId:'${eid}'}`);
    if (!r.ok) return { allowed: false, message: `Reopen check failed (HTTP ${r.status})` };
    let j = {};
    try { j = await r.json(); } catch {}
    const st = j.RestrictedToReopenStatus || {};
    return st.HasAccess === 1
      ? { allowed: true,  message: '' }
      : { allowed: false, message: 'Cannot reopen — a billing claim has already been generated for this encounter.' };
  }

  // Reopen a single encounter with a revision reason. Checks the claim gate first.
  async reopenNote({ eid, pid, reason }) {
    const gate = await this.checkReopenable(eid);
    if (!gate.allowed) return { ok: false, blocked: true, message: gate.message };

    // encodeURIComponent leaves apostrophes raw, which would break the single-
    // quoted value in InSync's loose-JSON body — encode them explicitly.
    const enc = encodeURIComponent(reason || '').replace(/'/g, '%27');
    const body = `{PatientId : ${pid}, EncounterId:${eid}, txtReasonToReopen:'${enc}'}`;
    const r = await this._postRaw('/CoSignEncounterList/EditEncounter', body);
    if (!r.ok) return { ok: false, message: `Reopen failed (HTTP ${r.status})` };
    let j = {};
    try { j = await r.json(); } catch {}
    if (j.ReopenEncounterRestrictionMessage)
      return { ok: false, blocked: true, message: j.ReopenEncounterRestrictionMessage };
    return { ok: true, message: 'Reopened for revision' };
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

    // Wide net → AI judge. The bigram net surfaces candidate pairs; Claude
    // decides which are actually copied (verbatim reuse / wrong name / not
    // individualized) vs. legitimate recurring work. Only AI-confirmed pairs
    // become clone flags. Same-client and cross-client pairs both eligible.
    report('Finding candidate duplicate pairs...', 58);
    const candidates = this.cloneCandidates(notes);
    const cloneFlags = {}, clonePartners = {};
    if (this.anthropicKey && candidates.length) {
      for (let i = 0; i < candidates.length; i++) {
        report(`AI checking possible copies ${i + 1} of ${candidates.length}...`, 58 + Math.floor((i / candidates.length) * 6));
        const { a, b } = candidates[i];
        const verdict = await this.aiCloneJudge(a, b);
        if (verdict.copy) {
          const reason = verdict.reason || 'Appears copied — not individualized to this session';
          if (!cloneFlags[a.eid]) { cloneFlags[a.eid] = `Likely copied note: ${reason}`; clonePartners[a.eid] = { eid: b.eid, pct: candidates[i].pct }; }
          if (!cloneFlags[b.eid]) { cloneFlags[b.eid] = `Likely copied note: ${reason}`; clonePartners[b.eid] = { eid: a.eid, pct: candidates[i].pct }; }
        }
        await sleep(80);
      }
    }

    // The AI coherence review is QA and runs on EVERY note (not just the ones
    // that passed the deterministic + clone checks). Flags accumulate: a note can
    // carry a rule flag AND a clone flag AND a coherence flag at once. A note is
    // "clean" only if nothing flagged it.
    report('Running QA review...', 64);
    const flagged = [...cantLoad];
    const clean   = [];
    const n = notes.length;

    for (let i = 0; i < n; i++) {
      const note    = notes[i];
      const flags   = this.checkNote(note);            // deterministic: time / minor
      const partner = clonePartners[note.eid];
      if (cloneFlags[note.eid]) flags.push(cloneFlags[note.eid]);   // AI clone verdict

      let aiFlag = null;
      if (this.anthropicKey) {
        report(`AI QA review ${i + 1} of ${n}...`, 64 + Math.floor((i / n) * 34));
        aiFlag = await this.aiReview(note);            // coherence QA — every note
        await sleep(80);
      }

      if (flags.length || aiFlag) {
        flagged.push({
          ...note, flags, aiFlag,
          clonePartnerEid: partner?.eid ?? null,
          clonePct:        partner?.pct ?? null,
        });
      } else {
        clean.push({ ...note, aiFlag: null });
      }
    }

    report('Done!', 100);

    // Strip non-serializable fields; keep fullNoteText on flagged only
    for (const note of flagged) { delete note.visitDateObj; delete note.noteText; }
    for (const note of clean)   { delete note.visitDateObj; delete note.noteText; delete note.fullNoteText; }

    flagged.sort((a, b) => (a.patientName || '').toLowerCase().localeCompare((b.patientName || '').toLowerCase()));
    return { flagged, clean };
  }
}

module.exports = { InsyncCoSignEngine, DEFAULT_COHERENCE_PROMPT, DEFAULT_CLONE_PROMPT };
