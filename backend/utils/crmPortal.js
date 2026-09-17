// Peer Supervision — the CRM (portal.linksnetwork.com) as a second note source.
//
// The CRM has its own supervisor-review queue for peer notes. This module reads
// that queue and sends approve / reopen decisions back, so CRM notes flow into
// ps_notes next to InSync notes and get the same machine checks, duplicate
// check and AI review (utils/psIngest.js).
//
// API (reverse-engineered from `dsc crm notes.har`):
//   POST /api/auth/login                                  form: email, password, next → 303 + session cookie
//   GET  /api/peer-services/supervisor-review/page        the queue (PENDING revisions assigned to this login)
//   GET  /api/peer-services/supervisor-review/:rev/page   one revision, fields already structured
//   POST /api/peer-services/supervisor-review/:rev/decision
//        {decision:'approve'} | {decision:'reopen', message}  (message required for reopen)
//
// Source tracking: a CRM note's ps_notes.eid is `crm:<sessionNoteId>`. The
// sessionNoteId is stable across resubmissions (each gets a new revisionId), so
// it plays the role InSync's encounter id plays. The prefix is the source marker —
// no schema change — and can never collide with InSync's numeric eids.
//
// The CRM carries no diagnosis, treatment plan or date of birth. Those are
// borrowed from the most recent InSync note for the same client already in
// ps_notes (findInsyncContext). No unambiguous match → a machine flag, so the
// note can't be bulk-approved without a human seeing that alignment was unchecked.

const supabase = require('../db/supabase');

const CRM_BASE  = 'https://portal.linksnetwork.com';
const CRM_PREFIX = 'crm:';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NO_CONTEXT_FLAG = 'No InSync chart match for this client — age, diagnosis and treatment-plan checks not run';

const sourceOf = eid => (String(eid || '').startsWith(CRM_PREFIX) ? 'crm' : 'insync');

class CrmPortalClient {
  constructor({ email, password } = {}) {
    this.email    = email;
    this.password = password;
    this.jar      = new Map();
  }

  _addCookies(res) {
    for (const raw of (res.headers.getSetCookie?.() || [])) {
      const pair = raw.split(';')[0];
      const eq   = pair.indexOf('=');
      if (eq === -1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  _headers(extra = {}) {
    return { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9',
             Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
  }

  async login() {
    if (!this.email || !this.password) throw new Error('CRM login not set — add it in the Co-Sign ⚙ Settings tab');
    const res = await fetch(`${CRM_BASE}/api/auth/login`, {
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: CRM_BASE, Referer: `${CRM_BASE}/signin?next=%2Fapp`, Accept: 'text/html,*/*',
      }),
      body: new URLSearchParams({ next: '/app', email: this.email, password: this.password }).toString(),
      redirect: 'manual',
    });
    this._addCookies(res);
    const loc = res.headers.get('location') || '';
    // Password accepted, but the CRM wants a second step: it emails a one-time
    // sign-in link that must be opened in the same session.
    if (/\/signin\/check-email/i.test(loc))
      throw new Error('CRM password accepted, but the CRM requires email verification (it just emailed a one-time sign-in link) — this pull cannot finish the sign-in yet');
    if (res.status >= 400 || /signin|error=/i.test(loc) || !this.jar.size)
      throw new Error('CRM login failed — check the CRM email/password in ⚙ Settings');
    // A redirect alone doesn't prove the session took — confirm it.
    const shell = await this._getJson('/api/me/shell', 'session check');
    if (!shell.ok) throw new Error('CRM login failed — session was not accepted');
  }

  async _getJson(path, label) {
    const res = await fetch(`${CRM_BASE}${path}`, {
      headers: this._headers({ Accept: 'application/json' }), redirect: 'manual', cache: 'no-store',
    });
    this._addCookies(res);
    if (res.status !== 200) throw new Error(`CRM ${label} failed (HTTP ${res.status})`);
    let j;
    try { j = await res.json(); } catch { throw new Error(`CRM ${label} returned non-JSON — session may have expired`); }
    return j;
  }

  // Queue items: { revisionId, sessionNoteId, clientName, peerName, sessionDate,
  // sessionStartMinutes, durationMinutes, submittedAt, revisionOrdinal, reviewState }
  async fetchQueue() {
    const j = await this._getJson('/api/peer-services/supervisor-review/page', 'queue');
    if (!j.ok) throw new Error(`CRM queue: ${j.error || 'request refused'}`);
    return (j.items || []).filter(i => i.reviewState === 'PENDING');
  }

  async fetchRevision(revisionId) {
    const j = await this._getJson(`/api/peer-services/supervisor-review/${encodeURIComponent(revisionId)}/page`, 'note');
    if (!j.ok || !j.revision) throw new Error(`CRM note: ${j.error || 'not found'}`);
    return j.revision;
  }

  // decision: 'approve' | 'reopen'. Returns { ok, reviewState, message }.
  async decide(revisionId, decision, message) {
    if (decision === 'reopen' && !String(message || '').trim())
      return { ok: false, message: 'The CRM requires a reopen reason' };
    const res = await fetch(`${CRM_BASE}/api/peer-services/supervisor-review/${encodeURIComponent(revisionId)}/decision`, {
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/json', Accept: 'application/json', Origin: CRM_BASE,
        Referer: `${CRM_BASE}/app/peer-services/supervisor-review?revisionId=${encodeURIComponent(revisionId)}`,
      }),
      body: JSON.stringify(decision === 'reopen' ? { decision, message } : { decision }),
      redirect: 'manual',
    });
    let j = {};
    try { j = await res.json(); } catch {}
    if (res.status !== 200 || !j.ok)
      return { ok: false, message: j.error || `CRM ${decision} failed (HTTP ${res.status})` };
    return { ok: true, reviewState: j.reviewState, message: decision === 'reopen' ? 'Reopened for revision' : 'Approved' };
  }
}

// ── Mapping a CRM revision onto the InSync note shape ───────────────────────────
//
// Everything downstream (checkNote, findDupe, buildReviewPayload, the Read view)
// reads InSync's note object and its text headings. Rather than teach each of
// them a second shape, a CRM revision is rendered into that same shape: the
// headings InSync uses, one per line, each value collapsed to a single line so
// narrative text can never start a line that looks like a heading.

const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim();

function fmtMins(mins) {
  if (mins == null || isNaN(mins)) return '';
  const h24 = Math.floor(mins / 60) % 24, m = mins % 60;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

function usDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

const humanEnum = v => oneLine(v).toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

function ageOn(dobStr, onDate) {
  const d = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dobStr || '');
  if (!d || !onDate) return null;
  const [mo, dd, y] = [Number(d[1]), Number(d[2]), Number(d[3])];
  let age = onDate.getFullYear() - y;
  if (onDate < new Date(onDate.getFullYear(), mo - 1, dd)) age--;
  return age;
}

// `context` (or null): { pid, mrn, dobStr, diagnosis, treatmentPlan } from findInsyncContext.
function crmRevisionToNote(rev, context = null) {
  const s = rev.snapshot || {};
  const visitDate = usDate(s.sessionDate);
  const startMins = s.sessionStartMinutes ?? null;
  const dur       = s.durationMinutes ?? null;
  const endMins   = startMins != null && dur != null ? startMins + dur : null;
  const startTimeStr = fmtMins(startMins);
  const endTimeStr   = fmtMins(endMins);
  const totalTime = dur != null ? `${Math.floor(dur / 60)} hr ${dur % 60} min` : '';
  const visitDateObj = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.sessionDate || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor((startMins || 0) / 60), (startMins || 0) % 60) : null;
  })();
  // InSync computes age as of today; do the same so the minor rules match.
  const age = context?.dobStr ? ageOn(context.dobStr, new Date()) : null;

  const location = [
    oneLine(s.locationText),
    s.locationCategory ? `(${humanEnum(s.locationCategory)})` : '',
    s.sessionMode ? `— ${humanEnum(s.sessionMode)}` : '',
    s.sessionLanguageCategory ? `— ${humanEnum(s.sessionLanguageCategory)}` : '',
    s.isOffsite ? `— Off-site. Off-site justification: ${oneLine(s.offsiteJustification) || '(none given)'}` : '',
  ].filter(Boolean).join(' ');

  const interventions = (s.interventions || [])
    .map(i => oneLine(`${i.label}${i.details ? ` — ${i.details}` : ''}`)).filter(Boolean);
  if (oneLine(s.interventionDetails)) interventions.push(oneLine(s.interventionDetails));

  const narrativeLines = [
    `Persons Present: ${oneLine(s.personsPresent)}`,
    `Location of the Meeting: ${location}`,
    `Focus of the meeting: ${oneLine(s.focusOfMeeting)}`,
    // Colon, not InSync's "?": on a single line the parser only accepts a colon.
    `What activities took place, and for how long: ${oneLine(s.activitiesSummary)}`,
    `Peer Support Interventions: ${interventions.join('; ')}`,
    `Patient's Response/Content: ${oneLine(s.patientResponse)}`,
    `Plan: ${oneLine(s.nextPlan)}`,
  ];

  const lines = [
    'Patient Details',
    `Name: ${oneLine(rev.clientName)}`,
    ...(age != null ? [`Age: ${age}`] : []),
    ...(context?.mrn ? [`MRN: ${context.mrn}`] : []),
    'Visit Details',
    `Visit Date: ${visitDate}`,
    `Encounter Type: ${oneLine(s.derivedEncounterTypeLabel)}`,
    `Start Time: ${startTimeStr}`,
    `End Time: ${endTimeStr}`,
    `Total Time: ${totalTime}`,
    'Note of Session',
    ...narrativeLines,
    // Borrowed chart context, labelled as InSync's own sections so the Read view
    // and the review payload find it where they always do.
    ...(context?.diagnosis ? ['Diagnosis', oneLine(context.diagnosis)] : []),
    ...(context?.treatmentPlan ? ['Treatment Plan', oneLine(context.treatmentPlan)] : []),
  ];
  const structured = lines.join('\n');
  const text = structured.replace(/\s+/g, ' ').trim();

  return {
    source:          'crm',
    eid:             `${CRM_PREFIX}${rev.sessionNoteId}`,
    revisionId:      rev.id,
    sessionNoteId:   rev.sessionNoteId,
    revisionOrdinal: rev.revisionOrdinal,
    submittedAt:     rev.submittedAt,
    changedFieldKeys: rev.changedFieldKeys || [],
    pid:             context?.pid || null,
    mrn:             context?.mrn || '',
    dobStr:          context?.dobStr || '',
    chartContext:    context ? { pid: context.pid, fromEid: context.fromEid } : null,
    peerName:        oneLine(rev.peerName),
    patientName:     oneLine(rev.clientName),
    encounterType:   oneLine(s.derivedEncounterTypeLabel),
    pos: '', visitCodes: '',
    totalTime, startTimeStr, endTimeStr,
    durationMinutes: dur,
    startMins, endMins,
    age,
    visitDate,
    visitDatetime:   visitDate ? `${visitDate} ${startTimeStr}`.trim() : '',
    visitDateObj,
    noteText:        text,
    sessionNarrative: narrativeLines.join('\n'),
    sessionContent:  narrativeLines.slice(2).join(' ').replace(/\s+/g, ' '),
    diagnosis:       context?.diagnosis || '',
    treatmentPlan:   context?.treatmentPlan || '',
    fullNoteText:    text,
    structuredText:  structured,
    // What "changed" means for a CRM note: the peer's content plus the revision
    // it lives on. Borrowed chart context is deliberately excluded so an InSync
    // pull never makes a CRM note look revised; the revisionId is included so a
    // resubmission is always re-examined (and approve targets the live revision).
    hashBasis: JSON.stringify({ revisionId: rev.id, snapshot: s }),
  };
}

// ── Chart context from InSync notes already stored ─────────────────────────────

// "Eliezer Rosenberg" ↔ "Rosenberg, Eliezer": compare as token sets.
const nameTokens = n => String(n || '').toLowerCase().replace(/[^a-z\s,'-]/g, ' ')
  .split(/[\s,]+/).filter(t => t.length > 1).sort().join(' ');

async function findInsyncContext(clientName) {
  const want = nameTokens(clientName);
  if (!want) return null;
  const longest = want.split(' ').sort((a, b) => b.length - a.length)[0];
  const { data } = await supabase.from('ps_notes')
    .select('eid, pid, mrn, patient_name, note_data')
    .not('eid', 'like', `${CRM_PREFIX}%`)
    .ilike('patient_name', `%${longest}%`)
    .order('ingested_at', { ascending: false })
    .limit(100);
  const matches = (data || []).filter(r => nameTokens(r.patient_name) === want && r.pid);
  // Two different InSync patients with this name → refuse to guess.
  if (!matches.length || new Set(matches.map(r => String(r.pid))).size !== 1) return null;
  const best = matches.find(r => r.note_data?.diagnosis || r.note_data?.treatmentPlan) || matches[0];
  const nd = best.note_data || {};
  return {
    pid: String(best.pid), mrn: best.mrn || nd.mrn || '', dobStr: nd.dobStr || '',
    diagnosis: nd.diagnosis || '', treatmentPlan: nd.treatmentPlan || '', fromEid: best.eid,
  };
}

module.exports = { CrmPortalClient, crmRevisionToNote, findInsyncContext, nameTokens,
                   sourceOf, CRM_PREFIX, NO_CONTEXT_FLAG };
