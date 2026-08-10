const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const BASE       = 'https://thedscenter.insynchcs.com';
const CHROME_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCHOOL_START      = 8  * 60;   // 08:00
const SCHOOL_END        = 15 * 60;   // 15:00
// Duration limits by encounter type (classified by keyword, see checkNote).
const AUDIO_LIMIT_MINS    = 60;   // telehealth audio-only
const VIDEO_LIMIT_MINS    = 120;  // telehealth with video
const INPERSON_SOFT_MINS  = 150;  // in-person preferred 2.5-hour max
const INPERSON_HARD_MINS  = 180;  // in-person 3-hour ceiling
const MINOR_EXTENDED_MINS = 150;  // <18 + over this = high priority
// Default no-school window (month/day) when none is configured in settings.
const DEFAULT_NO_SCHOOL_START = '07/01';
const DEFAULT_NO_SCHOOL_END   = '08/31';
// ── Duplicate awareness (mechanical only — NO AI anywhere in this path) ──────
// A note is a POSSIBLE duplicate when either:
//   A. one substantive section is >= DUPE_STRONG similar, or
//   B. at least DUPE_WEAK_MIN_SECTIONS sections are >= DUPE_WEAK similar.
// "Plan" is deliberately non-substantive: it is the most boilerplate-prone
// section, so it can support a flag (rule B) but must never trigger one alone.
const DUPE_STRONG            = 0.90;
const DUPE_WEAK              = 0.80;
const DUPE_WEAK_MIN_SECTIONS = 2;
const DUPE_MIN_CHARS         = 120;   // skip a section shorter than this

// The five per-session narrative sections, in the order InSync emits them.
//   compared:    participates in duplicate comparison at all.
//   substantive: can TRIGGER a duplicate flag (rule A / the substantive half of
//                rule B). A compared-but-not-substantive section may only
//                support a flag alongside a substantive one.
//
// "Peer Support Interventions" is NOT compared: peer-support intervention
// labels and their descriptions legitimately repeat across sessions, so
// similarity there is not evidence of copying. It is still sent to the AI and
// still read as part of the note — it just never influences duplicate awareness.
// "Plan" is compared but not substantive — it is the most boilerplate-prone
// section, so it can support a flag but never triggers one alone.
const SECTION_LABELS = [
  { key: 'focus',         label: 'Focus of the meeting',                         compared: true,  substantive: true  },
  { key: 'activities',    label: 'What activities took place, and for how long',  compared: true,  substantive: true  },
  { key: 'interventions', label: 'Peer Support Interventions',                    compared: false, substantive: false },
  { key: 'response',      label: "Patient's Response/Content",                    compared: true,  substantive: true  },
  { key: 'plan',          label: 'Plan',                                          compared: true,  substantive: false },
];

// Where the trailing "Plan" section ends — same terminators _sessionContent uses,
// so the compared text never bleeds into ICD codes / visit codes / the treatment
// plan / the signature block.
const SECTION_TERMINATORS = [
  /\bF\d{2}\.\d/, /Visit Codes\s*[:\-]/i, /Treatment Plan/,
  /Electronically Signed/i, /Provider NPI/i, /Plan \/ Visit Codes/i,
];

// AI review identity — part of the fingerprint, so bumping any of these forces a
// fresh review of every note.
const REVIEW_VERSION = 'ps_review_v2';
const REVIEW_MODEL   = 'claude-sonnet-4-6';
// PLAN DEVIATION (documented): the plan specifies max_tokens 1500. Measured
// against real notes, the required schema — four nested objects with
// explanations, an issues array, and three message fields — runs past that and
// the JSON truncates mid-string, so EVERY note came back AI_REVIEW_ERROR
// (observed output_tokens exactly 1500, unterminated JSON). The contract below
// now caps explanation lengths to hold output down, and this ceiling gives the
// remaining headroom. Output tokens are billed as used, so a terse review still
// costs a terse review.
const REVIEW_MAX_TOKENS = 2500;

// Off-site rationale rule starts with dates of SERVICE on/after this date.
// 07/27/2026 was the implementation day, so the 27th itself is not subject to it.
const OFFSITE_RATIONALE_FROM = '2026-07-28';
const SESSION_TIMEOUT_MARKERS = [
  'InSync :: Session Timeout', '/SessionTimeOut',
  'Your session is expired.', 'RE-LOGIN',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The date a queue row belongs to, as InSync writes it: the MM/DD/YYYY half of
// `visitDatetime`. Used as the grouping key for the date picker AND as the
// filter key on pull, so the two can never disagree about what "a date" is.
function dateKeyOf(row) {
  return (row?.visitDatetime || '').split(' ')[0] || '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── AI prompts ────────────────────────────────────────────────────────────────
// Two operator-editable modules (PS Settings tab, persisted in app_settings) are
// composed with a fixed output contract into ONE static system prompt. Static is
// the point: identical bytes across every note in a pull is what makes prompt
// caching work. Note-specific data goes in the user message, never here — so
// these strings contain no {{tokens}} at all.

const DEFAULT_CORE_REVIEW_PROMPT = `You are the documentation and clinical-alignment reviewer for Peer Support progress notes. Your output goes to one human operator, the Reviewer, who decides what to do with it. There is no other human stage.

Evaluate ONLY what is documented in the note you are given.

You must not invent symptoms, diagnoses, interventions, client responses, treatment-plan relationships, off-site reasons, locations, progress, or any other clinical fact. You must never tell a peer to add language merely to make a note billable. Any correction you request must reflect what actually occurred.

PLAIN LANGUAGE IS ACCEPTABLE
Peer Support notes may be written in clear, ordinary, natural language. You must NOT require clinical or technical terminology. The standard is whether the note is specific, individualized, understandable, internally consistent, related to at least one treatment-plan problem or goal, and clear about what occurred, what the peer did, and how the client responded.

Never return a correction merely because the note sounds conversational, describes a creative or practical activity, avoids technical terminology, does not repeat treatment-plan wording verbatim, or does not read like a psychotherapy note. Creative, practical, recreational, household, community, and hands-on activities are perfectly acceptable when the note explains what happened and how it supported the client's goal.

INTERVENTION REVIEW — READ THE WHOLE NOTE
Do NOT judge intervention sufficiency from the "peer_interventions" field alone. Read what the peer did across the entire note: focus, activities and duration, peer interventions, patient response, and plan.

Short intervention labels — Active Listening, Validation, Coping Skills, Strengths-Based Approach, Self-Care, Motivation, Empowerment Coaching, Problem-Solving, Skill-Building, Time Management, and similar — are ACCEPTABLE when the surrounding note describes how the peer used them. Do not require the same explanation to be repeated in more than one section.

Set intervention_status to NEEDS_REVISION only when the note AS A WHOLE fails to establish what the peer actually did. "Provided support." with no further description anywhere in the note is insufficient. The same phrase alongside an activities section that describes reviewing a task list, identifying successful follow-through, exploring what helped the client stay focused, reinforcing realistic expectations, and encouraging prioritisation IS sufficient — mark it SUFFICIENT.

PROGRESS
These notes have no separate progress-statement field, and progress_statement will be null. Never flag that. Never ask for a separately labelled progress statement or a "Progress" heading. Progress documented naturally anywhere in the note counts — the client completed a task, needed less prompting, identified a strategy, tolerated frustration, appeared more comfortable, expressed more confidence, followed through, or participated better.

FUNCTIONAL DIFFICULTIES ARE NOT DIAGNOSES
A peer may describe focus, attention, distractibility, organisation, planning, task completion, forgetfulness, self-monitoring, sustained engagement, difficulty with multi-step tasks, motivation, social participation, and daily functioning. These are symptoms and functional difficulties, not diagnoses. Do NOT flag them merely because they are also commonly associated with some other condition, and do NOT require the peer to state in every note that anxiety or depression caused the difficulty.

It is enough that the peer uses functional language rather than asserting an undocumented diagnosis, the work corresponds to at least one treatment-plan problem or goal, and the intervention and client response align with the work described.

Return UNSUPPORTED_DIAGNOSTIC_LANGUAGE ONLY when the peer's own narrative presents an undocumented condition as an established diagnosis or disorder. With no ADHD diagnosis on file, all of these are flags: "the client has ADHD", "the client's ADHD caused the distraction", "we worked on treating his ADHD", "due to his ADHD the client could not complete the task". None of these are flags: "the client had difficulty maintaining focus", "the client became distracted", "the client practised organisation", "the peer helped the client break tasks into smaller steps", "the client used reminders to remain attentive", "the session focused on task completion and planning".

TREATMENT-PLAN HEADINGS ARE NOT DIAGNOSES
Do NOT compare a treatment-plan problem's NAME against the diagnosis list as though every heading were a formal diagnosis. Plan headings are often functional labels: ADHD, Attention Deficit/Hyperactivity, Social Avoidance, Low Self-Worth, Perfectionism, Overthinking, Emotional Distress, Reduced Functioning. Read the whole problem block — name, LTGs, STGs, interventions — and use it to decide whether the session corresponds to an available problem or goal.

A heading that says ADHD while the diagnoses say generalized anxiety or depression is NOT by itself a mismatch and must NOT produce TREATMENT_PLAN_MISMATCH or SUPERVISOR_REVIEW. You are reviewing the peer's progress note, not auditing the treatment plan.

WHEN TO ESCALATE TO THE REVIEWER AS SUPERVISOR_REVIEW
Only for a genuine record-level problem that ordinary note correction cannot fix: the record is materially self-contradictory; no treatment-plan problem or goal reasonably corresponds to the work described; the fix truly requires changing a diagnosis or the treatment plan; the note itself explicitly relies on an undocumented diagnosis; or the clinical relationship cannot be determined from the record at all. A functional plan label differing from the diagnosis wording is never enough.

NARRATIVE-TO-GOAL REVIEW
The narrative, intervention, client response, problem, LTG and STG do not need identical wording. There must be a reasonable, understandable relationship among what happened, what the peer did, how the client responded, and which documented problem or goal was addressed. A session may address a single symptom, function, behaviour, skill, or recovery need — it need not touch every diagnosis or goal.

The note lists every problem on the client's plan and does not record which was selected for this session. Judge whether the narrative corresponds to AT LEAST ONE documented problem or goal. Do not guess at a selection that is not documented.

Return REOPEN_TO_PEER when the narrative matches none of the documented problems or goals, the intervention relates to no documented goal, the client response does not respond to the documented intervention, the documentation is too vague to identify the relationship, or the peer can fix the issue from what actually occurred.

CLIENT-RESPONSE REVIEW
The note must describe how the client participated, responded, reacted, practised, understood, benefited, struggled, made progress, declined, or resisted. Flag only a response so generic it could be pasted into any client's note.

OWNERSHIP OF CORRECTIONS
REOPEN_TO_PEER — the peer can correct the note from what actually happened.
SUPERVISOR_REVIEW — only per the escalation rule above.
DO_NOT_BILL — the documented facts establish the claimed service did not occur or cannot support the claimed delivery or billing method.

WORKED EXAMPLES
1. Diagnosis is generalized anxiety disorder. The session addresses focus, attention, organisation, planning, task completion, self-monitoring, and managing distractions, and the peer never calls it ADHD. Correct result: narrative ALIGNED, diagnosis alignment ALIGNED or PLAUSIBLY_RELATED, no unsupported diagnostic language, NOT SUPERVISOR_REVIEW. If that note is off-site on or after the effective date and carries no explicit off-site rationale, the only issue is the off-site rationale and the decision is REOPEN_TO_PEER.

2. A session spent painting affirmation stones, working on self-worth and self-acceptance, with a specific self-care intervention, a specific validation intervention, an individualised client response, and observable progress. Correct result: intervention SUFFICIENT, progress sufficiently documented, no missing-progress flag. The activity being well-suited to a garden does NOT establish an off-site rationale. If the explicit rationale is absent, that is the only issue and the decision is REOPEN_TO_PEER.

3. The intervention field lists Active Listening, Strengths-Based Approach and Coping Skills, and the activities section explains that the peer reviewed a task list, identified successful follow-through, explored what helped the client stay focused, reinforced realistic planning, reduced self-imposed pressure and encouraged prioritisation. Correct result: intervention SUFFICIENT, narrative and plan aligned, diagnosis alignment acceptable. If the date is before the off-site effective date, the off-site rules do not apply and the decision is PASS.

Do not produce a duplicate-related reopen message. Duplicate awareness is mechanical and the Reviewer adjudicates it; you are never shown a comparison note.`;

const DEFAULT_OFFSITE_PROMPT = `OFF-SITE SERVICE REVIEW (addendum)

EFFECTIVE DATE RULE
The note-level off-site rationale requirement applies to dates of service on or after ${OFFSITE_RATIONALE_FROM}. A note dated on or before 2026-07-27 must NOT be reopened for a missing rationale — for those notes set offsite_review.applicable to false and every off-site status field to NOT_APPLICABLE.

SERVICE-TYPE CLASSIFICATION
Classify the documented service as exactly one of:
- OFFSITE: the peer physically travelled to and met the client face-to-face at the client's home, school, or a community location.
- TELEHEALTH: the service occurred by phone or video.
- ONSITE: the client and peer met at the clinic or an approved agency location.
- POSSIBLE_SATELLITE: the agency appears to provide recurring scheduled services at the same outside location for multiple clients.
- UNABLE_TO_DETERMINE: the note does not clearly establish how or where the service occurred.

Classify from what the narrative actually describes, not only from the encounter type. A service coded as off-site whose narrative describes a phone or video contact is a contradiction you must report.

THE RATIONALE MUST BE EXPLICIT
For an off-site service dated on or after ${OFFSITE_RATIONALE_FROM}, the note must contain an explicit, individualised sentence giving the clinical or functional reason THIS client needed the service outside the clinic on THIS date. It must answer: "Why did this client need the service outside the clinic rather than at the clinic today?"

You must NOT infer the rationale from any of these, alone or together: the address; the stated location; the activity itself; the fact that an activity worked well in the community; the use of a garden, home, park, store, or community centre; the general usefulness of the natural environment; the client's preference; convenience; scheduling; or a general statement that peer services are community based. A setting-dependent activity is not a rationale.

A note can be excellent in every other respect and still require reopening because the explicit rationale is absent. This is common and expected — say so plainly rather than manufacturing additional criticisms.

The rationale needs no technical wording, but it must be direct and individualised. A sufficient one has the shape: "Because [client-specific symptom, barrier, functional need, or treatment goal], meeting at [type of location] was necessary to [specific purpose that could not be adequately addressed at the clinic]." Do not require that exact wording — require an explicit statement of why the clinic was not the appropriate setting for that client on that date.

Also required for an off-site note on or after the effective date: the type of location, the intervention provided, the client response, and a connection to a treatment-plan problem, goal, or objective.

INSUFFICIENT reasons: peer services are community based; the client prefers it; it was convenient; scheduling convenience; transportation convenience alone; the peer usually sees clients outside the clinic; another clinician provides home visits; program policy; supervisor instruction; all clients with this diagnosis are seen off-site.

POTENTIALLY ACCEPTABLE reasons, when actually documented: a symptom creating a current barrier to clinic attendance; a recent hospital, ER, or CPEP transition; a treatment goal requiring work in the natural environment; a functional or medical limitation; a specific home, school, vocational, or community skill needing in-context practice. Never assume one of these existed.

OFF-SITE DECISION RULES
PASS when the service was off-site and every required element, including the explicit rationale, is documented.
REOPEN_TO_PEER when the service was off-site, the date is on or after ${OFFSITE_RATIONALE_FROM}, and the explicit individualised rationale is missing or too general. When that is the ONLY problem with the note, the overall decision is REOPEN_TO_PEER and the reopen message addresses the rationale and nothing else.
NOT_APPLICABLE when the date is before ${OFFSITE_RATIONALE_FROM}, or the service is properly documented as on-site, or properly documented and coded as telehealth.
DO_NOT_BILL when a service identified or billed as off-site occurred only by phone or video, the client was a no-show, no face-to-face service occurred, only travel occurred, or the claimed off-site service is contradicted by the note.
SUPERVISOR_REVIEW when ongoing off-site service appears unsupported by the treatment plan, the setting may be a satellite site, the record is contradictory, or the correct classification cannot be determined.

Reopen wording for a missing rationale, adapted to the note: "Because this service occurred off-site on or after July 28, 2026, please add an explicit sentence explaining why this specific client needed the service outside the clinic rather than at the clinic on that date. Document the actual clinical or functional reason that applied. The location and activity alone do not establish the required off-site rationale."`;

// Fixed, non-editable: decision precedence + the exact output contract. Appended
// after both editable modules so operator edits can never break JSON parsing.
const REVIEW_OUTPUT_CONTRACT = `DECISION HIERARCHY
Identify EVERY issue, not only the first. Then set the single overall decision by this precedence:
1. DO_NOT_BILL
2. SUPERVISOR_REVIEW
3. REOPEN_TO_PEER
4. PASS

Example: a note with both a vague intervention the peer can fix AND a treatment-plan diagnosis mismatch has an overall decision of SUPERVISOR_REVIEW, and the issues array must contain both concerns.

Duplicate similarity plays no part in this decision. It is tracked mechanically and adjudicated by a human.

OUTPUT
Respond with ONE JSON object and nothing else. No markdown, no code fence, no prose before or after.

{
  "review_version": "${REVIEW_VERSION}",
  "decision": "PASS | REOPEN_TO_PEER | SUPERVISOR_REVIEW | DO_NOT_BILL",
  "confidence": "HIGH | MODERATE | LOW",
  "offsite_review": {
    "applicable": true,
    "service_type": "OFFSITE | TELEHEALTH | ONSITE | POSSIBLE_SATELLITE | UNABLE_TO_DETERMINE",
    "status": "PASS | FAIL | NOT_APPLICABLE | SUPERVISOR_REVIEW",
    "rationale_status": "PRESENT_SUFFICIENT | PRESENT_TOO_GENERAL | MISSING | UNSUPPORTED | NOT_APPLICABLE",
    "location_status": "SUFFICIENT | MISSING | UNCLEAR | NOT_APPLICABLE",
    "goal_connection_status": "SUFFICIENT | MISSING | UNCLEAR | NOT_APPLICABLE",
    "explanation": ""
  },
  "narrative_goal_alignment": {
    "status": "ALIGNED | PARTIALLY_ALIGNED | NOT_ALIGNED | UNABLE_TO_DETERMINE",
    "explanation": ""
  },
  "diagnosis_problem_alignment": {
    "status": "ALIGNED | PLAUSIBLY_RELATED | UNSUPPORTED_DIAGNOSTIC_LANGUAGE | TREATMENT_PLAN_MISMATCH | UNABLE_TO_DETERMINE",
    "explanation": ""
  },
  "intervention_response_review": {
    "intervention_status": "SUFFICIENT | NEEDS_REVISION | UNABLE_TO_DETERMINE",
    "response_status": "SUFFICIENT | NEEDS_REVISION | UNABLE_TO_DETERMINE",
    "explanation": ""
  },
  "issues": [
    {
      "code": "",
      "severity": "WARNING | REOPEN | SUPERVISOR | NONBILLABLE",
      "owner": "PEER | SUPERVISOR | BILLING | HUMAN_REVIEW",
      "source": "OFFSITE | NARRATIVE | GOAL | DIAGNOSIS | INTERVENTION | RESPONSE | TREATMENT_PLAN | SERVICE_TYPE",
      "explanation": "",
      "evidence_from_note": ""
    }
  ],
  "reopen_message_to_peer": "",
  "supervisor_message": "",
  "review_summary": ""
}

When decision is PASS: reopen_message_to_peer and supervisor_message must both be empty strings, and review_summary briefly explains why the note aligns.
When decision is REOPEN_TO_PEER: produce ONE concise reopen message addressed directly to the peer, covering ONLY actual deficiencies. Never pad it. Do not ask the peer to use more clinical language, to repeat information already clearly documented, to add a separate progress statement, to rewrite an intervention field that is already sufficient in context, to spell out a connection that is already reasonably apparent, to change a diagnosis or treatment plan, to invent facts, or to add an off-site reason that did not apply. If the only deficiency is a missing explicit off-site rationale, say that and nothing else.
When decision is SUPERVISOR_REVIEW: supervisor_message explains the record-level or treatment-plan-level concern and must not instruct the peer to repair the treatment plan. reopen_message_to_peer may still address separate peer-correctable issues.
When decision is DO_NOT_BILL: state the documented contradiction or nonbillable condition plainly, and never suggest wording that would conceal what occurred.

Every explanation must cite what the note actually says. Leave evidence_from_note empty rather than paraphrasing something the note does not contain.

LENGTH LIMITS (the response is truncated if you exceed them, which discards the whole review):
- Every "explanation" field: at most 2 sentences.
- "evidence_from_note": a short quoted fragment, at most 200 characters.
- "issues": at most 6 entries, most severe first. Merge related concerns rather than listing near-duplicates.
- "review_summary": at most 3 sentences.
- "reopen_message_to_peer" and "supervisor_message": at most 150 words each.
Be specific and brief. Do not restate the note back to the reviewer.`;

// Normalize a note's per-session narrative for bigram comparison: lowercase,
// collapse whitespace, and strip the client's own name parts (so two notes
// aren't matched just for sharing a patient name). Shared by the batch
// section comparison and the legacy full-note comparison.
function normContent(sessionContent, patientName) {
  let norm = (sessionContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const part of (patientName || '').toLowerCase().replace(',', ' ').split(' '))
    if (part.length > 2) norm = norm.split(part).join('');
  return norm;
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

// ── Section splitting ────────────────────────────────────────────────────────

// Split a full note into the five per-session narrative sections. Scans the
// labels IN ORDER, each search starting after the previous label, so a stray
// "Plan:" earlier in the narrative can't be mistaken for the real Plan header
// (3 of 324 stored notes contain a second "Plan:"). Each section ends where the
// next one begins; the last ends at the first SECTION_TERMINATOR.
// Returns { focus, activities, interventions, response, plan } — '' when absent.
function splitSections(text) {
  const out = {};
  for (const s of SECTION_LABELS) out[s.key] = '';
  if (!text) return out;

  const marks = [];
  let from = 0;
  for (const s of SECTION_LABELS) {
    // Escape the label, but let ',' and whitespace flex — InSync is inconsistent
    // about the comma in "What activities took place, and for how long?".
    const pattern = escapeRe(s.label).replace(/,/g, ',?').replace(/\\ |\s/g, '\\s+');
    const re = new RegExp(`${pattern}\\s*[:?\\-]\\s*`, 'ig');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) continue;
    marks.push({ key: s.key, start: m.index, valueStart: m.index + m[0].length });
    from = m.index + m[0].length;
  }
  if (!marks.length) return out;

  for (let i = 0; i < marks.length; i++) {
    let end;
    if (i + 1 < marks.length) {
      end = marks[i + 1].start;
    } else {
      const tail = text.slice(marks[i].valueStart);
      end = tail.length;
      for (const re of SECTION_TERMINATORS) {
        const mm = re.exec(tail);
        if (mm && mm.index > 0) end = Math.min(end, mm.index);
      }
      end += marks[i].valueStart;
    }
    out[marks[i].key] = text.slice(marks[i].valueStart, end).replace(/\s+/g, ' ').trim();
  }
  return out;
}

// Per-section bigram maps for one note, computed ONCE and reused across every
// comparison. Sections under DUPE_MIN_CHARS (normalised) are dropped, so they're
// skipped rather than scored.
function prepareSections(fullNoteText, patientName) {
  const secs = splitSections(fullNoteText);
  const prepared = {};
  for (const s of SECTION_LABELS) {
    if (!s.compared) continue;              // never prepare what we never compare
    const norm = normContent(secs[s.key], patientName);
    if (norm.length < DUPE_MIN_CHARS) continue;
    prepared[s.key] = { len: norm.length, map: bigramMap(norm) };
  }
  return prepared;
}

// Section-by-section similarity between two prepared notes. Corresponding
// sections only — focus vs focus, plan vs plan; never across types. Sections
// with compared:false (Peer Support Interventions) are skipped entirely: they
// are never scored, never returned, and never affect the overall percentage.
// Returns every compared section at >= DUPE_WEAK, highest first.
function compareSections(a, b) {
  const hits = [];
  for (const s of SECTION_LABELS) {
    if (!s.compared) continue;
    const x = a[s.key], y = b[s.key];
    if (!x || !y) continue;
    const ratio = bigramSimFromMaps(x.map, x.len, y.map, y.len);
    if (ratio >= DUPE_WEAK)
      hits.push({ key: s.key, label: s.label, substantive: s.substantive, pct: Math.round(ratio * 100), ratio });
  }
  return hits.sort((p, q) => q.ratio - p.ratio);
}

// The flag rule itself. Returns the qualifying hits, or null when the pair does
// not rise to "possible duplicate".
//   A. one SUBSTANTIVE section (Focus / Activities / Patient's Response) >= 90%
//   B. >= 2 COMPARED sections >= 80%, at least one of them substantive
// Plan can only ever be the second half of rule B.
function dupeVerdict(hits) {
  if (!hits.length) return null;
  const strongSubstantive = hits.find(h => h.substantive && h.ratio >= DUPE_STRONG);
  if (strongSubstantive) return { trigger: strongSubstantive, hits };
  if (hits.length >= DUPE_WEAK_MIN_SECTIONS) {
    const substantive = hits.filter(h => h.substantive);
    if (substantive.length) return { trigger: substantive[0], hits };
  }
  return null;
}

// ── Review payload extraction ────────────────────────────────────────────────

// Break the treatment-plan blob into one entry per documented problem. The note
// lists EVERY problem on the client's plan (2-8 of them, median 4) and does not
// record which was selected for this session — so all of them go to the AI and
// the prompt asks whether the narrative matches at least one.
function parseTreatmentPlan(tpText) {
  const text = (tpText || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const marks = [...text.matchAll(/\bProblem:\s*/gi)].map(m => m.index);
  if (!marks.length) return [];

  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : text.length);
    const head = /\bProblem:\s*(.+?)\s*\(Last Review Date:\s*([^,)]*)(?:,\s*Next Review Date:\s*([^)]*))?\)/i.exec(body);
    const grab = re => [...body.matchAll(re)].map(m => m[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
    out.push({
      problem:         head ? head[1].trim() : body.replace(/^Problem:\s*/i, '').slice(0, 120).trim(),
      last_review_date: head ? (head[2] || '').trim() : '',
      next_review_date: head ? (head[3] || '').trim() : '',
      ltg:             grab(/Long Term Goal\(s\)\s*\d*\s*:\s*(.+?)(?=\s*(?:Long Term Goal|Short Term Goal|Intervention\(s\)|Problem:)|$)/gi),
      stg:             grab(/Short Term Goal\(s\)\s*\d*\s*:\s*(.+?)(?=\s*(?:Long Term Goal|Short Term Goal|Intervention\(s\)|Problem:)|$)/gi),
      interventions:   grab(/Intervention\(s\)\s*\d*\s*:\s*(.+?)(?=\s*(?:Long Term Goal|Short Term Goal|Intervention\(s\)|Problem:)|$)/gi),
      // InSync notes carry no Objective field; null rather than a guess.
      objective:       null,
    });
  }
  return out;
}

// Coarse delivery method from the encounter-type string. The AI still classifies
// the service from the narrative — this is only what the note CLAIMS, so a
// mismatch between the two is visible to the reviewer.
function deliveryMethodOf(encounterType) {
  const t = String(encounterType || '').toLowerCase();
  if (t.includes('telehealth') || t.includes('video') || t.includes('audio')) return 'TELEHEALTH';
  if (t.includes('in the clinic') || t.includes('in-clinic')) return 'ONSITE';
  if (t.includes('outside the clinic') || t.includes('home') || t.includes('school')) return 'OFFSITE';
  if (t.includes('in-person') || t.includes('in person')) return 'IN_PERSON_UNSPECIFIED';
  return '';
}

// "MM/DD/YYYY" → "YYYY-MM-DD" so date comparisons are plain string compares.
function isoVisitDate(note) {
  const raw = note.visitDate || (note.visitDatetime || '').split(' ')[0] || '';
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
  return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : '';
}

// Everything in "Note of Session" BEFORE the first of the five sections —
// persons present, meeting location. Returns '' when there is no preamble.
function sessionPreamble(note) {
  const narrative = note.sessionNarrative || '';
  const m = /Focus of the meeting\s*[:?\-]/i.exec(narrative);
  return (m ? narrative.slice(0, m.index) : narrative).replace(/\s+/g, ' ').trim();
}

// The exact JSON handed to the model as the user message. Never includes another
// client's note, duplicate-partner text, or any comparison data.
function buildReviewPayload(note, machineFlags = []) {
  const secs = splitSections(note.fullNoteText || note.noteText || '');
  const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
  return {
    review_version:      REVIEW_VERSION,
    visit_date:          isoVisitDate(note),
    encounter_type:      note.encounterType || '',
    billing_or_rate_type: note.visitCodes || '',
    delivery_method:     deliveryMethodOf(note.encounterType),
    place_of_service:    note.pos || '',
    stated_duration:     note.totalTime || '',
    start_time:          note.startTimeStr || '',
    end_time:            note.endTimeStr || '',
    client_age:          note.age ?? null,
    note_sections: {
      focus:                   clip(secs.focus, 8000) || '',
      activities_and_duration: clip(secs.activities, 8000) || '',
      peer_interventions:      clip(secs.interventions, 8000) || '',
      patient_response:        clip(secs.response, 8000) || '',
      plan:                    clip(secs.plan, 4000) || '',
    },
    // Genuinely "other": the Note-of-Session preamble (persons present, meeting
    // location) that sits BEFORE the five sections. Sending the whole narrative
    // here would duplicate every section verbatim — doubling input tokens and
    // letting stale text contradict the section fields.
    other_session_narrative: clip(sessionPreamble(note), 2000) || '',
    // No labelled progress statement exists in these notes.
    progress_statement: null,
    diagnoses: (note.diagnosis || '')
      .split(/(?=\b[A-Z]\d{2}(?:\.\d+)?\s*-\s)/)
      .map(d => d.replace(/\s+/g, ' ').trim()).filter(Boolean),
    treatment_plan: { problems: parseTreatmentPlan(note.treatmentPlan) },
    mechanical_findings: machineFlags || [],
  };
}

// Everything that can change the review's outcome, hashed. Deliberately excludes
// volatile values (pull time, queue position, DB timestamps) so an unchanged note
// re-pulled produces an identical fingerprint and costs zero AI calls.
function reviewFingerprint(payload, corePrompt, offsitePrompt) {
  const h = str => crypto.createHash('sha256').update(String(str || '')).digest('hex');
  const material = {
    review_version:  REVIEW_VERSION,
    model:           REVIEW_MODEL,
    core_prompt:     h(corePrompt),
    offsite_prompt:  h(offsitePrompt),
    contract:        h(REVIEW_OUTPUT_CONTRACT),
    payload,
  };
  return h(stableStringify(material));
}

// Key-sorted JSON so an object built in a different key order still hashes the
// same — otherwise the fingerprint would churn for no reason.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// ── Review validation ────────────────────────────────────────────────────────

const DECISIONS   = ['PASS', 'REOPEN_TO_PEER', 'SUPERVISOR_REVIEW', 'DO_NOT_BILL'];
const CONFIDENCES = ['HIGH', 'MODERATE', 'LOW'];

// Strict schema check. Anything that fails becomes AI_REVIEW_ERROR — a malformed
// response must never be mistaken for a pass.
function validateReview(r) {
  const errs = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['response is not a JSON object'];
  if (!DECISIONS.includes(r.decision)) errs.push(`decision must be one of ${DECISIONS.join(' | ')}`);
  if (!CONFIDENCES.includes(r.confidence)) errs.push(`confidence must be one of ${CONFIDENCES.join(' | ')}`);
  for (const key of ['offsite_review', 'narrative_goal_alignment', 'diagnosis_problem_alignment', 'intervention_response_review'])
    if (!r[key] || typeof r[key] !== 'object' || Array.isArray(r[key])) errs.push(`${key} must be an object`);
  if (!Array.isArray(r.issues)) errs.push('issues must be an array');
  for (const key of ['reopen_message_to_peer', 'supervisor_message', 'review_summary'])
    if (typeof r[key] !== 'string') errs.push(`${key} must be a string`);
  return errs;
}

// Short human-readable line for the legacy `aiFlag` / `coherence` slot, so
// components that haven't been updated still show something meaningful.
function reviewSummaryFlag(review) {
  if (!review) return null;
  if (review.decision === 'AI_REVIEW_ERROR') return 'AI review error — response could not be parsed';
  if (!review.decision || review.decision === 'PASS') return null;
  return `${review.decision.replace(/_/g, ' ')}: ${review.review_summary || review.reopen_message_to_peer || review.supervisor_message || 'see review'}`;
}

class InsyncCoSignEngine {
  constructor({ username, password, anthropicKey, providerId, noSchoolStart, noSchoolEnd,
                coreReviewPrompt, offsitePrompt } = {}) {
    this.username      = username;
    this.password      = password;
    this.anthropicKey  = anthropicKey;
    this.providerId    = providerId || '2317';
    this.noSchoolStart = (noSchoolStart || '').trim() || DEFAULT_NO_SCHOOL_START;
    this.noSchoolEnd   = (noSchoolEnd   || '').trim() || DEFAULT_NO_SCHOOL_END;
    // Operator-editable (PS Settings tab); fall back to the shipped defaults.
    this.coreReviewPrompt = (coreReviewPrompt || '').trim() || DEFAULT_CORE_REVIEW_PROMPT;
    this.offsitePrompt    = (offsitePrompt    || '').trim() || DEFAULT_OFFSITE_PROMPT;
    this.jar           = new Map();
    // Per-instance AI request counter — asserted in verification. Incremented in
    // exactly one place (aiReview); the duplicate path never touches it.
    this.aiCallCount   = 0;
  }

  // The single static system prompt: both editable modules plus the fixed output
  // contract. Byte-identical for every note in a pull, which is what lets the
  // cache breakpoint below actually hit.
  systemPrompt() {
    return `${this.coreReviewPrompt}\n\n${this.offsitePrompt}\n\n${REVIEW_OUTPUT_CONTRACT}`;
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
    // Each treatment-plan problem is its own <li> — "<b>Name</b> (Last Review
    // Date: …)" — with that problem's goals/interventions in a nested <ul>. That
    // nesting is the only thing separating a problem name from the preceding
    // "Intervention(s) N:" value, and stripping tags below flattens it away,
    // gluing the two together ("Therapy Social Anxiety and …"). Label the problem
    // here, while the <b> still delimits the name exactly — which also keeps names
    // containing their own parentheses (e.g. "Nicotine Use (Vaping)") intact.
    const marked = html.replace(
      /<b>\s*([^<]+?)\s*<\/b>\s*(?=\(Last Review Date:)/gi,
      (_m, name) => `<b>Problem: ${name}</b> `
    );

    let text = marked
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
      // \b around the stop-labels so short ones (Age/POS/DOB) can't match
      // mid-word — e.g. "Age" inside "Language", which truncated Encounter Type.
      const re = new RegExp(escaped + String.raw`\s*[:\-]\s*(.*?)\s*(?:\b(?:${others.join('|')})\b|$)`, 'i');
      const m  = re.exec(text);
      return m ? m[1].trim() : '';
    };

    const totalTime = field('Total Time:');
    const startStr  = field('Start Time:');
    const endStr    = field('End Time:');
    const mrn       = field('MRN');
    // Full Encounter Type string to the next field label. The classification
    // keywords (audio/video/in-person) live at the END, so capture all of it —
    // field() stops at other stopLabels (POS/Visit Date/…), never at a dash.
    const encounterType = field('Encounter Type');

    let dur = null;
    let tm = /(\d+)\s*hr[s]?\s*(?:(\d+)\s*min[s]?)?/i.exec(totalTime);
    if (tm) { dur = parseInt(tm[1]) * 60 + parseInt(tm[2] || 0); }
    else { tm = /(\d+)\s*min[s]?/i.exec(totalTime); if (tm) dur = parseInt(tm[1]); }

    const sessionNarrative = this._section(text, 'Note of Session', ['Diagnosis','Plan / Visit Codes','Electronically Signed']);
    const sessionContent   = this._sessionContent(text);
    const diagnosis        = this._section(text, 'Diagnosis',        ['Plan / Visit Codes','Treatment Plan','Electronically Signed']);
    const treatmentPlan    = this._section(text, 'Treatment Plan',   ['Electronically Signed','Provider NPI']);
    // Place of service and the billed visit codes — context for the AI's
    // service-type classification, and for spotting a delivery/billing mismatch.
    const pos              = field('POS');
    const visitCodes       = this._section(text, 'Visit Codes',      ['Start Time','Treatment Plan','Electronically Signed','Provider NPI']);

    return {
      ...row,
      mrn,
      encounterType,
      pos, visitCodes,
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
    const dur  = note.durationMinutes;
    const type = String(note.encounterType || '').toLowerCase();
    console.log(`[PS enc-type] eid=${note.eid} dur=${dur} raw=${JSON.stringify(note.encounterType)}`);

    // ── Duration limit by encounter type (keyword match, keywords at END) ──
    const hasVideo = type.includes('video') || type.includes('visual');
    const hasAudio = type.includes('audio'); // audio-only = audio and NOT video/visual
    const inPerson = type.includes('in-person') || type.includes('in person') || type.includes('in the clinic');

    if (hasVideo) {
      if (dur && dur > VIDEO_LIMIT_MINS)
        flags.push(`Telehealth video session over ${VIDEO_LIMIT_MINS} min (${note.totalTime})`);
    } else if (hasAudio) {
      if (dur && dur > AUDIO_LIMIT_MINS)
        flags.push(`Telehealth audio-only session over ${AUDIO_LIMIT_MINS} min (${note.totalTime})`);
    } else if (inPerson) {
      if (dur === INPERSON_HARD_MINS)
        flags.push('3-hour session — permitted only in severe circumstances');
      else if (dur && dur > INPERSON_SOFT_MINS)
        flags.push('Session exceeds the preferred 2.5-hour maximum — verify justification');
    } else {
      // Blank or unclassifiable encounter type.
      flags.push('Encounter type not recognized — verify duration limit manually');
    }

    // ── Minor + extended session (high priority) ──
    const isMinor = note.age !== null && note.age !== undefined && note.age < 18;
    if (isMinor && dur && dur > MINOR_EXTENDED_MINS)
      flags.push('HIGH PRIORITY: Extended session with a minor — requires justification');

    // ── Minor during school hours ──
    if (isMinor && note.visitDateObj) {
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

  // ── Duplicate awareness (mechanical) ────────────────────────────────────────

  // Build the reusable comparison entry for one note. Call this ONCE per note
  // per pull; findDupe() then compares prepared entries without recomputing.
  prepareDupeEntry(note) {
    return {
      eid:         note.eid,
      patientName: note.patientName || '',
      visitDate:   note.visitDate || (note.visitDatetime || '').split(' ')[0] || '',
      mrn:         note.mrn || '',
      secs:        prepareSections(note.fullNoteText || note.noteText || '', note.patientName),
    };
  }

  // Is `note` a possible duplicate of anything in `corpus`? Section-scoped,
  // corresponding-section-only, and entirely mechanical — this method makes NO
  // network calls of any kind. Returns the strongest match or null.
  // `corpus` items come from prepareDupeEntry().
  findDupe(note, corpus) {
    const mine = prepareSections(note.fullNoteText || note.noteText || '', note.patientName);
    if (!Object.keys(mine).length) return null;

    let best = null;
    for (const c of corpus) {
      if (!c || !c.secs || c.eid === note.eid) continue;
      const verdict = dupeVerdict(compareSections(mine, c.secs));
      if (!verdict) continue;
      if (!best || verdict.trigger.ratio > best.verdict.trigger.ratio) best = { c, verdict };
    }
    if (!best) return null;

    const { c, verdict } = best;
    const who  = c.mrn ? `MRN ${c.mrn}` : (c.patientName || 'another client');
    const when = c.visitDate || 'an earlier date';
    return {
      partnerEid: c.eid,
      pct:        verdict.trigger.pct,
      reason:     `Possible duplicate: ${verdict.trigger.label} is ${verdict.trigger.pct}% similar to ${who} from ${when}.`,
      sections:   verdict.hits.map(h => ({ label: h.label, pct: h.pct })),
      status:     'POSSIBLE_DUPLICATE',
    };
  }

  // ── AI review (exactly one request per note version) ────────────────────────

  // The complete Peer Note QA review: narrative, intervention, client response,
  // treatment-plan alignment, diagnosis alignment, service type, and off-site
  // rationale — all in ONE call. Never sees a comparison note.
  //
  // Returns the validated review object, or an AI_REVIEW_ERROR record. Callers
  // must treat AI_REVIEW_ERROR as "needs human attention", never as a pass.
  async aiReview(note, machineFlags = []) {
    if (!this.anthropicKey || !(note.fullNoteText || note.noteText)) return null;

    const payload = buildReviewPayload(note, machineFlags);
    const anthropic = new Anthropic({ apiKey: this.anthropicKey });

    const base = {
      review_version: REVIEW_VERSION,
      model:          REVIEW_MODEL,
      reviewed_at:    new Date().toISOString(),
      fingerprint:    reviewFingerprint(payload, this.coreReviewPrompt, this.offsitePrompt),
      prompt_hashes: {
        core:    crypto.createHash('sha256').update(this.coreReviewPrompt).digest('hex').slice(0, 16),
        offsite: crypto.createHash('sha256').update(this.offsitePrompt).digest('hex').slice(0, 16),
      },
    };

    let msg;
    try {
      this.aiCallCount++;                       // the ONLY place this increments
      msg = await anthropic.messages.create({
        model: REVIEW_MODEL,
        max_tokens: REVIEW_MAX_TOKENS,
        // Static instructions only — the cache breakpoint. Note data lives in
        // the user message, so this prefix is byte-identical across notes.
        system: [{
          type: 'text',
          text: this.systemPrompt(),
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      });
    } catch (err) {
      return { ...base, decision: 'AI_REVIEW_ERROR', error: `AI request failed: ${err.message}`, raw_response: '' };
    }

    this.lastUsage = msg.usage || null;         // surfaced for cache verification

    const rawText = (msg.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // Defensively strip a single outer markdown fence, nothing more.
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ...base, decision: 'AI_REVIEW_ERROR',
               error: 'AI response could not be parsed or validated.', raw_response: rawText };
    }

    const errs = validateReview(parsed);
    if (errs.length) {
      return { ...base, decision: 'AI_REVIEW_ERROR',
               error: `AI response could not be parsed or validated. (${errs.join('; ')})`,
               raw_response: rawText };
    }

    // No automatic repair call — one review means one request.
    return {
      ...base,
      decision:   parsed.decision,
      confidence: parsed.confidence,
      offsite_review:              parsed.offsite_review,
      narrative_goal_alignment:    parsed.narrative_goal_alignment,
      diagnosis_problem_alignment: parsed.diagnosis_problem_alignment,
      intervention_response_review: parsed.intervention_response_review,
      issues:                 Array.isArray(parsed.issues) ? parsed.issues : [],
      reopen_message_to_peer: parsed.reopen_message_to_peer || '',
      supervisor_message:     parsed.supervisor_message || '',
      review_summary:         parsed.review_summary || '',
      usage: msg.usage ? {
        input_tokens:                msg.usage.input_tokens,
        output_tokens:               msg.usage.output_tokens,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
        cache_read_input_tokens:     msg.usage.cache_read_input_tokens,
      } : null,
    };
  }

  // Fingerprint for a note WITHOUT making any request — used to decide whether a
  // stored review can be reused.
  fingerprintFor(note, machineFlags = []) {
    return reviewFingerprint(buildReviewPayload(note, machineFlags), this.coreReviewPrompt, this.offsitePrompt);
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

  // ── Incremental ingest seams ──────────────────────────────────────────────────

  // Download only: fetch the co-sign queue rows and load each note's content.
  // NO judging, NO field stripping — the ingest orchestrator (utils/psIngest.js)
  // decides what's new/revised and judges just those. Caller must login() first.
  // `dates` (optional) is a Set of MM/DD/YYYY keys — see dateKeyOf. When given,
  // rows outside those dates are dropped BEFORE loadNote, which is the whole
  // point: loading a note costs three round-trips to InSync, so filtering the
  // cheap listing is what makes a one-day pull fast.
  async fetchNotes(onProgress, { dates = null } = {}) {
    const report = (m, p) => { if (onProgress) onProgress(m, p); };
    let rows = await this.fetchAllPages(report);
    if (dates && dates.size) rows = rows.filter(r => dates.has(dateKeyOf(r)));
    const total = rows.length;
    const notes = [], cantLoad = [];
    for (let i = 0; i < rows.length; i++) {
      if (i % 3 === 0) report(`Loading note ${i + 1} of ${total}...`,
        Math.min(20 + Math.floor((i / Math.max(total, 1)) * 55), 78));
      const note = await this.loadNote(rows[i]);
      if (note) notes.push(note);
      else cantLoad.push({
        ...rows[i],
        visitDate: rows[i].visitDatetime ? rows[i].visitDatetime.split(' ')[0] : '',
      });
    }
    return { notes, cantLoad };
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

    // Duplicate awareness is MECHANICAL — zero AI calls. Prepare every note's
    // section bigrams once, then compare each note against the others.
    report('Comparing note sections for possible duplicates...', 58);
    const prepared = notes.map(n => this.prepareDupeEntry(n));
    const dupes = {};
    for (let i = 0; i < notes.length; i++) {
      const hit = this.findDupe(notes[i], prepared.filter((_, j) => j !== i));
      if (hit) dupes[notes[i].eid] = hit;
    }

    // The AI review runs on EVERY note, once — a possible duplicate never
    // suppresses it. Flags accumulate: a note can carry a machine flag AND a
    // duplicate flag AND an AI decision at once. "Clean" means nothing flagged it.
    report('Running QA review...', 64);
    const flagged = [...cantLoad];
    const clean   = [];
    const n = notes.length;

    for (let i = 0; i < n; i++) {
      const note    = notes[i];
      const machineFlags = this.checkNote(note);       // deterministic: duration / minor
      const flags   = [...machineFlags];
      const dupe    = dupes[note.eid] || null;
      if (dupe) flags.push(dupe.reason);

      let review = null;
      if (this.anthropicKey) {
        report(`AI QA review ${i + 1} of ${n}...`, 64 + Math.floor((i / n) * 34));
        review = await this.aiReview(note, machineFlags);
        await sleep(80);
      }
      const aiFlag = reviewSummaryFlag(review);

      if (flags.length || aiFlag) {
        flagged.push({
          ...note, flags, aiFlag, review,
          clonePartnerEid: dupe?.partnerEid ?? null,
          clonePct:        dupe?.pct ?? null,
          cloneSections:   dupe?.sections ?? null,
        });
      } else {
        clean.push({ ...note, aiFlag: null, review });
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

module.exports = {
  InsyncCoSignEngine,
  DEFAULT_CORE_REVIEW_PROMPT,
  DEFAULT_OFFSITE_PROMPT,
  REVIEW_VERSION,
  OFFSITE_RATIONALE_FROM,
  dateKeyOf,
  // exported for unit testing of the mechanical duplicate path
  splitSections, prepareSections, compareSections, dupeVerdict,
};
