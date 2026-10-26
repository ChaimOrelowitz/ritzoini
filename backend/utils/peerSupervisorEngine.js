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

// ── Top-level heading detection ──────────────────────────────────────────────
//
// Every section in a note ends where the NEXT recognised heading begins. One
// detector serves all three parsers (splitSections, _sessionContent, _section),
// so a boundary fixed for one field is fixed for all of them.
//
// The hard constraint is that the runtime input has NO LINE STRUCTURE. _parseNote
// strips tags and collapses whitespace (`.replace(/\s+/g,' ')`), so a real note
// arrives as one ~8,000-character line: "...skills he has developed. Diagnosis
// F90.2 - Attention-deficit...". Nothing can anchor to "start of line" there.
// So a heading is recognised in any of three contexts:
//
//   (a) STANDALONE LINE — "Diagnosis", "  Diagnosis  ", "* Diagnosis:"
//   (b) MARKDOWN BOLD   — "**Diagnosis**", "**Diagnosis:**"
//   (c) FLAT TEXT       — the runtime case, where the only remaining signals are
//       the label's own capitalisation plus what follows it.
//
// (a) and (b) are matched case-insensitively. (c) CANNOT be: in flattened text
// "Plan:" the heading and "his plan and finished" the noun are distinguishable
// only by case, and treating narrative words as headings is the exact failure
// this parser must never have. So the flat rule requires the canonical casing,
// a word boundary, and then either a colon, or — for the handful of headings
// InSync genuinely emits without one — content that starts like content
// (capital, digit, bullet, bracket) rather than a lower-case continuation.
const NOTE_HEADINGS = [
  // Longest-first: "Plan / Visit Codes" and "Treatment Plan" must win over the
  // bare "Plan" they contain.
  // `question` — InSync emits this label as a literal question and ends it with
  // a "?", never a colon: "…and for how long?</span></label>". Scoped to this
  // label deliberately — accepting a bare "?" terminator for every label would
  // let narrative like "what was the plan?" register as a Plan heading. This
  // phrase is long and distinctive enough never to be prose.
  { label: 'What activities took place, and for how long', question: true },
  // Offsite form only. Optional like every heading — a note without it simply
  // never matches — so the regular form parses exactly as before.
  { label: 'Justification for Offsite Delivery' },
  { label: 'Location of the Meeting' },
  // The Offsite form's wording of the same field (no "the").
  { label: 'Location of Meeting' },
  { label: 'Electronically Signed', colonless: true, anywhere: true },
  { label: "Patient's Response/Content" },
  { label: 'Plan / Visit Codes',     colonless: true },
  { label: 'Peer Support Interventions' },
  { label: 'Focus of the meeting' },
  { label: 'Encounter Details',      colonless: true },
  { label: 'Treatment Plan',         colonless: true },
  { label: 'Patient Details',        colonless: true },
  { label: 'Note of Session',        colonless: true },
  { label: 'Persons Present' },
  { label: 'Visit Details',          colonless: true },
  { label: 'Encounter Type' },
  { label: 'Provider NPI',           colonless: true },
  { label: 'Visit Codes',            colonless: true },
  { label: 'Total Time' },
  { label: 'Start Time' },
  { label: 'Visit Date' },
  { label: 'Diagnosis',              colonless: true },
  { label: 'End Time' },
  { label: 'Address' },
  { label: 'E-mail' },
  { label: 'Phone' },
  { label: 'Plan' },
  { label: 'Name' },
  { label: 'DOB' },
  { label: 'Age' },
  { label: 'MRN' },
  { label: 'POS' },
];

// The label as a regex body: escaped, but with whitespace and the optional comma
// left flexible — InSync is inconsistent about the comma in "What activities
// took place, and for how long?".
function headingBody(label) {
  return escapeRe(label).replace(/,/g, ',?').replace(/\\ |\s/g, '\\s+');
}

// Any literal phrase, matched across whatever whitespace separates its words —
// needed once the text keeps line breaks, since a phrase like "Save as Draft"
// can now straddle one.
function loosePhrase(phrase, flags = '') {
  return new RegExp(escapeRe(phrase).replace(/\\ |\s/g, '\\s+'), flags);
}

// Block-level elements. InSync wraps every heading in one — the Diagnosis
// heading is `<td class='report_subheader'><b><a…>Diagnosis</a></b></td>`,
// Treatment Plan is `<li><b>Treatment Plan</b>`, and narrative text sits inside
// a `<span>` — so turning these into line breaks puts each real heading on its
// own line while leaving prose (and any heading word inside it) mid-line.
const BLOCK_TAGS = 'address|article|aside|blockquote|br|caption|dd|div|dl|dt|fieldset'
  + '|figcaption|figure|footer|form|h[1-6]|header|hr|label|li|main|nav|ol|p|pre'
  + '|section|table|tbody|td|tfoot|th|thead|tr|ul';

// HTML → text WITH the document's line structure intact. Inline tags become a
// space (as before); block tags become a newline. Spaces and tabs are collapsed,
// newlines are not — so `structuredText.replace(/\s+/g,' ')` reproduces exactly
// the flat text this parser used to produce.
function htmlToStructuredText(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(new RegExp(`<\\s*/?\\s*(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\S\n]+/g, ' ')        // collapse spaces/tabs, keep newlines
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

// Every position in `text` where a recognised heading actually sits, in document
// order, non-overlapping. Each entry is { label, start, valueStart } — `start` is
// where the heading begins (where the PREVIOUS section must end) and `valueStart`
// is where this section's content begins (after the heading and its punctuation).
function findHeadings(text) {
  if (!text) return [];
  // Line structure is the reliable signal, so use it whenever it survived. Only
  // text that has already been flattened — every note stored before the parser
  // kept line breaks — falls back to the casing heuristics.
  const structuredInput = /\n/.test(text);
  const hits = [];

  for (const { label, colonless, anywhere, question } of NOTE_HEADINGS) {
    const body = headingBody(label);

    if (structuredInput) {
      // (a) LINE-ANCHORED. A heading owns the start of its line — after an
      // optional bullet or bold marker — and then either carries a colon, is
      // alone on the line, or is one of the labels InSync writes bare. The
      // trailing `*` is InSync's required-field marker ("Plan: *").
      // This is what makes "The client stated: Plan: continue…" safe: that
      // "Plan:" is mid-line, so it is prose, not a boundary.
      const line = new RegExp(
        `(?:^|\\n)[ \\t]*(?:[*+\\-•][ \\t]+)?(?:\\*\\*)?[ \\t]*(?:${body})(?:\\*\\*)?`
        + (question ? '[ \\t]*\\??' : '')
        + `(?:[ \\t]*:[ \\t]*(?:\\*(?!\\*))?[ \\t]*` + (colonless || anywhere ? `|[ \\t]*(?=\\n|$)|[ \\t]+` : `|[ \\t]*(?=\\n|$)`) + `)`,
        'gi');
      for (let m; (m = line.exec(text)) !== null; ) {
        const lead = /^\s*(?:[*+\-•][ \t]+)?/.exec(m[0])[0].length;
        hits.push({ label, start: m.index + lead, valueStart: m.index + m[0].length, len: label.length });
        if (m.index === line.lastIndex) line.lastIndex++;
      }
    }

    // (b) MARKDOWN BOLD, anywhere — "**Diagnosis**" is never ordinary prose.
    const bold = new RegExp(`\\*\\*[ \\t]*(?:${body})[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?`, 'gi');
    for (let m; (m = bold.exec(text)) !== null; ) {
      hits.push({ label, start: m.index, valueStart: m.index + m[0].length, len: label.length });
      if (m.index === bold.lastIndex) bold.lastIndex++;
    }

    // (c) FLAT-TEXT FALLBACK — legacy input only, where casing is all that is
    // left to tell "Plan:" the heading from "his plan and finished" the noun.
    //   `colonless` — InSync writes it bare, so accept it when what follows
    //     starts like content (capital / digit / bullet / bracket).
    //   `anywhere`  — distinctive enough never to be narrative. "Electronically
    //     Signed" needs this: it is always followed by a lower-case "by …".
    if (!structuredInput) {
      const flat = new RegExp(
        `(?<![A-Za-z])(?:${body})[ \\t]*:`
        + (anywhere ? `|(?<![A-Za-z])(?:${body})(?![A-Za-z])` : '')
        + (colonless && !anywhere ? `|(?<![A-Za-z])(?:${body})(?=\\s+[A-Z0-9*\\[•])` : '')
        + (question ? `|(?<![A-Za-z])(?:${body})[ \\t]*\\?` : ''),
        'g');
      for (let m; (m = flat.exec(text)) !== null; ) {
        hits.push({ label, start: m.index, valueStart: m.index + m[0].length, len: label.length });
        if (m.index === flat.lastIndex) flat.lastIndex++;
      }
    }
  }

  // Document order; at the same position the longest label wins ("Treatment
  // Plan" over "Plan"). Then drop anything overlapping an already-kept heading.
  hits.sort((a, b) => a.start - b.start || b.len - a.len);
  const out = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && h.start < prev.valueStart) continue;
    out.push(h);
  }
  return out;
}

// A section's text, given where its content starts and where the next heading is.
// Strips leading bullets/markdown, collapses the whitespace _parseNote left, and
// trims — the content itself is untouched.
function headingValue(text, valueStart, end) {
  return text.slice(valueStart, end)
    .replace(/^[\s:]*(?:\*\*)?[\s]*(?:[*+\-•][ \t]+)?/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
const OFFSITE_RATIONALE_FROM = '2026-10-01';
// Telehealth location/setting rule starts with dates of SERVICE on/after this date.
const TELEHEALTH_LOCATION_FROM = '2026-10-15';
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

const DEFAULT_CORE_REVIEW_PROMPT = `You are the documentation reviewer for Peer Support progress notes at LINKS Mental Health Center.

Notes you PASS go straight to the clean stack with no further human review. Notes you flag go to one human operator, the Reviewer, who decides whether to return them to the peer. Nothing is returned automatically. Your job is to identify real, actionable documentation problems in the PEER'S NOTE using the QA checks below.

These checks come from the Peer Program's supervisor documentation review guidance. They are a practical guide, not a rigid checklist. Use judgment. The aim is clear, individualized documentation of what actually occurred.

Evaluate ONLY what is documented in the material you are given.

NEVER invent symptoms, diagnoses, interventions, client responses, service details, progress, locations, or reasons for a service.

NEVER instruct a peer to add something merely to make a note billable. Every correction must reflect what actually occurred.

==================================================
WHAT YOU ARE GIVEN
==================================================

The payload typically includes: client header (name, address), visit date, encounter type, POS, start/end/total time, persons present, location of the meeting, focus, activities and duration, peer support interventions, patient's response, plan, diagnosis list, visit codes with duration and units, and the treatment plan.

TRUST THE FIELDS:
- Never call a populated field blank or missing.
- Only treat a field as missing when its value is empty, null, or contains no meaningful content. Placeholder values such as "N/A" are not meaningful content.
- Content documented in one section does not need to be repeated in another. Read Focus, Activities, Interventions, and Response together before judging any check.
- Do not use the Plan as evidence of what happened during the current session. The Plan is prospective.

==================================================
QA CHECKS
==================================================

1. CLEAR - Can you tell what the peer and client actually did?
The note does not need to sound clinical or impressive. It needs enough concrete detail to picture the encounter.
Flag for return when the encounter is described only in general terms and you cannot tell what actually happened.

2. SPECIFIC - Do you know what was going on with this client today?
There should be at least one actual situation, task, person, or example from the client's life, not only a general topic.
Flag for return when the note discusses a topic (for example "communication," "coping," "self-advocacy," "organization") without naming any real situation or example the client brought or worked on.

3. CLIENT-DRIVEN - Can you hear the client's needs and choices?
Look for what the client wanted help with, found difficult, chose, tried, liked or disliked, or wanted to do differently.
Flag for return when the note reads like a preplanned lesson delivered to the client. Warning signs: the peer "discussed the importance of," "explored," "reviewed," or "encouraged the client to consider," with no client input, choice, or example anywhere.

4. RESPONSE - Do you know what the client actually said or did?
Response documented anywhere in the note counts. Quotes are helpful only when actually said.
Flag for return when the client's response is limited to statements such as "participated," "was engaged," "showed improvement," "understood," "was receptive," or "was encouraged to," with no observable statement, choice, action, or reaction. Ask: how do we know?
Struggle, refusal, disagreement, and lack of progress are valid responses when described.

5. MATCH - Does everything make sense together?
The activity, client need, selected intervention, and client response should align.
Flag for return when the selected intervention is not demonstrated anywhere in the note.
- Short intervention labels are acceptable when the note shows the intervention happened.
- An intervention explained in the Peer Support Interventions field does not need to be repeated in Activities.
- Not every treatment-plan intervention needs to occur in every session.

6. TIME - Does the documentation reasonably support the session length?
Especially for two- to three-hour sessions, ask: what were they actually doing that took this long?
Flag for return when the content is too general to account for the documented duration.
Do NOT require artificial time blocks or extra activities merely to fill time. Timed activity blocks filled with general topic language do not by themselves support the duration.

7. NEXT - Is there something real to follow up on?
Ideally the client leaves with something specific to try, practice, or notice before the next session.
When the Plan contains nothing specific to this client (only boilerplate such as "continue supporting," "identify an opportunity," "future sessions will focus on"), log a WARNING issue.
NEXT alone never changes the decision. Include it in the reopen message only when the note is already being returned for another reason.
The Plan may describe a different activity, a different goal, or another session later the same day. That is not an issue.

8. PEER SCOPE - Is this recognizably peer support?
The note should show a peer-support role in which the peer works with the client rather than acting as expert, therapist, authority, or decision-maker.

Recognizable peer activities include: self-advocacy practice, problem-solving, skill practice, coping-skill practice, resource connection, community participation, recovery planning, sharing relevant lived experience, and transition support.

Flag for return when:
- the peer role cannot be identified, OR
- the peer's own text includes psychotherapy, clinical interpretation, diagnostic impressions, or the peer's own judgment about symptom severity, risk, motivation, or level of care.

A client reporting their own mood, motivation, or difficulty is fine. The peer clinically assessing it is not.

For walks, shopping, games, meals, transportation, appointments, or general conversation, the note must explain how the activity supported the client's goal, what the peer specifically did, and what the client said or did.

9. NEED - Is there a reasonable relationship between the work and the client's documented needs?
Use ordinary common sense. Do NOT require diagnosis-to-symptom bridge sentences such as "because of his anxiety."
Functional work such as focus, organization, planning, task initiation, follow-through, avoidance, overwhelm, decision-making, communication, social participation, confidence, emotional regulation, or daily functioning may reasonably relate to anxiety, depression, and many other documented needs.
Only flag when the work is genuinely unrelated to any documented diagnosis or treatment-plan need and a connection would require speculation.

==================================================
DIAGNOSTIC LANGUAGE
==================================================

Functional language is acceptable: "had difficulty focusing," "became distracted," "had trouble starting tasks," "needed reminders," "felt overwhelmed."

Do NOT convert functional language into an implied diagnosis.

Flag UNSUPPORTED_DIAGNOSTIC_LANGUAGE only when the PEER'S OWN TEXT (Focus, Activities, Interventions, Response, Plan) presents a diagnosis or disorder that is NOT on the diagnosis list as an established condition.
Example: diagnosis list has GAD only; the peer writes "his ADHD caused the difficulty."

This rule does not apply to diagnostic wording that appears only inside the treatment plan.

If every diagnosis the peer names is on the diagnosis list, diagnosis_problem_alignment must NOT be UNSUPPORTED_DIAGNOSTIC_LANGUAGE.

==================================================
TREATMENT PLAN - SUPPORTING CONTEXT ONLY
==================================================

You are reviewing the peer's note, not auditing the treatment plan.

Use treatment-plan problems and goals only as evidence of the client's documented needs.

Treatment-plan content must NEVER itself create an issue. Specifically:
- Never compare treatment-plan problem or goal wording against the diagnosis list.
- Never flag a blank, missing, incomplete, or mismatched treatment plan.
- Never recommend changing a treatment plan, diagnosis, or goal.
- Never use TREATMENT_PLAN_MISMATCH or source TREATMENT_PLAN.
- Never return SUPERVISOR_REVIEW for any treatment-plan reason.

==================================================
PROGRESS
==================================================

There is no required separate Progress field. progress_statement may be null.
Never flag a missing Progress heading or a missing separate progress sentence.
Progress does not have to be positive.

==================================================
INTERNAL CONSISTENCY
==================================================

Flag genuine contradictions within the note, for example:
- one section says the client attended and another says the client was a no-show
- mutually exclusive descriptions of what occurred
- clearly wrong client name, pronoun, or content belonging to another client

Do NOT flag merely because:
- the session occurred in the evening
- the location is unusual but plausible
- another session is planned later the same day
- the Plan differs from the current session
- an activity could also have happened at the clinic

Service type, location, POS, modifiers, units, off-site rationale, and telehealth requirements are governed by the Service-Type and Location Addendum sent in the same request.

==================================================
POSSIBLE SERVICE-DELIVERY DISCREPANCIES
==================================================

Some problems are not documentation quality issues. They suggest the service may not have occurred as documented.

Use SUPERVISOR_REVIEW when the material you are given shows, for example:
- the documented encounter did not happen
- the service occurred in a different format (phone, telehealth, in-person) or location than documented, and this is more than an isolated wording error
- impossible time: overlapping sessions, more service time than could reasonably occur, or the client or peer documented as elsewhere
- the client was hospitalized, incarcerated, discharged, or otherwise unavailable at the time of service
- dates, times, duration, location, or content appear altered to support billing
- activities, statements, or progress that directly conflict with other information in the record

For these:
- Report the concern factually in supervisor_message: what the note says, what conflicts with it, and where it appears.
- NEVER use the words "fraud," "falsified," "fabricated," or similar labels. Do not determine intent.
- reopen_message_to_peer must be an empty string. Do not ask anyone to rewrite or delete the record.

A vague note, missing detail, wrong intervention selection, isolated copy-and-paste error, or poor wording is a documentation issue, not a service-delivery discrepancy. Flag those for return to the peer.

==================================================
DUPLICATES
==================================================

Comparison with the peer's other notes is handled mechanically on import. Do not compare against other notes or create copy-and-paste suspicions based on structure alone.

==================================================
DECISIONS
==================================================

PASS - No issue that requires correction. WARNING-only issues still PASS.

REOPEN_TO_PEER - A problem the peer can correct based on what actually occurred. This includes every QA check failure, unsupported diagnostic language, internal contradictions, and every failure under the Service-Type and Location Addendum.

SUPERVISOR_REVIEW - Only for possible service-delivery discrepancies as defined above. Never for anything the peer can correct, and never for treatment-plan reasons.

DO_NOT_BILL - Only when the note itself establishes that the billed service did not occur (for example, the note documents a no-show or cancellation) or cannot support the billed delivery method.

==================================================
REOPEN MESSAGE - FORMAT
==================================================

reopen_message_to_peer contains ONLY Problem/Solution pairs:

Problem: [one concise sentence stating the issue, citing what the note says]
Solution: [one concise sentence stating the correction]

Separate pairs with a blank line.

- No greeting, introduction, praise, summary, or closing.
- No explanation of what was done correctly.
- Never ask the peer to invent facts or change facts to match billing.
- Never include internal labels: SUPERVISOR_REVIEW, REOPEN_TO_PEER, DO_NOT_BILL, reviewer, supervisor, billing hold, confidence.

Use this wording for the Solution line when it fits:

Specificity: Please clarify what specifically happened during this part of the encounter and provide an actual example.
Client response: Please clarify what the client actually said or did in response, rather than only stating that the client was engaged or improved.
Duration: Please clarify what occurred during the encounter that supports the documented duration.
Intervention mismatch: Please review the selected intervention. I do not see how [intervention] is demonstrated in the note.
Client-driven: Please clarify what the client wanted help with, chose, or tried during the session.
Next step: Please document the specific thing the client chose to try, practice, or notice before the next session.
Peer scope: Please describe what you and the client did together, without clinical interpretation or assessment.

==================================================
ISSUES ARRAY
==================================================

- Each issue describes one actual defect. No praise.
- Merge different descriptions of the same underlying problem into one issue.
- If your analysis concludes no flag is warranted, do not create the issue and do not assign a negative status.
- Use descriptive issue codes such as NOT_SPECIFIC, NOT_CLIENT_DRIVEN, RESPONSE_GENERIC, INTERVENTION_NOT_DEMONSTRATED, DURATION_NOT_SUPPORTED, NEXT_STEP_MISSING, PEER_SCOPE, UNSUPPORTED_DIAGNOSTIC_LANGUAGE, INTERNAL_CONTRADICTION, OFFSITE_RATIONALE, TELEHEALTH_LOCATION, TELEHEALTH_SETTING, POS_MISMATCH, MODIFIER_MISMATCH, UNITS_MISMATCH, SERVICE_DISCREPANCY.
- Map source to the closest existing value: NARRATIVE (clear, specific, client-driven, time, next, peer scope, consistency), RESPONSE, INTERVENTION, GOAL, DIAGNOSIS, OFFSITE, SERVICE_TYPE (telehealth, POS, modifier, units, service discrepancy).

==================================================
CALIBRATION
==================================================

Do not manufacture issues. When you are genuinely uncertain whether something is wrong, do not flag it.

But an entirely generic note is not an uncertain case. Topic-only activities, "was encouraged to" responses, and boilerplate plans are exactly what this review exists to catch.

==================================================
WORKED EXAMPLES
==================================================

EXAMPLE 1 - FUNCTIONAL WORK, NO BRIDGE SENTENCE
Diagnosis: GAD. The note documents the client choosing two overdue tasks, breaking one into steps with the peer, and finishing it.
Result: Do not require "because of anxiety." PASS if otherwise sufficient.

EXAMPLE 2 - UNSUPPORTED ADHD
Diagnosis: GAD only. Peer writes "his ADHD symptoms caused the difficulty."
Problem: The note attributes the difficulty to ADHD, but ADHD is not a documented diagnosis.
Solution: Replace the ADHD reference with functional language describing the actual difficulty.

EXAMPLE 3 - ADHD ONLY IN TREATMENT PLAN
Diagnosis list has no ADHD; the treatment plan has an ADHD problem; the peer's note does not mention ADHD.
Result: No issue.

EXAMPLE 4 - INTERVENTION ONLY IN INTERVENTIONS FIELD
Interventions field: "Sleep Hygiene: reviewed the client's bedtime routine; he chose to put his phone in the kitchen at 11pm." Activities does not mention sleep.
Result: No issue.

EXAMPLE 5 - GENERIC TEMPLATE NOTE (2 hours, telehealth)
Focus: improving communication of needs. Six timed blocks (15/25/25/20/20/15 min) each say the peer "discussed," "explored," or "encouraged" the client on communication topics. One block says they applied the ideas to "an everyday interaction selected by" the client, but never names it. Response: "participated in the discussion" and "was encouraged to consider." Plan: "follow up on his experience using a communication strategy." Location: "Telehealth N/A N/A N/A."
Result: REOPEN_TO_PEER. The minutes add up, but the content does not support 2 hours, no real situation is named, the client's choices and responses are absent, and the telehealth location fails the addendum.

Problem: The location section has no address for where the client was during this telehealth session.
Solution: Enter the client's address for this session in the location section.

Problem: The note does not state where you and the client were or whether the setting was appropriate for telehealth.
Solution: Document where each of you was and whether the setting was private and appropriate for telehealth.

Problem: The activities describe general communication topics, and the interaction the client selected is never named.
Solution: Please clarify what specifically happened during this part of the encounter and provide an actual example.

Problem: The response only says the client participated and was encouraged to consider ideas.
Solution: Please clarify what the client actually said or did in response, rather than only stating that the client was engaged or improved.

Problem: The general discussion described does not account for 120 minutes.
Solution: Please clarify what occurred during the encounter that supports the documented duration.

EXAMPLE 6 - CLINICAL ASSESSMENT BY PEER
Peer writes: "Client's depressive symptoms appear to be worsening and he may need a higher level of care."
Problem: The note includes a clinical judgment about symptoms and level of care.
Solution: Please describe what you and the client did together and what the client said, without clinical interpretation or assessment.

EXAMPLE 7 - SERVICE MAY NOT HAVE OCCURRED
The note documents a 2-hour in-person session on 10/12. The Response field says the client "is currently inpatient since 10/10."
Result: SUPERVISOR_REVIEW. supervisor_message: "The note documents an in-person session on 10/12, but the Response field states the client has been inpatient since 10/10." reopen_message_to_peer is empty.`;

const DEFAULT_OFFSITE_PROMPT = `SERVICE TYPE, LOCATION, AND BILLING CODE ADDENDUM

This addendum is sent in the same request as the Core Peer Note QA prompt. It controls off-site rationale, telehealth requirements, POS, modifiers, and units. It overrides any conflicting instruction about these topics.

Only check what the payload actually contains. If a field (modifier, POS, units, times) is not in the payload, skip that check. Do not guess.

==================================================
1. CLASSIFY THE SERVICE TYPE
==================================================

Use the encounter type, visit code, POS, location field, and narrative.

- ONSITE: in person at the Montebello Office (POS 11).
- OFFSITE: in person anywhere other than the Montebello Office (client's home, community center, store, other community location).
- TELEHEALTH: audio-video or audio-only.
- UNABLE_TO_DETERMINE: the material does not establish it.

Do NOT infer a location from ambiguous words. "Office," "room," "building," "lobby," "table," "inside," "workspace," "upstairs," and "downstairs" do not mean the clinic unless the note identifies them as the clinic.

==================================================
2. POS AND MODIFIER - MUST MATCH WHAT HAPPENED
==================================================

Reference:

Telehealth, audio-visual: modifier GT. POS 10 if the client is home, POS 02 if the client is out of the home.
Telehealth, audio only: modifier 93. POS 10 if the client is home, POS 02 if the client is out of the home.
In person at the client's home: POS 12.
In person at a community center: POS 99.
In person at the Montebello Office: POS 11.

Flag for return when there is a DIRECT mismatch, for example:
- the encounter or visit code is audio-video, but the note says the session was by phone, or the reverse
- POS 10, but the note or location field shows the client was somewhere other than home
- POS 02, but the note shows the client was home
- in-person POS 12, but the note says the session took place at a community center, or the reverse
- POS 11, but the note says the session took place outside the clinic

Use issue codes POS_MISMATCH or MODIFIER_MISMATCH with source SERVICE_TYPE.

Example:
Problem: The visit is coded POS 10 (client at home), but the note says the client joined from his workplace.
Solution: Correct the place of service to match where the client actually was during the session.

A direct contradiction that looks like an isolated wording error (for example, an in-person note that says "this telehealth session" once) is a REOPEN issue. Use SUPERVISOR_REVIEW only when the material indicates the service may not have occurred as documented, as defined in the core prompt.

==================================================
3. UNITS AND DURATION
==================================================

15 minutes = 1 unit.

Compare: start time, end time, total time, visit-code duration, units, and the sum of minutes in the activities section.

Flag for return when:
- units do not equal duration divided by 15 (ignore rounding of a partial unit)
- the billed duration differs from the documented start-to-end time
- the activity minutes add up to more than the session, or fall short of it by 15 minutes or more

Use issue code UNITS_MISMATCH with source SERVICE_TYPE.

Example:
Problem: The session ran 12:00 to 1:30 PM (90 minutes), but 8 units (120 minutes) were billed.
Solution: Please correct the duration and units to match the documented start and end times (15 minutes = 1 unit).

Minutes that add up correctly do NOT by themselves show that the content supports the time. That is the TIME check in the core prompt.

==================================================
4. TELEHEALTH REQUIREMENTS - ENFORCED FOR VISITS ON OR AFTER 10/15/2026
==================================================

Applies to telehealth notes with a visit date on or after 10/15/2026. Do not apply A or B to earlier visits. POS, modifier, and units checks apply to all visits.

A. CLIENT ADDRESS IN THE LOCATION SECTION
The "Location of the Meeting" field must contain the address where the client was during the session.
"Telehealth," "N/A," "home," "remote," or a blank value does not meet this requirement. The client's address in the header does not satisfy it.
Issue code TELEHEALTH_LOCATION, source SERVICE_TYPE.

Problem: The location section has no address for where the client was during this telehealth session.
Solution: Enter the client's address for this session in the location section.

B. APPROPRIATE SETTING FOR BOTH PEER AND CLIENT
The note must indicate that both the peer and the client were in a place appropriate for telehealth (for example, a private space where the client could speak freely). A brief statement is enough. No specific wording is required.
Issue code TELEHEALTH_SETTING, source SERVICE_TYPE.

Problem: The note does not state where you and the client were or whether the setting was appropriate for telehealth.
Solution: Document where each of you was and whether the setting was private and appropriate for telehealth.

Never instruct the peer to state that a setting was appropriate if it was not. The correction must reflect what actually occurred.

==================================================
5. OFF-SITE RATIONALE - ENFORCED FOR VISITS ON OR AFTER 10/01/2026
==================================================

Applies to OFFSITE (in person, not at the Montebello Office) sessions with a visit date on or after 10/01/2026.
Not required for visits before 10/01/2026, for ONSITE, or for TELEHEALTH.

THE STANDARD:
Be lenient. Read the off-site justification together with the rest of the note, the diagnoses, and the treatment plan. If this client has a documented diagnosis, struggle, or goal (for example ADHD, depression, anxiety, low motivation, isolation, impulse control, organization) and the session worked on it outside the clinic, the justification is PRESENT_SUFFICIENT, even when its wording is general and even when it does not name the diagnosis or struggle. Being out of the clinic is understood to help these clients; the note does not have to prove it. The reason may be ongoing and may be the same from session to session.

It does NOT need to show:
- a barrier to coming to the clinic
- a task that could only be done at that location
- a connection to a specific activity done today
- the client's diagnosis or a detailed explanation inside the justification itself
- clinical wording

The wording of the justification is never an issue of its own. Clinical-sounding words in it ("clinically superior," "therapeutic," "clinically indicated") are not a peer-scope problem, not unsupported diagnostic language, and not a reason to fail it. Do not create any issue from the justification's wording.

SUFFICIENT (examples, each in a note that documents the client's need):
- "Client is working on social anxiety and needs practice being in public places."
- "Client's depression has kept him from leaving his house, so the session was held at his home."
- "The community-based setting allowed Joel to practice improving motivation and daily functioning while completing a hands-on task."
- "The session took place in a community setting to help Yechiel discuss the stress he experiences from financial difficulties."
- "This setting is clinically superior because it offers a realistic, relaxed atmosphere for practicing emotional impulse control and physical sorting systems that support Aaron's functional independence at home."

TOO GENERAL (flag it) only when:
- the justification rests on preference, convenience, or distance alone: "Client prefers to meet in the community." / "To accommodate the client's preferences and ensure their comfort." / "Client lives far from the clinic." / "The location was more convenient."; or
- nothing in the note, diagnoses, or treatment plan documents a need the session worked on.

MISSING only when there is no justification anywhere. A blank justification field is not MISSING if the note elsewhere gives a reason.

Issue code OFFSITE_RATIONALE, source OFFSITE.

Missing:
Problem: The note does not explain why this session took place outside the clinic.
Solution: Please explain what about the client's needs or goals made meeting outside the clinic appropriate.

Too general:
Problem: The off-site reason ("[quote]") is general and does not connect to anything documented about this client.
Solution: Please explain what about the client's needs or goals made meeting outside the clinic appropriate.

==================================================
6. OFFSITE_REVIEW OUTPUT FIELDS
==================================================

service_type: ONSITE, OFFSITE, TELEHEALTH, or UNABLE_TO_DETERMINE (POSSIBLE_SATELLITE only if the note identifies another LINKS site).

ONSITE, or OFFSITE with a visit date before 10/01/2026:
  applicable: false
  status: NOT_APPLICABLE
  rationale_status: NOT_APPLICABLE
  location_status: NOT_APPLICABLE
  goal_connection_status: NOT_APPLICABLE
  explanation: "Off-site rationale not required for this visit."
  POS, modifier, and units checks still apply.

OFFSITE with a visit date on or after 10/01/2026:
  applicable: true
  rationale_status: PRESENT_SUFFICIENT, PRESENT_TOO_GENERAL, or MISSING
  location_status: SUFFICIENT if the location is documented, MISSING or UNCLEAR otherwise
  goal_connection_status: SUFFICIENT, MISSING, or UNCLEAR (is the reason tied to this client's needs or goals)
  status: PASS when all three are sufficient and POS matches, otherwise FAIL

TELEHEALTH with a visit date before 10/15/2026:
  applicable: false
  status, rationale_status, location_status, goal_connection_status: NOT_APPLICABLE
  explanation: "Telehealth location requirements not in effect for this visit."
  POS, modifier, and units checks still apply.

TELEHEALTH with a visit date on or after 10/15/2026:
  applicable: true
  rationale_status: NOT_APPLICABLE
  location_status: SUFFICIENT if the client's address is in the location section, otherwise MISSING
  goal_connection_status: NOT_APPLICABLE
  status: PASS when the address, the appropriate-setting statement, POS, and modifier are all in order, otherwise FAIL
  explanation: state which requirement failed, if any

status: SUPERVISOR_REVIEW only when the service-type evidence indicates the service may not have occurred as documented.

==================================================
7. OVERRIDES FOR THE DECISION HIERARCHY AND OUTPUT SECTION
==================================================

A DECISION HIERARCHY and OUTPUT section follows this addendum. Use its JSON format and its length limits exactly. Where any line in it conflicts with the rules below, the rules below win.

A. TREATMENT PLAN
Ignore its example that sends a treatment-plan diagnosis mismatch to SUPERVISOR_REVIEW. Treatment-plan content never creates an issue and never affects the decision. Never use TREATMENT_PLAN_MISMATCH or source TREATMENT_PLAN.

B. WHEN DECISION IS PASS
review_summary is exactly "No issues identified." Do NOT explain why the note aligns. If there are WARNING issues only, review_summary states the warning in one sentence instead. WARNING issues never change the decision.

C. WHEN DECISION IS REOPEN_TO_PEER
reopen_message_to_peer contains ONLY Problem/Solution pairs, as defined in the core prompt. Not a paragraph-style message. supervisor_message is an empty string.

D. WHEN DECISION IS SUPERVISOR_REVIEW
Use it ONLY for possible service-delivery discrepancies as defined in the core prompt, never for record-level or treatment-plan concerns. supervisor_message states the discrepancy factually and never uses "fraud," "falsified," "fabricated," or similar labels. reopen_message_to_peer is an empty string.

E. STATUS FIELDS
- narrative_goal_alignment is NOT_ALIGNED or PARTIALLY_ALIGNED when the CLEAR, SPECIFIC, CLIENT-DRIVEN, TIME, or NEED check fails.
- intervention_status reflects the MATCH and PEER SCOPE checks.
- response_status reflects the RESPONSE check.`;

// Fixed, non-editable: the review rules, decision precedence and the exact
// output contract. Appended after both editable modules so operator edits can
// never break JSON parsing — and where an editable module disagrees with a rule
// here, this section says it wins.
const REVIEW_OUTPUT_CONTRACT = `REVIEW RULES (these take precedence over anything above that conflicts with them)

WORKFLOW
A PASS note goes straight to the clean stack with no further human review, so PASS means you found nothing that needs a human. Any other decision sends the note to a human reviewer, who decides whether to return it to the peer. Nothing is returned automatically.
Comparison with the peer's other notes is done mechanically on import. You never see another note; do not compare, and do not comment on duplication or copying.

WHERE TO LOOK
Fields in the payload: note_sections (focus, activities_and_duration, peer_interventions, patient_response, plan), persons_present, location_of_meeting, offsite_justification, other_session_narrative, client_address, encounter_type, delivery_method, place_of_service, billing_or_rate_type (visit code, Duration, Unit(s), and modifiers after "M:"), stated_duration, start_time, end_time, diagnoses, treatment_plan, mechanical_findings.
Information is often in an unexpected field: the location or the off-site justification may sit inside persons_present, and either may appear in the narrative. Search EVERY field before calling anything missing.

QA CHECKS (a failed check is a REOPEN issue unless stated otherwise)
1. CLEAR — you can tell what the peer and client actually did.
2. SPECIFIC — the note names an actual situation or example from the client's life, not just a topic.
3. CLIENT-DRIVEN — the note shows what the client wanted, chose, or tried; it does not read like a preplanned lesson.
4. RESPONSE — the note shows what the client actually said or did. "Engaged", "participated", "improved", "understood" or "was encouraged" on their own fail.
5. MATCH — each selected intervention is demonstrated somewhere in the note.
6. TIME — the content reasonably supports the session length, especially for 2-3 hour sessions.
7. NEXT — the note gives something specific for the client to try. WARNING only: it never changes the decision on its own.
8. PEER SCOPE — the work is recognizable peer support. No therapy, no diagnosing, and no peer judgment about symptoms, risk, motivation, or level of care.
9. NEED — the work has a reasonable link to the client's documented needs. Do not require sentences bridging the work to a diagnosis.

DIAGNOSES AND THE TREATMENT PLAN
Unsupported diagnostic language: flag only when the peer's own text names a diagnosis that is not on the diagnoses list. Functional descriptions (focus, distraction, low mood, stress) are never diagnoses.
The treatment plan is context only. It never creates an issue. Never use TREATMENT_PLAN_MISMATCH, never use the TREATMENT_PLAN issue source, and never escalate because of the treatment plan. Treatment-plan wording never lowers narrative_goal_alignment; that status reflects the QA checks.

OFF-SITE RATIONALE
Applies to in-person visits that did not take place at the Montebello Office (POS 11), with a visit date on or after ${OFFSITE_RATIONALE_FROM}. No rationale is required for earlier dates, telehealth, or POS 11 visits.
When it applies, be lenient. Read offsite_justification together with the narrative, the diagnoses and the treatment plan. If this client has a documented diagnosis, struggle, or goal and the session worked on it outside the clinic, the rationale is PRESENT_SUFFICIENT, even when the justification is worded generally or does not name the need. Being out of the clinic is understood to help these clients. The reason may be ongoing and may repeat from session to session. No barrier to the clinic, location-only task, link to today's activity, or clinical wording is required.
The justification's wording is never an issue of its own: clinical-sounding words in it ("clinically superior," "therapeutic") are not PEER_SCOPE, not unsupported diagnostic language, and not a reason to fail it.
PRESENT_TOO_GENERAL only when the justification rests on preference, convenience, or distance alone, or nothing in the record documents a need the session worked on. MISSING only when no reason appears anywhere. Either is a REOPEN issue for the peer.

TELEHEALTH (visit date on or after ${TELEHEALTH_LOCATION_FROM})
- location_of_meeting must contain the address where the client was during the session. client_address (the header) on its own does not satisfy this.
- The note must state that both the peer and the client were in an appropriate telehealth setting.
Each missing element is a REOPEN issue for the peer.

POS AND TELEHEALTH MODIFIERS
POS must match what happened. Telehealth: POS 10 when the client is at home, 02 when the client is somewhere else. In person: POS 12 at the client's home, 99 at a community location, 11 at the Montebello Office.
The ONLY modifiers you check are GT (telehealth audio-video) and 93 (telehealth audio-only). Every other modifier, U4 included, is unrelated: never flag, question, or mention it. Modifiers are listed after "M:" in billing_or_rate_type; when there is no visit-code line in the payload, skip the modifier check. Otherwise flag only:
- a telehealth note with neither GT nor 93;
- GT on an audio-only session;
- 93 on an audio-video session;
- GT or 93 on an in-person session.
A POS or modifier that does not match what the note describes is a REOPEN issue for the peer (source SERVICE_TYPE). It is not DO_NOT_BILL.

UNITS AND TIME
15 minutes = 1 unit. The start and end time, the duration, the units, and any minutes the peer gives for activities must agree. A difference of less than one unit due to rounding is not an issue. A disagreement the peer can correct is a REOPEN issue.

SERVICE-DELIVERY DISCREPANCIES
If the note suggests the service may not have happened as billed — the client was unavailable or absent, the times are impossible, or the record appears altered — the decision is SUPERVISOR_REVIEW. State the facts plainly from the note. Never use the word "fraud" or accuse anyone.
DO_NOT_BILL only when the note itself shows the service did not occur (for example a no-show, a cancellation, or no contact with the client). A service that did happen but was miscoded is a POS/modifier issue for the peer, not DO_NOT_BILL.

DECISION HIERARCHY
Identify EVERY issue, not only the first. Then set the single overall decision by this precedence:
1. DO_NOT_BILL
2. SUPERVISOR_REVIEW
3. REOPEN_TO_PEER
4. PASS

Example: a note with a vague client response the peer can fix AND start and end times that overlap another documented commitment has an overall decision of SUPERVISOR_REVIEW, and the issues array must contain both concerns.
WARNING issues never change the decision: a note whose only issues are WARNINGs is PASS.

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

Severity: WARNING (check 7 only, never changes the decision), REOPEN (peer can fix), SUPERVISOR (service-delivery discrepancy), NONBILLABLE (service did not occur). Owner: PEER for REOPEN and WARNING, HUMAN_REVIEW for SUPERVISOR, BILLING for NONBILLABLE.

When decision is PASS: reopen_message_to_peer and supervisor_message are empty strings. review_summary is exactly "No issues identified." — or, when there are WARNING issues only, one sentence stating the warning.
When decision is REOPEN_TO_PEER: reopen_message_to_peer contains ONLY "Problem:" / "Solution:" pairs, one pair per issue, Problem and Solution each on its own line and pairs separated by a blank line, for example:
Problem: The client's response says only that he "engaged well."
Solution: Describe what the client actually said or did during the session.
No greeting, no praise, no summary, nothing else. Cover every REOPEN issue, and only actual deficiencies. Never ask the peer to invent facts, to add a reason that did not apply, to use clinical language, or to repeat what is already documented. supervisor_message is an empty string.
When decision is SUPERVISOR_REVIEW: reopen_message_to_peer is an empty string. supervisor_message states the concern factually from the note. Peer-fixable issues still go in the issues array for the reviewer.
When decision is DO_NOT_BILL: reopen_message_to_peer is an empty string. supervisor_message states plainly what in the note shows the service did not occur, and never suggests wording that would conceal it.

Every explanation must cite what the note actually says. Leave evidence_from_note empty rather than paraphrasing something the note does not contain.

LENGTH LIMITS (the response is truncated if you exceed them, which discards the whole review):
- Every "explanation" field: at most 2 sentences.
- "evidence_from_note": a short quoted fragment, at most 200 characters.
- "issues": at most 6 entries, most severe first. Merge related concerns rather than listing near-duplicates.
- "review_summary": at most 3 sentences.
- "reopen_message_to_peer": at most 200 words. "supervisor_message": at most 150 words.
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
// Which text to cut sections from: the line-structured form when the note was
// parsed by a version that kept it, else the flat text (every note stored
// before that). findHeadings handles both shapes and yields identical values.
function sectionSource(note) {
  return note.structuredText || note.fullNoteText || note.noteText || '';
}

function splitSections(text) {
  const out = {};
  for (const s of SECTION_LABELS) out[s.key] = '';
  if (!text) return out;

  const headings = findHeadings(text);
  if (!headings.length) return out;

  // Pick the five narrative headings IN ORDER, each search resuming after the
  // previous one — so a stray "Plan:" earlier in the narrative can't be mistaken
  // for the real Plan header (3 of 324 stored notes contain a second "Plan:").
  let from = 0;
  for (const s of SECTION_LABELS) {
    const i = headings.findIndex((h, idx) => idx >= from && h.label === s.label);
    if (i === -1) continue;
    // Every section ends at the NEXT recognised heading of ANY kind — which is
    // what keeps "Diagnosis" out of Plan, "Visit Codes" out of Diagnosis, and so
    // on, instead of relying on a per-field terminator list.
    // InSync sometimes emits the same label twice — "Plan: *" (the required-
    // field marker) on one line, then "Plan:" again, then the content. The first
    // copy ends at the second and yields nothing, so step past any empty
    // same-label repeat rather than reporting the section as absent.
    let j = i;
    while (j + 1 < headings.length && headings[j + 1].label === s.label
           && !headingValue(text, headings[j].valueStart, headings[j + 1].start)) j++;
    const end = j + 1 < headings.length ? headings[j + 1].start : text.length;
    out[s.key] = headingValue(text, headings[j].valueStart, end);
    from = j + 1;
  }
  return out;
}

// The value of one top-level heading — the replacement for the old indexOf-based
// _section(). Case-insensitive on the label, but the heading must have been
// detected as a heading, so a narrative "…his diagnosis helped him…" is never
// mistaken for the Diagnosis section.
function sectionByLabel(text, label) {
  const headings = findHeadings(text);
  const i = headings.findIndex(h => h.label.toLowerCase() === label.toLowerCase());
  if (i === -1) return '';
  const end = i + 1 < headings.length ? headings[i + 1].start : text.length;
  return headingValue(text, headings[i].valueStart, end);
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

// Whether the encounter type is an Offsite one — "…In-person outside the clinic
// Offsite". These are the notes written on the Offsite form, which carries the
// "Justification for Offsite Delivery" field.
function isOffsiteType(encounterType) {
  const t = String(encounterType || '').toLowerCase();
  return /\boff-?site\b/.test(t) || t.includes('outside the clinic');
}

// The Offsite form's justification field, '' when the note has none. Derived
// from the stored text rather than a parsed field, so notes ingested before the
// heading was recognised read it too.
function offsiteJustificationOf(note) {
  return sectionByLabel(sectionSource(note), 'Justification for Offsite Delivery');
}

// The Note-of-Session fields that sit before "Focus of the meeting", plus the
// client's address from Patient Details — what the location, off-site and
// telehealth checks read. Derived from the stored text like the above. The
// regular form says "Location of the Meeting", the Offsite form "Location of
// Meeting".
function preambleFieldsOf(note) {
  const source = sectionSource(note);
  return {
    persons_present:     sectionByLabel(source, 'Persons Present'),
    location_of_meeting: sectionByLabel(source, 'Location of the Meeting')
                      || sectionByLabel(source, 'Location of Meeting'),
    client_address:      sectionByLabel(source, 'Address'),
  };
}

// An in-person session at the client's home: POS 12, or an encounter type like
// "…In-person Home". Telehealth from home is a different rule and never counts.
function isInHomeVisit(note) {
  const type = String(note.encounterType || '').toLowerCase();
  if (/telehealth|video|audio|phone/.test(type)) return false;
  return /^\s*12\b/.test(String(note.pos || '')) || /\bin[- ]person\b.*\bhome\b/.test(type);
}

const STREET_SUFFIXES = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl',
  boulevard: 'blvd', blvd: 'blvd', terrace: 'ter', ter: 'ter', parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy', circle: 'cir', cir: 'cir', way: 'way',
};
const DIRECTIONS = { north: 'n', south: 's', east: 'e', west: 'w' };
const addressTokens = s => String(s || '').toLowerCase().replace(/[.,#]/g, ' ')
  .split(/\s+/).filter(Boolean).map(t => DIRECTIONS[t] || t);
const zipOf = (tokens, skip) => [...tokens].reverse().find((t, i) => /^\d{5}$/.test(t) && tokens.length - 1 - i !== skip) || null;

// Does the meeting location name the same place as the client's address? Only
// the parts that identify the place are compared — house number, street name
// (Street = St, Avenue = Ave, any case or punctuation), and zip when both carry
// one — so extra words around the address in the location field don't matter.
// Returns null when the client address itself can't be read, so the check is
// skipped rather than guessed.
function addressesMatch(clientAddress, location) {
  const street = String(clientAddress || '').split(',')[0];
  const c = addressTokens(street);
  if (!c.length || !/^\d+[a-z]?$/.test(c[0])) return null;
  const house = c[0];
  // The street name ends at any apartment/unit part ("Apt 3", "Unit B").
  const unit = c.findIndex(t => /^(apt|apartment|unit|fl|floor|suite|ste|rm|room)$/.test(t));
  const core = c.slice(1, unit === -1 ? undefined : unit).filter(t => !STREET_SUFFIXES[t]);
  if (!core.length) return null;

  const loc = addressTokens(location);
  const clientZip = zipOf(addressTokens(clientAddress), 0);
  for (let i = 0; i < loc.length; i++) {
    if (loc[i] !== house) continue;
    const after = loc.slice(i + 1).filter(t => !STREET_SUFFIXES[t]).slice(0, core.length);
    if (after.join(' ') !== core.join(' ')) continue;
    const locZip = zipOf(loc, i);
    if (clientZip && locZip && clientZip !== locZip) continue;
    return true;
  }
  return false;
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

// Guard against silently shipping an empty section that the note plainly has.
//
// The activities field read "" for every note ever reviewed because InSync ends
// that heading with "?" and findHeadings only accepted ":" — the text was still
// there, misfiled into the previous section. Nothing caught it, because a blank
// field is indistinguishable from a genuinely blank field. This makes the two
// distinguishable: if the source carries the heading followed by substantive
// content and the derived section is still empty, that is a parser failure.
//
// Loud, never fatal in production: a note shape we have not seen yet must not
// stall the ingest queue. Under NODE_ENV=test or PS_STRICT_SECTIONS=1 it throws,
// so the regression suite fails instead of printing a warning nobody reads.
const SECTION_ASSERT_MIN_CHARS = 40;

function assertSectionsDerived(note, source, secs) {
  const problems = [];
  for (const { key, label } of SECTION_LABELS) {
    if (secs[key]) continue;
    // Locate the heading in the source and look at what follows it. This must
    // NOT re-implement findHeadings — sharing its logic would mean sharing its
    // blind spot and staying silent for the same reason. So it looks only for
    // the label followed by either terminator InSync uses, ":" or "?", which is
    // exactly the distinction findHeadings got wrong. The punctuation IS
    // required: "Plan" alone also occurs inside "Treatment Plan" and
    // "Plan / Visit Codes", neither of which is the narrative Plan section.
    const re = new RegExp('(?<![A-Za-z])(?:' + headingBody(label) + ')[ \\t]*[:?]', 'i');
    const m = re.exec(source);
    if (!m) continue;
    const after = source.slice(m.index + m[0].length).replace(/\s+/g, ' ').trim();
    if (after.length < SECTION_ASSERT_MIN_CHARS) continue;
    problems.push({ key, label, followingText: after.slice(0, 160) });
  }
  if (!problems.length) return;

  const eid = note.eid || note.encounterId || '(unknown eid)';
  const lines = problems.map(p =>
    `  ${p.key} ("${p.label}") is empty, but the note continues: ${JSON.stringify(p.followingText)}`);
  const msg = `[PS payload] eid=${eid}: ${problems.length} section(s) present in the note but empty in the review payload — the parser missed a heading, do NOT send this to the model.\n${lines.join('\n')}`;
  console.error(msg);
  if (process.env.NODE_ENV === 'test' || process.env.PS_STRICT_SECTIONS === '1') throw new Error(msg);
}

// The exact JSON handed to the model as the user message. Never includes another
// client's note, duplicate-partner text, or any comparison data.
function buildReviewPayload(note, machineFlags = []) {
  const source = sectionSource(note);
  const secs = splitSections(source);
  assertSectionsDerived(note, source, secs);
  const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
  const justification = offsiteJustificationOf(note);
  const preamble = preambleFieldsOf(note);
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
    client_address:      clip(preamble.client_address, 300) || '',
    persons_present:     clip(preamble.persons_present, 2000) || '',
    location_of_meeting: clip(preamble.location_of_meeting, 2000) || '',
    note_sections: {
      focus:                   clip(secs.focus, 8000) || '',
      activities_and_duration: clip(secs.activities, 8000) || '',
      peer_interventions:      clip(secs.interventions, 8000) || '',
      patient_response:        clip(secs.response, 8000) || '',
      plan:                    clip(secs.plan, 4000) || '',
    },
    // Genuinely "other": the Note-of-Session text before the first recognised
    // heading — on an InSync note that is the session title ("Peer Support
    // Individual ; Offsite"), since persons present and location now have their
    // own fields above; a CRM note keeps its whole preamble. Sending the whole narrative
    // here would duplicate every section verbatim — doubling input tokens and
    // letting stale text contradict the section fields.
    other_session_narrative: clip(sessionPreamble(note), 2000) || '',
    // The Offsite form's dedicated rationale field. It sits before "Focus of the
    // meeting" but after "Persons Present", so neither the sections nor the
    // preamble carry it. Only present when the note has one.
    ...(justification ? { offsite_justification: clip(justification, 4000) } : {}),
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

  // `range` (optional) widens or moves the visit-date window InSync is asked
  // about: { from, to } as 'YYYY-MM-DD' or Date. Default is the last 90 days,
  // which is what the queue normally holds — an older backlog needs the window
  // moved, since InSync filters server-side and never returns what wasn't asked for.
  async fetchAllPages(onProgress, range = {}) {
    const asDate = (v, fallback) => {
      if (v instanceof Date && !isNaN(v)) return v;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : fallback;
    };
    const now  = new Date();
    const to   = asDate(range.to, now);
    const dflt = new Date(to); dflt.setDate(dflt.getDate() - 90);
    const from = asDate(range.from, dflt);
    const fmt  = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

    const baseParams = {
      'searchParamter[PatientId]':                   '0',
      'searchParamter[FacilityIds]':                 '0',
      'searchParamter[ProviderIds]':                 '',
      'searchParamter[EncounterTypeIds]':            '',
      'searchParamter[VisitDateFrom]':               fmt(from),
      'searchParamter[VisitDateTo]':                 fmt(to),
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

    // Keep the document's line structure through cleanup and section-finding;
    // it is what lets a heading be recognised by position rather than by
    // guessing from capitalisation. The flat form is derived at the end, and is
    // byte-identical to what this parser produced before, so note hashes,
    // duplicate scores and the scalar field() regexes below are all untouched.
    let structured = htmlToStructuredText(marked);

    // Surgically excise InSync toolbar block from middle of note
    const junkStartMarkers = [
      'Re-BindGrid', 'Save as Draft', 'Send Fax Print',
      'This form is not yet saved', 'Save to Document Manager',
    ];
    const resumeMarkers = [
      'Diagnosis', 'Plan / Visit', 'Treatment Plan',
      'Electronically Signed', 'Provider NPI',
    ];

    // Markers are matched across whitespace now that line breaks survive, so a
    // phrase split over two lines still matches.
    let junkStart = structured.length;
    for (const jm of junkStartMarkers) {
      const m = loosePhrase(jm).exec(structured);
      if (m) junkStart = Math.min(junkStart, m.index);
    }

    if (junkStart < structured.length) {
      let resumeAt = null;
      for (const rm of resumeMarkers) {
        const re = loosePhrase(rm, 'g');
        re.lastIndex = junkStart;
        const m = re.exec(structured);
        if (m) resumeAt = resumeAt === null ? m.index : Math.min(resumeAt, m.index);
      }
      structured = resumeAt !== null
        ? (structured.slice(0, junkStart).trim() + '\n' + structured.slice(resumeAt)).trim()
        : structured.slice(0, junkStart).trim();
    }

    for (const phrase of [
      'Re-BindGrid Save Save as Draft Clear Send Fax Print',
      'This form is not yet saved.', 'Save to Document Manager',
      'Add to Document Manager', 'Use Patient’s Pre-captured Signature',
      "Use Patient's Pre-captured Signature",
      'Click to view Encounter Note', 'Re-BindGrid', 'Save as Draft',
    ]) structured = structured.replace(loosePhrase(phrase, 'g'), '\n');
    structured = structured.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();

    // The flat text every downstream consumer already expects.
    const text = structured.replace(/\s+/g, ' ').trim();

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

    const sessionNarrative = this._section(structured, 'Note of Session');
    const sessionContent   = this._sessionContent(structured);
    // End labels are no longer passed: every section now ends at the next
    // recognised heading, whatever it happens to be.
    const diagnosis        = this._section(structured, 'Diagnosis');
    const treatmentPlan    = this._section(structured, 'Treatment Plan');
    // Place of service and the billed visit codes — context for the AI's
    // service-type classification, and for spotting a delivery/billing mismatch.
    const pos              = field('POS');
    const visitCodes       = this._section(structured, 'Visit Codes');

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
      // Line-structured form, kept so the sections re-derived later (review
      // payload, duplicate comparison) use structure rather than heuristics.
      structuredText: structured,
    };
  }

  // The genuinely session-specific free text: "Focus of the meeting" through
  // "Plan", stopping before the diagnosis codes / visit codes / treatment plan /
  // signature. This is the part a peer actually writes per-session (and clones);
  // everything outside it (demographics, times, ICD codes, the templated
  // treatment-plan goals) is boilerplate that shouldn't drive clone matching.
  _sessionContent(text) {
    const headings = findHeadings(text);
    const start = headings.findIndex(h => h.label === 'Focus of the meeting');
    if (start === -1) return '';
    // Runs to the first heading that is NOT one of the five narrative sections —
    // Diagnosis, Plan / Visit Codes, Treatment Plan, the signature block. Ending
    // at the heading (not at the ICD code after it) is what kept the bare word
    // "Diagnosis" out of the narrative.
    const narrative = new Set(SECTION_LABELS.map(s => s.label));
    let end = text.length;
    for (let i = start + 1; i < headings.length; i++) {
      if (!narrative.has(headings[i].label)) { end = headings[i].start; break; }
    }
    return text.slice(headings[start].start, end).replace(/\s+/g, ' ').trim();
  }

  _section(text, startLabel) {
    return sectionByLabel(text, startLabel);
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

    // ── Offsite justification field vs encounter type ──
    // An unrecognised type is already flagged above, so it never quietly passes
    // as a regular note here.
    const justification = offsiteJustificationOf(note);
    if (isOffsiteType(note.encounterType)) {
      if (!justification && isoVisitDate(note) >= OFFSITE_RATIONALE_FROM)
        flags.push('Off-site session with no Justification for Offsite Delivery — verify the off-site rationale');
    } else if (justification) {
      flags.push('Justification for Offsite Delivery filled in, but the encounter type is not off-site — verify the encounter type');
    }

    // ── In-home session: the meeting location must be the client's address ──
    // A blank location doesn't match either, so it is flagged the same way.
    if (isInHomeVisit(note)) {
      const { client_address, location_of_meeting } = preambleFieldsOf(note);
      if (addressesMatch(client_address, location_of_meeting) === false)
        flags.push("The notes indicate that the peer sessions took place in the client's home, but the service location listed does not match the client's address. Please correct the discrepancy as you deem fit.");
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
      secs:        prepareSections(sectionSource(note), note.patientName),
    };
  }

  // Is `note` a possible duplicate of anything in `corpus`? Section-scoped,
  // corresponding-section-only, and entirely mechanical — this method makes NO
  // network calls of any kind. Returns the strongest match or null.
  // `corpus` items come from prepareDupeEntry().
  findDupe(note, corpus) {
    const mine = prepareSections(sectionSource(note), note.patientName);
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
  // `skipRow(row)` (optional) is asked about every queue row BEFORE its content is
  // downloaded; a truthy return (a reason, or an object) keeps the note out of the
  // pull entirely. Deciding here rather than after loading is the point: loading
  // one note costs three round-trips to InSync and a note that is never ingested
  // never reaches the AI review either. The rows it rejects come back as `skipped`
  // so the caller can record them.
  async fetchNotes(onProgress, { dates = null, range = {}, skipRow = null } = {}) {
    const report = (m, p) => { if (onProgress) onProgress(m, p); };
    let rows = await this.fetchAllPages(report, range);
    if (dates && dates.size) rows = rows.filter(r => dates.has(dateKeyOf(r)));
    const skipped = [];
    if (skipRow) {
      const keep = [];
      for (const row of rows) {
        const reason = skipRow(row);
        if (reason) skipped.push({ row, reason }); else keep.push(row);
      }
      rows = keep;
    }
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
    return { notes, cantLoad, skipped };
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
  dateKeyOf, sectionSource, htmlToStructuredText,
  // exported for unit testing of the mechanical duplicate path
  splitSections, prepareSections, compareSections, dupeVerdict,
  // exported for unit testing of heading-boundary parsing
  findHeadings, sectionByLabel, NOTE_HEADINGS,
  // exported for unit testing of the review payload itself
  buildReviewPayload, assertSectionsDerived, SECTION_LABELS,
};
