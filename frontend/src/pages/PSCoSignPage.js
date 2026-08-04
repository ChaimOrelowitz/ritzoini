import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { api } from '../utils/api';
import supabase from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

const API = process.env.REACT_APP_API_URL || 'http://localhost:4000';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDt(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  return isNaN(d) ? dt : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Chip({ color, children }) {
  const colors = {
    red:    { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' },
    orange: { bg: '#fff7ed', text: '#ea580c', border: '#fed7aa' },
    blue:   { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' },
    gray:   { bg: '#f1f5f9', text: '#64748b', border: '#e2e8f0' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.01em',
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>{children}</span>
  );
}

// ── AI review + duplicate chips ───────────────────────────────────────────────

// Colour and label per AI decision. Deliberately separate from the duplicate
// chip: duplication is a mechanical finding a human adjudicates, and must never
// be folded into the AI's verdict.
const AI_DECISION_CHIP = {
  PASS:              { color: 'gray',   label: 'AI: pass' },
  REOPEN_TO_PEER:    { color: 'orange', label: 'Reopen to peer' },
  SUPERVISOR_REVIEW: { color: 'red',    label: 'Supervisor review' },
  DO_NOT_BILL:       { color: 'red',    label: 'Do not bill' },
  AI_REVIEW_ERROR:   { color: 'red',    label: 'AI review error' },
};

function AiDecisionChip({ decision }) {
  const c = AI_DECISION_CHIP[decision];
  if (!c) return null;
  return <Chip color={c.color}>{c.label}</Chip>;
}

// The mechanical duplicate chip. Shows the human's adjudication once made.
function DupeChip({ note }) {
  if (!note.dupeStatus) return null;
  if (note.dupeDecision === 'dismissed') return <Chip color="gray">Duplicate dismissed</Chip>;
  const top = note.cloneSections?.[0];
  return (
    <Chip color={note.dupeDecision === 'confirmed' ? 'red' : 'orange'}>
      {note.dupeDecision === 'confirmed' ? 'Confirmed duplicate' : 'Possible duplicate'}
      {top ? ` — ${top.label} ${top.pct}%` : (note.clonePct ? ` — ${note.clonePct}%` : '')}
    </Chip>
  );
}

// Off-site chip, only when the review actually engaged the off-site rules.
function OffsiteChip({ offsite }) {
  if (!offsite || offsite.applicable === false) return null;
  if (!offsite.status || offsite.status === 'PASS' || offsite.status === 'NOT_APPLICABLE') return null;
  const label = offsite.rationaleStatus && offsite.rationaleStatus !== 'NOT_APPLICABLE'
    ? `Off-site: rationale ${offsite.rationaleStatus.replace(/_/g, ' ').toLowerCase()}`
    : 'Off-site issue';
  return <Chip color="orange">{label}</Chip>;
}

function flagChipColor(flag) {
  if (flag && /possible duplicate/i.test(flag)) return 'orange';
  if (!flag) return 'gray';
  const f = flag.toLowerCase();
  if (f.includes('clone') || f.includes('duplicate') || f.includes('copied')) return 'orange';
  if (f.includes('session') || f.includes('long') || f.includes('hour')) return 'blue';
  if (f.includes('school') || f.includes('minor')) return 'red';
  if (f.includes('ai')) return 'red';
  return 'gray';
}

// ── Note formatting + similarity highlighting ─────────────────────────────────

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Field-style sub-headers ("Label: value", "Label? value"). These are regex
// sources — goal/intervention labels carry an optional trailing number, and the
// "?" that ends the activities question is handled by the separator class. Order
// matters: a longer label must precede any shorter one it could prefix-match.
const FIELD_LABELS = [
  'Persons Present', 'Location of the Meeting', 'Focus of the meeting',
  'What activities took place, and for how long',
  'Peer Support Interventions', "Patient's Response/Content", 'Plan',
  'Visit Codes', 'Provider NPI',
  // NB: 'Problem' (the treatment-plan header the backend injects) is handled
  // separately in segmentNote — it's too common a narrative word to match bare.
  'Long Term Goal\\(s\\)(?:\\s*\\d+)?', 'Short Term Goal\\(s\\)(?:\\s*\\d+)?',
  'Intervention\\(s\\)(?:\\s*\\d+)?',
  'Name', 'DOB', 'Age', 'Address', 'Phone', 'MRN', 'E-mail', 'Visit Date',
  'Encounter Type', 'POS', 'Start Time', 'End Time', 'Total Time',
];

// Standalone banner/divider headers (no trailing colon). Case-sensitive so a
// lowercase "treatment plan" inside a narrative can't trigger a false divider.
const DIVIDER_LABELS = ['Note of Session', 'Diagnosis', 'Plan / Visit Codes', 'Treatment Plan', 'Electronically Signed'];

// Split a flat note string into { label, value, start, divider } sections.
// `start` is the char offset of `value` in the original text (for highlighting).
function segmentNote(text) {
  if (!text) return [];
  const marks = [];
  let m;

  const fieldRe = new RegExp('\\b(' + FIELD_LABELS.join('|') + ')\\s*[:?\\-]\\s*', 'gi');
  while ((m = fieldRe.exec(text)) !== null)
    marks.push({ label: m[1].trim(), labelStart: m.index, valueStart: m.index + m[0].length, divider: false });

  // 'Problem' is the treatment-plan header the backend injects, but it's also a
  // common narrative word. Only treat it as a header when it's trailed by the
  // "(Last Review Date" marker a real TP problem always carries (bounded so a
  // far-off match can't reach back) — so "the problem: he kept…" in a narrative
  // isn't promoted to a section head.
  const problemRe = /\bProblem\s*[:?\-]\s*(?=.{0,100}?\(Last Review Date)/gi;
  while ((m = problemRe.exec(text)) !== null)
    marks.push({ label: 'Problem', labelStart: m.index, valueStart: m.index + m[0].length, divider: false });

  const divRe = new RegExp('(?:^|\\s)(' + DIVIDER_LABELS.map(escapeRe).join('|') + ')(?=\\s|$)', 'g');
  while ((m = divRe.exec(text)) !== null) {
    const s = m.index + m[0].length - m[1].length;
    marks.push({ label: m[1], labelStart: s, valueStart: s + m[1].length, divider: true });
  }

  marks.sort((a, b) => a.labelStart - b.labelStart);
  // Drop any mark that begins inside the previous mark's label text (overlaps).
  const clean = [];
  for (const mk of marks) {
    const prev = clean[clean.length - 1];
    if (prev && mk.labelStart < prev.valueStart) continue;
    clean.push(mk);
  }
  if (!clean.length) return [{ label: null, value: text, start: 0 }];

  const segs = [];
  if (clean[0].labelStart > 0)
    segs.push({ label: null, value: text.slice(0, clean[0].labelStart), start: 0 });
  for (let i = 0; i < clean.length; i++) {
    const end = i + 1 < clean.length ? clean[i + 1].labelStart : text.length;
    segs.push({ label: clean[i].label, value: text.slice(clean[i].valueStart, end), start: clean[i].valueStart, divider: clean[i].divider });
  }
  return segs;
}

function tokenize(text) {
  const toks = [], re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) toks.push({ t: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
  return toks;
}

// Word-level matching blocks (difflib-style) → merged absolute char ranges of the
// text that both notes share. Returns { a, b } range lists, or null if too large.
function commonRanges(textA, textB) {
  const A = tokenize(textA), B = tokenize(textB);
  if (!A.length || !B.length || A.length > 6000 || B.length > 6000) return null;

  const b2j = new Map();
  B.forEach((tk, j) => { if (!b2j.has(tk.t)) b2j.set(tk.t, []); b2j.get(tk.t).push(j); });

  const blocks = [], stack = [[0, A.length, 0, B.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop();
    let besti = alo, bestj = blo, bestsize = 0, j2 = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (const j of (b2j.get(A[i].t) || [])) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2 = nj;
    }
    if (bestsize > 0) {
      blocks.push([besti, bestj, bestsize]);
      if (alo < besti && blo < bestj) stack.push([alo, besti, blo, bestj]);
      if (besti + bestsize < ahi && bestj + bestsize < bhi) stack.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
    }
  }

  const build = (toks, idx) => {
    const r = blocks.filter(bl => bl[2] >= 2).map(bl => [toks[bl[idx]].s, toks[bl[idx] + bl[2] - 1].e]).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const rng of r) {
      const last = merged[merged.length - 1];
      if (last && rng[0] <= last[1]) last[1] = Math.max(last[1], rng[1]);
      else merged.push([...rng]);
    }
    return merged;
  };
  return { a: build(A, 0), b: build(B, 1) };
}

// Char range [start, end) of the per-session narrative (Focus of the meeting →
// Plan) inside a full note. Mirrors the backend's _sessionContent so clone
// highlighting is scoped to the exact same text the detector compares — never
// the demographics/times/treatment-plan boilerplate.
function sessionContentRange(text) {
  if (!text) return null;
  const sm = /Focus of the meeting\s*[:\-]/i.exec(text);
  if (!sm) return null;
  const start = sm.index;
  const tail  = text.slice(start);
  let end = tail.length;
  for (const re of [/\bF\d{2}\.\d/, /Visit Codes\s*[:\-]/i, /Treatment Plan/, /Electronically Signed/i, /Provider NPI/i]) {
    const mm = re.exec(tail);
    if (mm && mm.index > 0) end = Math.min(end, mm.index);
  }
  return { start, end: start + end };
}

// Common-text ranges between two notes, computed ONLY over each note's session
// narrative and mapped back to full-note offsets for highlighting.
function scopedCommonRanges(ta, tb) {
  const ra = sessionContentRange(ta), rb = sessionContentRange(tb);
  if (!ra || !rb) return null;
  const cr = commonRanges(ta.slice(ra.start, ra.end), tb.slice(rb.start, rb.end));
  if (!cr) return null;
  return {
    a: cr.a.map(([s, e]) => [s + ra.start, e + ra.start]),
    b: cr.b.map(([s, e]) => [s + rb.start, e + rb.start]),
  };
}

// Render a text slice, wrapping any part inside `ranges` (absolute char ranges)
// in a light-red highlight. Returns React nodes.
function highlightSlice(slice, sliceStart, ranges) {
  if (!ranges || !ranges.length) return slice;
  const nodes = [], end = sliceStart + slice.length;
  let cur = sliceStart, key = 0;
  for (const [rs, re] of ranges) {
    if (re <= cur) continue;
    if (rs >= end) break;
    const s = Math.max(rs, cur), e = Math.min(re, end);
    if (s > cur) nodes.push(slice.slice(cur - sliceStart, s - sliceStart));
    nodes.push(<mark key={key++} style={{ background: '#fee2e2', color: 'inherit', borderRadius: 2 }}>{slice.slice(s - sliceStart, e - sliceStart)}</mark>);
    cur = e;
  }
  if (cur < end) nodes.push(slice.slice(cur - sliceStart, end - sliceStart));
  return nodes;
}

// Renders a note as bold-headed sections, optionally highlighting matching text.
function NoteBody({ text, highlightRanges }) {
  if (!text) return <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', fontStyle: 'italic' }}>Note text not available.</p>;
  const segs = segmentNote(text);
  return (
    <div>
      {segs.map((seg, i) => {
        const hasValue = seg.value.trim().length > 0;
        // Drop empty banner headers — except Treatment Plan, whose value is now
        // empty by design (its problems follow as their own labelled sections).
        if (seg.divider && !hasValue && seg.label !== 'Treatment Plan') return null;
        return (
          <div key={i} style={{
            marginBottom: seg.label ? 12 : 8,
            ...(seg.divider ? { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--gray-100)' } : {}),
          }}>
            {seg.label && (
              <div style={{
                fontWeight: 700, color: 'var(--navy)', marginBottom: 3,
                fontSize: seg.divider ? '0.82rem' : '0.72rem',
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>
                {seg.label}
              </div>
            )}
            {(hasValue || highlightRanges) && (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.82rem', lineHeight: 1.6, color: seg.label ? 'var(--gray-700)' : 'var(--gray-500)' }}>
                {highlightRanges ? highlightSlice(seg.value, seg.start, highlightRanges) : seg.value.trim()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function noteDateStr(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return isNaN(d) ? String(dt).split(' ')[0] : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Pre-fills the reopen reason: a duplicate message referencing the partner note
// for clone pairs, otherwise the note's own flag text.
function defaultReopenReason(note, partner) {
  // The backend already composed this: mechanical text + the AI's peer message,
  // plus the duplicate paragraph only once the Reviewer confirmed the concern.
  if (note.suggestedReopenMessage) return note.suggestedReopenMessage;
  if (partner) {
    const who = partner.mrn ? `MRN# ${partner.mrn}` : (partner.patientName || 'other client');
    return `Possible duplicate of other client's note — please revise. (${who} and ${noteDateStr(partner.visitDatetime)})`;
  }
  const flags = [...(note.flags || [])];
  if (note.aiFlag) flags.push(note.aiFlag);
  return flags.length ? flags.join('; ') : '';
}

// Does this note's AI review say the off-site rationale is the problem? Drives
// the "select every note missing an off-site rationale" bulk action.
function needsOffsiteRationale(note) {
  const o = note.offsite;
  return !!o && o.applicable !== false
    && ['MISSING', 'PRESENT_TOO_GENERAL', 'UNSUPPORTED'].includes(o.rationaleStatus);
}

// ── At-a-glance clinical context ──────────────────────────────────────────────

// Age, diagnoses and treatment-plan problems, pulled straight off the note text
// (the demographics line, the Diagnosis section, and the "Problem:" headers the
// backend injects into the treatment plan). These three are what the Reviewer
// wants visible without scrolling while reading or comparing a note.
function noteFacts(note) {
  const text = note?.fullNoteText || '';

  const ageM = /\bAge\s*[:\-]\s*(\d+)/i.exec(text);
  const age  = note?.age ?? (ageM ? Number(ageM[1]) : null);

  // Billed session length, as InSync states it ("3 hr 0 min").
  const durM     = /\bTotal Time\s*[:\-]\s*(.*?)\s*(?=\bNote of Session\b|\bEncounter Type\b|\bStart Time\b|$)/i.exec(text);
  const duration = (note?.totalTime || durM?.[1] || '').trim();

  // "Diagnosis F90.2 - ADHD, combined type F34.1 - Dysthymic disorder" — split
  // on the next ICD code, since nothing else delimits one label from the next.
  const dxSection = note?.diagnosis
    || (/\bDiagnosis\s+([A-Z]\d{2}(?:\.\d+)?\s*-[\s\S]*?)(?=Plan \/ Visit Codes|Treatment Plan|Electronically Signed|$)/.exec(text)?.[1] || '');
  const dxs = [];
  const dxRe = /([A-Z]\d{2}(?:\.\d+)?)\s*-\s*(.*?)(?=\s[A-Z]\d{2}(?:\.\d+)?\s*-\s|$)/g;
  let m;
  while ((m = dxRe.exec(dxSection.trim())) !== null) {
    const label = m[2].trim();
    if (label) dxs.push({ code: m[1], label });
  }

  // Problem names only — the goals/interventions under each are in the body.
  // The trailing "(mental health disorder - adult)" qualifier is noise here;
  // strip only that known form so names like "Nicotine Use (Vaping)" survive.
  const problems = [];
  const pRe = /\bProblem:\s*(.+?)\s*\(Last Review Date/gi;
  while ((m = pRe.exec(text)) !== null) {
    const name = m[1].replace(/\s*\((?:mental health|substance use|behavioral health)[^)]*\)\s*$/i, '').trim();
    if (name && !problems.includes(name)) problems.push(name);
  }

  return { age, duration, dxs, problems };
}

const factLbl  = { fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--gray-400)', paddingTop: 3 };
const factDash = { fontSize: '0.78rem', color: 'var(--gray-400)' };

function NoteFacts({ note }) {
  const { age, duration, dxs, problems } = useMemo(() => noteFacts(note), [note]);
  if (age == null && !duration && !dxs.length && !problems.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '5px 10px', marginTop: 8, alignItems: 'start' }}>
      <div style={factLbl}>Age</div>
      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--gray-700)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 7 }}>
        <span>{age != null ? age : '—'}</span>
        <span style={{ color: 'var(--gray-300)' }}>·</span>
        <span style={{ ...factLbl, paddingTop: 0 }}>Duration</span>
        <span>{duration || '—'}</span>
      </div>
      <div style={factLbl}>Dx</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {dxs.length
          ? dxs.map((d, i) => <Chip key={`${d.code}-${i}`} color="blue">{d.code} · {d.label}</Chip>)
          : <span style={factDash}>—</span>}
      </div>
      <div style={factLbl}>Problems</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {problems.length
          ? problems.map((p, i) => <Chip key={`${p}-${i}`} color="orange">{p}</Chip>)
          : <span style={factDash}>—</span>}
      </div>
    </div>
  );
}

// ── AI review panel ───────────────────────────────────────────────────────────

const revLbl = { fontSize: '0.64rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--gray-400)', marginBottom: 3 };

function ReviewRow({ label, status, explanation }) {
  if (!status) return null;
  const bad = /NOT_ALIGNED|NEEDS_REVISION|UNSUPPORTED|MISMATCH|FAIL|MISSING|TOO_GENERAL/.test(status);
  const unknown = /UNABLE_TO_DETERMINE|UNCLEAR/.test(status);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={revLbl}>{label}</div>
      <Chip color={bad ? 'orange' : unknown ? 'gray' : 'blue'}>{status.replace(/_/g, ' ')}</Chip>
      {explanation && (
        <div style={{ fontSize: '0.8rem', color: 'var(--gray-700)', lineHeight: 1.55, marginTop: 4 }}>{explanation}</div>
      )}
    </div>
  );
}

function MessageBlock({ title, body, tone }) {
  if (!body) return null;
  const c = tone === 'supervisor'
    ? { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' }
    : { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412' };
  return (
    <div style={{ marginTop: 12, padding: '10px 12px', background: c.bg, border: `1px solid ${c.border}`, borderRadius: 'var(--radius)' }}>
      <div style={{ ...revLbl, color: c.text }}>{title}</div>
      <div style={{ fontSize: '0.82rem', color: c.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{body}</div>
    </div>
  );
}

// Everything the single AI call decided, laid out for the Reviewer.
// Mechanical findings and the duplicate finding are rendered separately by the
// caller — this panel is only the AI's own output.
function AiReviewPanel({ note }) {
  const [showRaw, setShowRaw] = useState(false);
  const r = note.review;
  if (!r) return (
    <div style={{ fontSize: '0.82rem', color: 'var(--gray-400)', fontStyle: 'italic' }}>
      No AI review stored for this note version.
    </div>
  );

  if (r.decision === 'AI_REVIEW_ERROR') {
    return (
      <div>
        <Chip color="red">AI review error</Chip>
        <div style={{ fontSize: '0.82rem', color: '#991b1b', marginTop: 6 }}>
          {r.error || 'The AI response could not be parsed or validated.'} This note stays in the queue — re-judge to try again.
        </div>
        {r.raw_response && (
          <>
            <button className="btn btn-outline btn-xs" style={{ marginTop: 8 }} onClick={() => setShowRaw(v => !v)}>
              {showRaw ? 'Hide' : 'Show'} raw response
            </button>
            {showRaw && (
              <pre style={{ marginTop: 6, padding: 10, background: '#f8fafc', border: '1px solid var(--gray-100)', borderRadius: 4, fontSize: '0.7rem', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
                {r.raw_response}
              </pre>
            )}
          </>
        )}
      </div>
    );
  }

  const o = r.offsite_review || {};
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <AiDecisionChip decision={r.decision} />
        {r.confidence && <Chip color="gray">confidence {r.confidence.toLowerCase()}</Chip>}
        {r.reused && <Chip color="gray">reused (note unchanged)</Chip>}
      </div>

      {r.review_summary && (
        <div style={{ fontSize: '0.84rem', color: 'var(--gray-700)', lineHeight: 1.6, marginBottom: 12 }}>{r.review_summary}</div>
      )}

      <ReviewRow label="Diagnosis / problem alignment" status={r.diagnosis_problem_alignment?.status} explanation={r.diagnosis_problem_alignment?.explanation} />
      <ReviewRow label="Narrative / goal alignment"    status={r.narrative_goal_alignment?.status}    explanation={r.narrative_goal_alignment?.explanation} />
      <ReviewRow label="Intervention"                  status={r.intervention_response_review?.intervention_status} />
      <ReviewRow label="Client response"               status={r.intervention_response_review?.response_status}
                 explanation={r.intervention_response_review?.explanation} />

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--gray-100)' }}>
        <div style={revLbl}>Off-site review</div>
        {o.applicable === false ? (
          <Chip color="gray">not applicable</Chip>
        ) : (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {o.service_type && <Chip color="blue">{o.service_type.replace(/_/g, ' ')}</Chip>}
            {o.status && <Chip color={o.status === 'PASS' ? 'gray' : 'orange'}>{o.status.replace(/_/g, ' ')}</Chip>}
            {o.rationale_status && <Chip color={/PRESENT_SUFFICIENT|NOT_APPLICABLE/.test(o.rationale_status) ? 'gray' : 'orange'}>rationale: {o.rationale_status.replace(/_/g, ' ').toLowerCase()}</Chip>}
            {o.location_status && <Chip color={/SUFFICIENT|NOT_APPLICABLE/.test(o.location_status) ? 'gray' : 'orange'}>location: {o.location_status.replace(/_/g, ' ').toLowerCase()}</Chip>}
            {o.goal_connection_status && <Chip color={/SUFFICIENT|NOT_APPLICABLE/.test(o.goal_connection_status) ? 'gray' : 'orange'}>goal link: {o.goal_connection_status.replace(/_/g, ' ').toLowerCase()}</Chip>}
          </div>
        )}
        {o.explanation && (
          <div style={{ fontSize: '0.8rem', color: 'var(--gray-700)', lineHeight: 1.55, marginTop: 5 }}>{o.explanation}</div>
        )}
      </div>

      {r.issues?.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--gray-100)' }}>
          <div style={revLbl}>Issues ({r.issues.length})</div>
          {r.issues.map((iss, i) => (
            <div key={i} style={{ marginBottom: 8, paddingLeft: 8, borderLeft: '2px solid var(--gray-200)' }}>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 2 }}>
                {iss.severity && <Chip color={iss.severity === 'NONBILLABLE' || iss.severity === 'SUPERVISOR' ? 'red' : 'orange'}>{iss.severity.toLowerCase()}</Chip>}
                {iss.owner && <Chip color="gray">{iss.owner.replace(/_/g, ' ').toLowerCase()}</Chip>}
                {iss.source && <Chip color="blue">{iss.source.replace(/_/g, ' ').toLowerCase()}</Chip>}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--gray-700)', lineHeight: 1.55 }}>{iss.explanation}</div>
              {iss.evidence_from_note && (
                <div style={{ fontSize: '0.76rem', color: 'var(--gray-500)', fontStyle: 'italic', marginTop: 2 }}>“{iss.evidence_from_note}”</div>
              )}
            </div>
          ))}
        </div>
      )}

      <MessageBlock title="Suggested message to the peer" body={note.suggestedReopenMessage || r.reopen_message_to_peer} />
      <MessageBlock title="Supervisor message" body={r.supervisor_message} tone="supervisor" />

      <div style={{ marginTop: 12, fontSize: '0.68rem', color: 'var(--gray-400)' }}>
        {r.review_version} · {r.model} · reviewed {r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : '—'}
        {r.usage && ` · ${r.usage.input_tokens} in / ${r.usage.output_tokens} out (cache read ${r.usage.cache_read_input_tokens ?? 0})`}
        {r.raw_response && (
          <button className="btn btn-outline btn-xs" style={{ marginLeft: 8 }} onClick={() => setShowRaw(v => !v)}>
            {showRaw ? 'Hide' : 'Show'} raw
          </button>
        )}
      </div>
      {showRaw && r.raw_response && (
        <pre style={{ marginTop: 6, padding: 10, background: '#f8fafc', border: '1px solid var(--gray-100)', borderRadius: 4, fontSize: '0.7rem', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
          {r.raw_response}
        </pre>
      )}
    </div>
  );
}

// ── Draggable / resizable modal shell ─────────────────────────────────────────

// Read and Compare are the two modals that get lived in, so they're movable (by
// the header) and resizable (right edge / bottom edge / corner grip). Position
// and size persist per modal key, so a size you drag to is the size you get next
// time you open it.
const MODAL_MIN_W = 420, MODAL_MIN_H = 260, MODAL_PAD = 8;

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function initialBox(key, defW, defH) {
  let saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch { /* ignore */ }
  if (!saved || typeof saved.w !== 'number') saved = null;
  const w = clampN(saved?.w ?? defW, MODAL_MIN_W, window.innerWidth  - MODAL_PAD * 2);
  const h = clampN(saved?.h ?? defH, MODAL_MIN_H, window.innerHeight - MODAL_PAD * 2);
  // Re-clamp a stored position too — the window may have shrunk since.
  return {
    w, h,
    x: clampN(saved?.x ?? (window.innerWidth - w) / 2, MODAL_PAD, Math.max(MODAL_PAD, window.innerWidth  - w - MODAL_PAD)),
    y: clampN(saved?.y ?? 32,                          MODAL_PAD, Math.max(MODAL_PAD, window.innerHeight - h - MODAL_PAD)),
  };
}

// `bodyScroll` false hands scrolling to the children (Compare scrolls each pane
// independently); true gives the shell one scroll region (Read).
function DraggableModal({ storageKey, defaultWidth, defaultHeight, header, footer, children, onClose, bodyScroll = true }) {
  const [box, setBox] = useState(() => initialBox(storageKey, defaultWidth, defaultHeight));
  const boxRef = useRef(box);
  const setAndTrack = next => { boxRef.current = next; setBox(next); };

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startDrag = mode => e => {
    // Let the close button (and anything else interactive in the header) work.
    if (e.button !== 0 || e.target.closest('button, a, input, textarea, select')) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, box: boxRef.current };

    const onMove = ev => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      const b  = start.box;
      if (mode === 'move') {
        // Keep at least a sliver on screen in every direction so it can't be
        // dragged somewhere unreachable.
        setAndTrack({ ...b,
          x: clampN(b.x + dx, MODAL_PAD - b.w + 140, window.innerWidth - 140),
          y: clampN(b.y + dy, MODAL_PAD, window.innerHeight - 60) });
      } else {
        setAndTrack({ ...b,
          w: mode === 's' ? b.w : clampN(b.w + dx, MODAL_MIN_W, window.innerWidth  - b.x - MODAL_PAD),
          h: mode === 'e' ? b.h : clampN(b.h + dy, MODAL_MIN_H, window.innerHeight - b.y - MODAL_PAD) });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { window.localStorage.setItem(storageKey, JSON.stringify(boxRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h,
        background: 'white', borderRadius: 'var(--radius)', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div onPointerDown={startDrag('move')} style={{ flexShrink: 0, cursor: 'move', userSelect: 'none' }}>
          {header}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: bodyScroll ? 'auto' : 'hidden' }}>
          {children}
        </div>
        {footer}
        <div onPointerDown={startDrag('e')}  style={{ position: 'absolute', top: 0, right: 0, width: 7, height: '100%', cursor: 'ew-resize' }} />
        <div onPointerDown={startDrag('s')}  style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 7, cursor: 'ns-resize' }} />
        <div onPointerDown={startDrag('se')} title="Drag to resize" style={{
          position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 45%, var(--gray-200) 45%, var(--gray-200) 55%, transparent 55%, transparent 70%, var(--gray-200) 70%, var(--gray-200) 80%, transparent 80%)',
        }} />
      </div>
    </div>
  );
}

function ModalClose({ onClose }) {
  return (
    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', padding: '4px 8px' }}>✕</button>
  );
}

function ProgressBar({ pct }) {
  return (
    <div style={{ background: '#e2e8f0', borderRadius: 999, height: 8, overflow: 'hidden', width: '100%' }}>
      <div style={{ background: 'var(--navy)', height: '100%', width: `${pct || 0}%`, transition: 'width 0.3s ease', borderRadius: 999 }} />
    </div>
  );
}

const lbl = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };

// ── NoteModal ─────────────────────────────────────────────────────────────────

function NoteModal({ note, onClose, actions }) {
  if (!note) return null;
  const header = (
    <>
      <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>{note.patientName}</h3>
          <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--gray-500)' }}>
            {note.peerName} · {fmtDt(note.visitDatetime)}
          </p>
          <NoteFacts note={note} />
        </div>
        <ModalClose onClose={onClose} />
      </div>
      <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(note.flags || []).filter(f => !/possible duplicate/i.test(f))
          .map((f, i) => <Chip key={i} color={flagChipColor(f)}>{f}</Chip>)}
        <DupeChip note={note} />
        <AiDecisionChip decision={note.aiDecision} />
        <OffsiteChip offsite={note.offsite} />
      </div>
    </>
  );
  return (
    <DraggableModal
      storageKey="ps.modal.read" defaultWidth={860} defaultHeight={Math.round(window.innerHeight * 0.86)}
      onClose={onClose} header={header}
      footer={actions && (
        <div style={{ flexShrink: 0, padding: '14px 24px', borderTop: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}>
      <div style={{ padding: '20px 24px' }}>
        {/* AI review first — it's what the Reviewer acts on; the note text is
            the evidence they check it against. */}
        <div style={{ marginBottom: 20, padding: 16, background: '#f8fafc', border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)' }}>
          <div style={{ ...sectionLabel, margin: '0 0 10px' }}>AI documentation review</div>
          <AiReviewPanel note={note} />
        </div>
        <NoteBody text={note.fullNoteText} />
      </div>
    </DraggableModal>
  );
}

// ── CompareModal ──────────────────────────────────────────────────────────────

function ComparePane({ note, highlightRanges }) {
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '12px 16px', borderBottom: '1px solid var(--gray-100)', background: '#f8fafc' }}>
        <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>{note.patientName}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', marginTop: 2 }}>
          {note.peerName} · {fmtDt(note.visitDatetime)}
        </div>
        <NoteFacts note={note} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px' }}>
        <NoteBody text={note.fullNoteText} highlightRanges={highlightRanges} />
      </div>
    </div>
  );
}

// The five compared sections, mirroring the backend splitter: scan the labels IN
// ORDER so a stray "Plan:" inside the narrative can't be taken for the header.
const COMPARE_SECTIONS = [
  'Focus of the meeting',
  'What activities took place, and for how long',
  'Peer Support Interventions',
  "Patient's Response/Content",
  'Plan',
];

function splitCompareSections(text) {
  const out = {};
  if (!text) return out;
  let from = 0;
  const marks = [];
  for (const label of COMPARE_SECTIONS) {
    const pattern = escapeRe(label).replace(/,/g, ',?').replace(/\s/g, '\\s+');
    const re = new RegExp(`${pattern}\\s*[:?\\-]\\s*`, 'ig');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) continue;
    marks.push({ label, start: m.index, valueStart: m.index + m[0].length });
    from = m.index + m[0].length;
  }
  for (let i = 0; i < marks.length; i++) {
    let end;
    if (i + 1 < marks.length) end = marks[i + 1].start;
    else {
      const tail = text.slice(marks[i].valueStart);
      end = tail.length;
      for (const re of [/\bF\d{2}\.\d/, /Visit Codes\s*[:\-]/i, /Treatment Plan/, /Electronically Signed/i, /Provider NPI/i])
        { const mm = re.exec(tail); if (mm && mm.index > 0) end = Math.min(end, mm.index); }
      end += marks[i].valueStart;
    }
    out[marks[i].label] = text.slice(marks[i].valueStart, end).replace(/\s+/g, ' ').trim();
  }
  return out;
}

// Side-by-side of just the sections the mechanical check actually matched, with
// that section's own similarity. This is the evidence the human adjudicates on.
function MatchedSections({ a, b, sections }) {
  const secA = useMemo(() => splitCompareSections(a.fullNoteText || ''), [a.fullNoteText]);
  const secB = useMemo(() => splitCompareSections(b.fullNoteText || ''), [b.fullNoteText]);
  if (!sections?.length) return null;
  return (
    <div style={{ flexShrink: 0, marginBottom: 12 }}>
      <div style={{ ...sectionLabel, margin: '0 0 8px' }}>Matched sections ({sections.length})</div>
      {sections.map((s, i) => {
        const ta = secA[s.label] || '', tb = secB[s.label] || '';
        const cr = commonRanges(ta, tb);
        return (
          <div key={i} style={{ marginBottom: 10, border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ padding: '6px 12px', background: '#fff7ed', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: '0.78rem', color: 'var(--navy)' }}>{s.label}</span>
              <Chip color={s.pct >= 90 ? 'red' : 'orange'}>{s.pct}% similar</Chip>
            </div>
            <div style={{ display: 'flex', gap: 0 }}>
              {[{ t: ta, rg: cr?.a }, { t: tb, rg: cr?.b }].map((side, j) => (
                <div key={j} style={{ flex: '1 1 0', minWidth: 0, padding: '8px 12px', fontSize: '0.78rem', lineHeight: 1.55,
                                      color: 'var(--gray-700)', maxHeight: 150, overflowY: 'auto',
                                      borderLeft: j ? '1px solid var(--gray-100)' : 'none' }}>
                  {side.t ? highlightSlice(side.t, 0, side.rg) : <em style={{ color: 'var(--gray-400)' }}>section not found</em>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompareModal({ pair, onClose, onReopen, onSign, onDupeDecision }) {
  const ranges = pair ? scopedCommonRanges(pair.a.fullNoteText || '', pair.b.fullNoteText || '') : null;
  if (!pair) return null;
  const { a, b } = pair;
  const pct = a.clonePct || b.clonePct;
  const sections = a.cloneSections || b.cloneSections || [];
  const decision = a.dupeDecision || b.dupeDecision || null;
  const header = (
    <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>Possible Duplicate</h3>
        {pct != null && <Chip color="orange">{pct}% highest section</Chip>}
        {decision && <Chip color={decision === 'confirmed' ? 'red' : 'gray'}>{decision}</Chip>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', color: 'var(--gray-500)' }}>
          <span style={{ display: 'inline-block', width: 12, height: 12, background: '#fee2e2', borderRadius: 2, border: '1px solid #fecaca' }} />
          matching text
        </span>
      </div>
      <ModalClose onClose={onClose} />
    </div>
  );
  return (
    <DraggableModal
      storageKey="ps.modal.compare" bodyScroll={false}
      defaultWidth={Math.min(1200, window.innerWidth - MODAL_PAD * 2)}
      defaultHeight={Math.round(window.innerHeight * 0.9)}
      onClose={onClose} header={header}
      footer={(onReopen || onSign || onDupeDecision) && (
        <div style={{ flexShrink: 0, padding: '0 20px 16px', display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
          {onDupeDecision && (
            <>
              <button className="btn btn-outline btn-sm" onClick={() => onDupeDecision(a, 'confirmed')}
                title="Reviewer decision: this really is inappropriate copying. Only then is the duplicate paragraph added to the suggested reopen message.">
                Confirm duplicate concern
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => onDupeDecision(a, 'dismissed')}
                title="Reviewer decision: the similarity is legitimate recurring work.">
                Dismiss duplicate concern
              </button>
            </>
          )}
          {onReopen && (
            <button className="btn btn-outline btn-sm"
              onClick={() => onReopen({ title: 'Reopen Both Notes for Revision', notes: [{ note: a, partner: b }, { note: b, partner: a }] })}>
              Reopen Both
            </button>
          )}
          {onSign && (
            <button className="btn btn-gold btn-sm" onClick={() => onSign([a, b])}>Sign Both</button>
          )}
        </div>
      )}>
      <div style={{ height: '100%', boxSizing: 'border-box', padding: '16px 20px', display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
      <MatchedSections a={a} b={b} sections={sections} />
      <div style={{ flex: 1, display: 'flex', gap: 14, minHeight: 260 }}>
        {[{ note: a, rg: ranges?.a, other: b }, { note: b, rg: ranges?.b, other: a }].map(({ note, rg, other }) => (
          <div key={note.eid} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ComparePane note={note} highlightRanges={rg} />
            {(onReopen || onSign) && (
              <div style={{ flexShrink: 0, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                {onReopen && (
                  <button className="btn btn-outline btn-sm"
                    onClick={() => onReopen({ title: `Reopen ${note.patientName}'s Note`, notes: [{ note, partner: other }] })}>
                    Reopen
                  </button>
                )}
                {onSign && (
                  <button className="btn btn-gold btn-sm" onClick={() => onSign([note])}>Sign</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      </div>
    </DraggableModal>
  );
}

// ── ReopenModal ───────────────────────────────────────────────────────────────

// ctx = { title, notes: [{ note, partner }] }. Reopens (sends back to the peer
// for revision) one or more notes, each with an editable reason. onDone receives
// the eids that were successfully reopened.
function ReopenModal({ ctx, onClose, onDone }) {
  const [reasons, setReasons] = useState([]);
  const [busy,    setBusy]    = useState(false);
  // undefined = follow the Settings switch; false/true = override for this batch.
  const [sendEmail, setSendEmail] = useState(undefined);
  const [results, setResults] = useState(null);   // { [eid]: { ok, message } }
  const [progress, setProgress] = useState(null); // { done, total } while sending
  const [bulkText, setBulkText] = useState('');
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (ctx) { setReasons(ctx.notes.map(n => defaultReopenReason(n.note, n.partner))); setResults(null); setBusy(false); setBulkText(''); setProgress(null); setCompact(ctx.notes.length > 5); }
  }, [ctx]);

  if (!ctx) return null;

  // Reopening is two InSync round-trips per note (claim gate, then the edit),
  // plus an optional email. A 30-note batch in one request would sit long enough
  // to risk a proxy timeout, so send in small chunks and report progress as each
  // lands. Partial failure is fine: results accumulate per note either way.
  const CHUNK = 5;

  async function submit() {
    setBusy(true);
    setProgress({ done: 0, total: ctx.notes.length });
    const byEid = {}, okIds = [];
    try {
      for (let i = 0; i < ctx.notes.length; i += CHUNK) {
        const slice = ctx.notes.slice(i, i + CHUNK);
        const payload = slice.map((n) => ({
          eid: n.note.eid, pid: n.note.pid, reason: reasons[ctx.notes.indexOf(n)],
          client:    n.note.patientName,
          visitDate: n.note.visitDate,
          startTime: n.note.startTimeStr,
          endTime:   n.note.endTimeStr,
          peer:      n.note.peerName,
          // Same segments the Read view renders → identical PDF.
          segments:  segmentNote(n.note.fullNoteText || ''),
        }));
        const { results: res } = await api.post('/ps/cosign/reopen', { notes: payload, sendEmail });
        (res || []).forEach(r => {
          byEid[r.eid] = r;
          const match = ctx.notes.find(x => x.note.eid === r.eid);
          if (r.ok && match) okIds.push(match.note.eid);
        });
        setResults({ ...byEid });
        setProgress({ done: Math.min(i + CHUNK, ctx.notes.length), total: ctx.notes.length });
      }
      if (okIds.length) onDone(okIds);
    } catch (ex) {
      setResults({ ...byEid });
      alert(`Reopen stopped after ${Object.keys(byEid).length} of ${ctx.notes.length}: ${ex.message}`);
    }
    finally { setBusy(false); setProgress(null); }
  }

  const allDone = results && ctx.notes.every(n => results[n.note.eid]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 16px', overflowY: 'auto',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'white', borderRadius: 'var(--radius)', width: '100%', maxWidth: 1040, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>{ctx.title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--gray-600)' }}>
            Reopening sends the note back to the peer for revision. Billed encounters cannot be reopened.
            {ctx.notes.length > 1 && ' Each note keeps its own reason — edit any of them below, or set one reason for all.'}
          </p>

          {/* Bulk: one reason applied to every note in the batch. The per-note
              text stays editable afterwards, so this is a starting point, not a
              lock. */}
          {ctx.notes.length > 1 && !allDone && (
            <div style={{ padding: 14, background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)' }}>
              <label style={lbl}>Set one reason for all {ctx.notes.length} notes</label>
              <textarea
                className="form-input" rows={4} value={bulkText} disabled={busy}
                onChange={e => setBulkText(e.target.value)}
                placeholder="e.g. Because this service occurred off-site on or after July 28, 2026, please add an explicit sentence explaining why this specific client needed the service outside the clinic rather than at the clinic on that date…"
                style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.82rem' }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-outline btn-sm" disabled={busy || !bulkText.trim()}
                  onClick={() => setReasons(rs => rs.map((v, i) => (results?.[ctx.notes[i].note.eid]?.ok ? v : bulkText)))}>
                  Apply to all {ctx.notes.length}
                </button>
                <button className="btn btn-outline btn-sm" disabled={busy}
                  onClick={() => setReasons(ctx.notes.map(n => defaultReopenReason(n.note, n.partner)))}>
                  Reset to each note's own AI message
                </button>
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setCompact(c => !c)}>
                  {compact ? 'Show full notes' : 'Hide note text'}
                </button>
              </div>
            </div>
          )}
          {ctx.notes.map((n, i) => {
            const r = results?.[n.note.eid];
            return (
              <div key={n.note.eid || i} style={{
                display: 'flex', gap: 16, flexWrap: 'wrap',
                paddingTop: i > 0 ? 18 : 0, borderTop: i > 0 ? '1px solid var(--gray-100)' : 'none',
              }}>
                {/* Left: the note itself, to reference while writing the reason.
                    Hidden in compact mode so a 30-note batch stays navigable. */}
                <div style={{ flex: compact ? '0 0 240px' : '1 1 340px', minWidth: 0, border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--gray-100)', background: '#f8fafc' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--navy)' }}>{n.note.patientName}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginTop: 2 }}>
                      {n.note.peerName} · {fmtDt(n.note.visitDatetime)}{n.note.mrn ? ` · MRN ${n.note.mrn}` : ''}
                    </div>
                  </div>
                  {!compact && (
                    <div style={{ padding: '12px 14px', maxHeight: '52vh', overflowY: 'auto' }}>
                      <NoteBody text={n.note.fullNoteText} />
                    </div>
                  )}
                </div>
                {/* Right: the reopen reason */}
                <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <label style={lbl}>Reason for reopening</label>
                  <textarea
                    className="form-input" value={reasons[i] || ''}
                    onChange={e => setReasons(rs => rs.map((v, j) => j === i ? e.target.value : v))}
                    disabled={busy || (r && r.ok)}
                    placeholder="Reason for reopening (required)"
                    style={{ width: '100%', flex: 1, minHeight: compact ? 90 : 180, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.82rem' }}
                  />
                  {r && (
                    <div style={{ marginTop: 8, fontSize: '0.78rem', fontWeight: 600 }}>
                      <div style={{ color: r.ok ? '#15803d' : '#dc2626' }}>
                        {r.ok ? '✓ Reopened for revision' : `✗ ${r.message || 'Failed'}`}
                      </div>
                      {r.ok && (r.emailSkipped
                        ? <div style={{ color: 'var(--gray-500)', fontWeight: 500 }}>✉ Email off — no notification sent</div>
                        : r.emailSent
                          ? <div style={{ color: '#15803d', fontWeight: 500 }}>✉ Notification email sent</div>
                          : <div style={{ color: '#b45309', fontWeight: 500 }}>⚠ Reopened, but the email failed: {r.emailError || 'unknown error'}</div>)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {!allDone ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--gray-600)', cursor: 'pointer' }}
              title="Overrides the Settings switch for this batch only.">
              <input type="checkbox" checked={sendEmail === false}
                onChange={e => setSendEmail(e.target.checked ? false : undefined)}
                style={{ width: 14, height: 14 }} />
              Don't send a notification email for these
            </label>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-outline btn-sm" onClick={onClose}>{allDone ? 'Close' : 'Cancel'}</button>
          {!allDone && (
            <button className="btn btn-gold btn-sm" onClick={submit}
              disabled={busy || reasons.some(r => !r?.trim())}>
              {busy
                ? (progress ? `Reopening ${progress.done} of ${progress.total}…` : 'Reopening…')
                : ctx.notes.length > 1 ? `Reopen ${ctx.notes.length} Notes` : 'Reopen Note'}
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SettingsTab ───────────────────────────────────────────────────────────────

// Proves that what is saved in Settings is what the next AI review actually
// sends. Fetches the composed system prompt straight from the engine the ingest
// and rejudge paths use — not a client-side reconstruction.
function PromptProvenance() {
  const [data, setData]   = useState(null);
  const [open, setOpen]   = useState(false);
  const [error, setError] = useState('');

  async function check() {
    setError('');
    try { setData(await api.get('/ps/cosign/prompt-preview')); setOpen(true); }
    catch (ex) { setError(ex.message); }
  }

  return (
    <section style={{ ...sectionStyle, background: '#f0fdf4', borderColor: '#bbf7d0' }}>
      <p style={{ ...sectionLabel, color: '#15803d' }}>What the AI is actually being sent</p>
      <p style={{ margin: '0 0 10px', fontSize: '0.8rem', color: 'var(--gray-600)', lineHeight: 1.6 }}>
        Loads the exact system prompt the next review will use, straight from the engine — so you can
        confirm your saved edits are live rather than trusting the text box above.
      </p>
      <button className="btn btn-outline btn-sm" onClick={check}>Verify the live prompt</button>
      {error && <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#dc2626' }}>{error}</div>}
      {data && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <Chip color={data.core.source.startsWith('custom') ? 'blue' : 'gray'}>Core: {data.core.source}</Chip>
            <Chip color={data.offsite.source.startsWith('custom') ? 'blue' : 'gray'}>Off-site: {data.offsite.source}</Chip>
            <Chip color="gray">{data.chars.toLocaleString()} chars total</Chip>
          </div>
          {(data.core.matchesSaved === false || data.offsite.matchesSaved === false) && (
            <div style={{ fontSize: '0.8rem', color: '#dc2626', marginBottom: 8 }}>
              ⚠ The live prompt does not match what is saved — save again and re-check.
            </div>
          )}
          <button className="btn btn-outline btn-xs" onClick={() => setOpen(o => !o)}>
            {open ? 'Hide' : 'Show'} the full prompt
          </button>
          {open && (
            <pre style={{ marginTop: 8, padding: 12, background: 'white', border: '1px solid var(--gray-200)',
                          borderRadius: 4, fontSize: '0.7rem', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                          maxHeight: 420, overflowY: 'auto' }}>{data.systemPrompt}</pre>
          )}
          <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--gray-500)' }}>{data.note}</div>
        </div>
      )}
    </section>
  );
}

function SettingsTab() {
  const [form, setForm] = useState({
    insync_username: '', insync_password: '', anthropic_api_key: '',
    no_school_start: '', no_school_end: '', provider_id: '',
    prompt_core_review: '', prompt_offsite: '',
    qa_email: '', qa_cc: '', reopen_from: '', reopen_reply_to: '', reopen_email_enabled: true,
  });
  const [defaults, setDefaults] = useState({ prompt_core_review: '', prompt_offsite: '' });
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [showPass, setShowPass] = useState(false);

  useEffect(() => {
    api.get('/ps/cosign/settings').then(s => {
      setForm({
        insync_username:   s.insync_username   || '',
        insync_password:   s.insync_password   || '',
        anthropic_api_key: s.anthropic_api_key || '',
        no_school_start:   s.no_school_start   || '',
        no_school_end:     s.no_school_end     || '',
        provider_id:       s.provider_id       || '',
        prompt_core_review: s.prompt_core_review || '',
        prompt_offsite:     s.prompt_offsite     || '',
        qa_email:          s.qa_email          || '',
        reopen_email_enabled: s.reopen_email_enabled !== false,
        qa_cc:             s.qa_cc             || '',
        reopen_from:       s.reopen_from       || '',
        reopen_reply_to:   s.reopen_reply_to   || '',
      });
      setDefaults({
        prompt_core_review: s.default_prompt_core_review || '',
        prompt_offsite:     s.default_prompt_offsite     || '',
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.post('/ps/cosign/settings', form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (ex) { alert(ex.message); }
    finally { setSaving(false); }
  }

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 540 }}>
      <h3 style={{ margin: '0 0 20px', fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>Co-Sign Settings</h3>

      <section style={sectionStyle}>
        <p style={sectionLabel}>InSync Credentials</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl}>Username</label>
            <input className="form-input" value={form.insync_username} onChange={set('insync_username')} placeholder="InSync login email" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={lbl}>Password</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPass ? 'text' : 'password'}
                className="form-input" value={form.insync_password} onChange={set('insync_password')}
                placeholder="InSync password" style={{ width: '100%', paddingRight: 68 }}
              />
              <button type="button" onClick={() => setShowPass(p => !p)} style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--gray-500)',
              }}>{showPass ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div>
            <label style={lbl}>Provider ID</label>
            <input className="form-input" value={form.provider_id} onChange={set('provider_id')} placeholder="e.g. 2317" style={{ width: 140 }} />
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <p style={sectionLabel}>Anthropic (Claude) API Key</p>
        <input
          type="password" className="form-input" value={form.anthropic_api_key} onChange={set('anthropic_api_key')}
          placeholder="sk-ant-…" style={{ width: '100%' }}
        />
      </section>

      <section style={sectionStyle}>
        <p style={sectionLabel}>No-School Date Range</p>
        <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: 'var(--gray-500)' }}>
          Sessions during this window won't trigger the "minor during school hours" flag. Format: MM/DD
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div>
            <label style={lbl}>Start (MM/DD)</label>
            <input className="form-input" value={form.no_school_start} onChange={set('no_school_start')} placeholder="07/01" style={{ width: 100 }} />
          </div>
          <div style={{ color: 'var(--gray-400)', paddingTop: 22 }}>→</div>
          <div>
            <label style={lbl}>End (MM/DD)</label>
            <input className="form-input" value={form.no_school_end} onChange={set('no_school_end')} placeholder="08/31" style={{ width: 100 }} />
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <p style={sectionLabel}>Reopen Notification Email</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!form.reopen_email_enabled}
            onChange={e => setForm(f => ({ ...f, reopen_email_enabled: e.target.checked }))}
            style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--navy)' }}>
            Send an email when a note is reopened
          </span>
        </label>
        <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: 'var(--gray-500)' }}>
          {form.reopen_email_enabled
            ? 'On — reopening a note emails a PDF of it to the recipient below. '
            : 'Off — notes still reopen in InSync and still move to “Waiting on Peer”; no email goes out. '}
          You can also silence a single batch from the Reopen dialog without changing this switch.
          The “From” address must be a domain verified in Resend — otherwise leave it blank (system default) and set Reply-to to your work email.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={lbl}>Notification recipient</label>
            <input className="form-input" value={form.qa_email} onChange={set('qa_email')} placeholder="peer-manager@example.com" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={lbl}>CC (optional — e.g. yourself, for a paper trail)</label>
            <input className="form-input" value={form.qa_cc} onChange={set('qa_cc')} placeholder="you@yourclinic.com" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={lbl}>From (blank = system default; must be Resend-verified)</label>
            <input className="form-input" value={form.reopen_from} onChange={set('reopen_from')} placeholder="you@yourclinic.com" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={lbl}>Reply-to (where replies go)</label>
            <input className="form-input" value={form.reopen_reply_to} onChange={set('reopen_reply_to')} placeholder="you@yourclinic.com" style={{ width: '100%' }} />
          </div>
        </div>
      </section>

      <div style={{ ...sectionStyle, background: '#eff6ff', borderColor: '#bfdbfe' }}>
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#1e40af', lineHeight: 1.6 }}>
          <strong>Duplicate awareness is mechanical and has no AI prompt.</strong> Notes are compared
          section by section (Focus, Activities, Interventions, Patient's Response, Plan) using text
          similarity only — zero AI calls. A note is flagged when one substantive section is at least
          90% similar, or when at least two sections are at least 80% similar. The Plan section can
          support a flag but never triggers one on its own. You decide whether a flagged pair is
          really inappropriate copying, in the Compare view.
        </p>
      </div>

      <div style={{ ...sectionStyle, background: '#f8fafc' }}>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--gray-700)', lineHeight: 1.6 }}>
          The two prompts below are joined into <strong>one</strong> AI request per note version,
          together with a fixed JSON output contract. They are instructions only — the note's own data
          is sent separately, which is what keeps the instruction text identical across notes so it can
          be cached. Do not paste note data or <code>{'{{tokens}}'}</code> into them.
        </p>
      </div>

      <PromptEditor
        title="AI Prompt — Core Peer Note QA"
        help="Narrative-to-goal, diagnosis-to-problem, intervention, client response, and who owns each correction. Runs on every note."
        tokens={[]}
        value={form.prompt_core_review}
        onChange={v => setForm(f => ({ ...f, prompt_core_review: v }))}
        defaultValue={defaults.prompt_core_review}
      />

      <PromptEditor
        title="AI Prompt — Off-Site Review Addendum"
        help="Service-type classification and the off-site rationale rules, including the effective date. Sent in the same request as the core prompt."
        tokens={[]}
        value={form.prompt_offsite}
        onChange={v => setForm(f => ({ ...f, prompt_offsite: v }))}
        defaultValue={defaults.prompt_offsite}
      />

      <PromptProvenance />

      <button className="btn btn-gold" onClick={save} disabled={saving} style={{ marginTop: 8 }}>
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Settings'}
      </button>
    </div>
  );
}

// Editor for one AI prompt. Warns (without blocking) when an edit drops a data
// placeholder or the JSON contract — both fail silently at scan time otherwise:
// a missing token hides part of the note from the AI, and a broken JSON shape
// makes the parse throw and the note come back "clean".
// The V2 review prompts are instruction-only (their data arrives in a separate
// user message, which is what makes the instruction text cacheable), so both
// lists are empty for them and the placeholder/contract warnings stay hidden.
function PromptEditor({ title, help, tokens = [], value, onChange, defaultValue, requiredKeys = [] }) {
  const isDefault    = !value.trim() || value.trim() === (defaultValue || '').trim();
  const missingToken = tokens.filter(t => !value.includes(t));
  const missingJson  = requiredKeys.filter(k => !value.includes(k));
  const warn = value.trim() && (missingToken.length || missingJson.length);

  return (
    <section style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <p style={{ ...sectionLabel, margin: 0 }}>{title}</p>
        <button type="button" className="btn btn-outline btn-xs"
          onClick={() => onChange(defaultValue || '')}
          disabled={isDefault}
          title="Restore the built-in prompt">
          Reset to default
        </button>
      </div>
      <p style={{ margin: '8px 0 10px', fontSize: '0.8rem', color: 'var(--gray-500)' }}>{help}</p>

      <textarea
        className="form-input" rows={14}
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={defaultValue}
        spellCheck={false}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.76rem', lineHeight: 1.55 }}
      />

      <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--gray-500)' }}>
        {tokens.length === 0
          ? "Instructions only — the note's data is sent separately, so this text stays identical across notes and can be cached."
          : "Placeholders — keep these, they inject the note's data: "}
        {tokens.map((t, i) => (
          <code key={t} style={{
            background: value.includes(t) ? '#f1f5f9' : '#fef2f2',
            color:      value.includes(t) ? 'var(--gray-600)' : '#dc2626',
            border: '1px solid var(--gray-200)', borderRadius: 3, padding: '1px 5px',
            marginRight: 4, display: 'inline-block', marginTop: 3,
          }}>{t}{i < 0 ? ',' : ''}</code>
        ))}
      </div>

      {warn ? (
        <div style={{ marginTop: 10, padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', fontSize: '0.76rem', color: '#dc2626' }}>
          {missingToken.length > 0 && (
            <div>⚠ Missing placeholder{missingToken.length > 1 ? 's' : ''}: {missingToken.join(', ')} — the AI won't see that part of the note.</div>
          )}
          {missingJson.length > 0 && (
            <div>⚠ The closing JSON instruction must still ask for {missingJson.join(' and ')} — otherwise every note silently comes back clean.</div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--gray-400)' }}>
          {isDefault ? 'Using the built-in default.' : '✓ Custom prompt — placeholders and JSON contract look intact.'}
        </div>
      )}
    </section>
  );
}

const sectionStyle = { marginBottom: 24, padding: 18, background: '#f8fafc', borderRadius: 'var(--radius)', border: '1px solid var(--gray-100)' };
const sectionLabel = { margin: '0 0 12px', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--gray-500)' };
// ── VersionsModal ─────────────────────────────────────────────────────────────

// Side-by-side of every stored version of one note (oldest → newest). The point
// of reopening is to check the peer actually addressed the feedback, so the old
// and revised versions sit next to each other.
function VersionPane({ note }) {
  const statusColor = { pending: 'blue', reopened: 'orange', signed: 'gray', superseded: 'gray' }[note.status] || 'gray';
  return (
    <div style={{ flex: '1 1 320px', minWidth: 0, border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--gray-100)', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>Version {note.version}</span>
        <Chip color={statusColor}>{note.status}</Chip>
        <Chip color={note.verdict === 'clean' ? 'gray' : 'red'}>{note.verdict}</Chip>
      </div>
      {note.reopenReason && (
        <div style={{ padding: '8px 16px', background: '#fff7ed', borderBottom: '1px solid var(--gray-100)', fontSize: '0.76rem', color: '#9a3412' }}>
          <strong>Reopen reason:</strong> {note.reopenReason}
        </div>
      )}
      <div style={{ padding: '14px 16px', maxHeight: '58vh', overflowY: 'auto' }}>
        <NoteBody text={note.fullNoteText} />
      </div>
    </div>
  );
}

function VersionsModal({ versions, onClose }) {
  if (!versions) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 16px', overflowY: 'auto',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'white', borderRadius: 'var(--radius)', width: '100%', maxWidth: 1200, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>
            {versions[0]?.patientName} — {versions.length} version{versions.length > 1 ? 's' : ''}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', padding: '4px 8px' }}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {versions.map(v => <VersionPane key={v.id} note={v} />)}
        </div>
      </div>
    </div>
  );
}

// ── QueueTab ──────────────────────────────────────────────────────────────────

const VIEWS = [['queue', 'Queue'], ['reopened', 'Waiting on Peer'], ['archive', 'Archive']];

function StatTile({ label, val, color }) {
  return (
    <div style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '12px 20px', minWidth: 130, textAlign: 'center' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 800, color }}>{val}</div>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
    </div>
  );
}

// "MM/DD/YYYY" (as InSync gives visit_date) → a local Date, or null.
function parseVisit(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || '');
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
}

// A compact multi-select dropdown: a button that opens a checkbox popover.
// `options` are strings; `selected`/`onChange` carry a Set.
function MultiFilter({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const toggle = opt => { const n = new Set(selected); n.has(opt) ? n.delete(opt) : n.add(opt); onChange(n); };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-outline btn-sm" onClick={() => setOpen(o => !o)} style={{ whiteSpace: 'nowrap' }}>
        {label}{selected.size ? ` (${selected.size})` : ''} ▾
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 51,
            background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.15)', minWidth: 200, maxHeight: 300, overflowY: 'auto', padding: 6,
          }}>
            {options.length === 0 && <div style={{ padding: 8, fontSize: '0.8rem', color: 'var(--gray-400)' }}>None</div>}
            {options.map(opt => (
              <label key={opt} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 6px', fontSize: '0.8rem', cursor: 'pointer', color: 'var(--gray-700)' }}>
                <input type="checkbox" checked={selected.has(opt)} onChange={() => toggle(opt)} style={{ width: 14, height: 14, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Grouping ──────────────────────────────────────────────────────────────────

// Default view: peer > client, each client's notes newest first. "None" is a
// flat list in the same date order. Grouping is presentation only — selection,
// signing and every action keep working on the same note objects.
const GROUP_MODES = [['peer', 'Peer › client'], ['client', 'Client'], ['none', 'No grouping']];

function noteTime(n) {
  const d = new Date(n.visitDatetime || n.visitDate || 0);
  return isNaN(d) ? 0 : d.getTime();
}

// → [{ key, label, children: [{ key, label, notes }] }] for peer mode,
//   [{ key, label, notes }] for client mode, or null for 'none'.
function groupNotes(list, mode) {
  const byDateDesc = (a, b) => noteTime(b) - noteTime(a);
  if (mode === 'none') return null;

  if (mode === 'client') {
    const m = new Map();
    for (const n of list) {
      const k = n.patientName || '(no client)';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(n);
    }
    return [...m.entries()]
      .map(([label, notes]) => ({ key: label, label, notes: notes.sort(byDateDesc) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  const peers = new Map();
  for (const n of list) {
    const p = n.peerName || '(no peer)';
    const c = n.patientName || '(no client)';
    if (!peers.has(p)) peers.set(p, new Map());
    const clients = peers.get(p);
    if (!clients.has(c)) clients.set(c, []);
    clients.get(c).push(n);
  }
  return [...peers.entries()].map(([peer, clients]) => ({
    key: peer, label: peer,
    children: [...clients.entries()]
      .map(([client, notes]) => ({ key: `${peer}|${client}`, label: client, notes: notes.sort(byDateDesc) }))
      // Clients ordered by their most recent note, so the freshest work is on top.
      .sort((a, b) => noteTime(b.notes[0]) - noteTime(a.notes[0])),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function GroupPicker({ mode, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)' }}>Group by</span>
      {GROUP_MODES.map(([key, label]) => (
        <button key={key} type="button"
          className={mode === key ? 'btn btn-gold btn-xs' : 'btn btn-outline btn-xs'}
          onClick={() => onChange(key)}>{label}</button>
      ))}
    </div>
  );
}

// Renders a list either flat (mode 'none') or grouped, with collapsible headers.
function GroupedNotes({ notes, mode, renderNote, collapsed, onToggle }) {
  const groups = useMemo(() => groupNotes(notes, mode), [notes, mode]);
  const flat = useMemo(() => [...notes].sort((a, b) => noteTime(b) - noteTime(a)), [notes]);

  if (!groups) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{flat.map(renderNote)}</div>;
  }

  const hdr = (label, count, key, level) => (
    <button type="button" onClick={() => onToggle(key)}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
        fontWeight: level === 0 ? 800 : 700,
        fontSize: level === 0 ? '0.85rem' : '0.8rem',
        color: level === 0 ? 'var(--navy)' : 'var(--gray-600)',
      }}>
      <span style={{ color: 'var(--gray-400)' }}>{collapsed.has(key) ? '▸' : '▾'}</span>
      {label}
      <span style={{ fontWeight: 600, color: 'var(--gray-400)', fontSize: '0.72rem' }}>({count})</span>
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map(g => {
        const total = g.children ? g.children.reduce((n, c) => n + c.notes.length, 0) : g.notes.length;
        return (
          <div key={g.key}>
            {hdr(g.label, total, g.key, 0)}
            {!collapsed.has(g.key) && (g.children ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 14, borderLeft: '2px solid var(--gray-100)' }}>
                {g.children.map(c => (
                  <div key={c.key}>
                    {hdr(c.label, c.notes.length, c.key, 1)}
                    {!collapsed.has(c.key) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{c.notes.map(renderNote)}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 14, borderLeft: '2px solid var(--gray-100)' }}>
                {g.notes.map(renderNote)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function QueueTab() {
  const [view,     setView]     = useState('queue');   // queue | reopened | archive
  const [notes,    setNotes]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [pulling,  setPulling]  = useState(false);
  const [progress, setProgress] = useState(null);      // { msg, pct }
  const [search,   setSearch]   = useState('');
  const [query,    setQuery]    = useState('');         // committed search term
  const [selected, setSelected] = useState(new Set());
  const [busyIds,  setBusyIds]  = useState(new Set());
  const [showClean,   setShowClean]   = useState(false);
  const [rejudgingId, setRejudgingId] = useState(null);
  const [noteModal,    setNoteModal]    = useState(null);
  const [compareModal, setCompareModal] = useState(null);   // { a, b }
  const [reopenCtx,    setReopenCtx]    = useState(null);
  const [versionsModal, setVersionsModal] = useState(null); // [versions]
  const [fClient, setFClient] = useState(new Set());
  const [groupMode, setGroupMode] = useState(() => {
    try { return window.localStorage.getItem('ps.groupMode') || 'peer'; } catch { return 'peer'; }
  });
  const [collapsed, setCollapsed] = useState(new Set());
  useEffect(() => { try { window.localStorage.setItem('ps.groupMode', groupMode); } catch { /* ignore */ } }, [groupMode]);
  const toggleGroup = key => setCollapsed(prev => {
    const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n;
  });
  const [fPeer,   setFPeer]   = useState(new Set());
  const [fLen,    setFLen]    = useState(new Set());
  const [dFrom,   setDFrom]   = useState('');
  const [dTo,     setDTo]     = useState('');
  const esRef = useRef(null);

  const clearFilters = () => { setFClient(new Set()); setFPeer(new Set()); setFLen(new Set()); setDFrom(''); setDTo(''); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let path;
      if (view === 'reopened')    path = '/ps/cosign/notes?status=reopened';
      else if (view === 'archive') path = `/ps/cosign/notes?status=signed,superseded${query ? `&q=${encodeURIComponent(query)}` : ''}`;
      else                        path = '/ps/cosign/notes?status=pending';
      const data = await api.get(path);
      setNotes(Array.isArray(data) ? data : []);
      setSelected(new Set());
    } catch (ex) { alert(ex.message); }
    finally { setLoading(false); }
  }, [view, query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (esRef.current) esRef.current.close(); }, []);
  // Filter options are drawn from the current view's notes, so reset on switch.
  useEffect(() => { setFClient(new Set()); setFPeer(new Set()); setFLen(new Set()); setDFrom(''); setDTo(''); }, [view]);

  async function startPull() {
    if (pulling) return;
    setPulling(true);
    setProgress({ msg: 'Connecting…', pct: 0 });
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) { alert('Not logged in'); setPulling(false); return; }

    const es = new EventSource(`${API}/api/ps/cosign/pull?token=${encodeURIComponent(token)}`);
    esRef.current = es;
    es.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'progress') setProgress({ msg: msg.msg, pct: msg.pct });
        else if (msg.type === 'done') {
          const s = msg.stats || {};
          setPulling(false); setProgress(null); es.close();
          load();
          alert(`Pull complete — ${s.new || 0} new, ${s.revised || 0} revised, ${s.skipped || 0} already had${s.reconciled ? `, ${s.reconciled} un-signed (reconciled)` : ''}.`);
        } else if (msg.type === 'error') {
          alert('Pull error: ' + msg.message);
          setPulling(false); setProgress(null); es.close();
        }
      } catch {}
    };
    es.onerror = () => { alert('Connection lost during pull.'); setPulling(false); setProgress(null); es.close(); };
  }

  async function signNotes(list, label) {
    if (!list.length) return;
    const ids = new Set(list.map(n => n.eid));
    setBusyIds(s => new Set([...s, ...ids]));
    try {
      const slim = list.map(n => ({ eid: n.eid, cosignId: n.cosignId, cosignReqId: n.cosignReqId }));
      const { signed, failed } = await api.post('/ps/cosign/sign', { notes: slim });
      alert(`${label}: ${signed} signed${failed > 0 ? `, ${failed} failed` : ''}.`);
      await load();
    } catch (ex) { alert('Sign error: ' + ex.message); }
    finally { setBusyIds(s => { const n = new Set(s); ids.forEach(i => n.delete(i)); return n; }); }
  }

  async function rejudge(note) {
    setRejudgingId(note.id);
    try { await api.post('/ps/cosign/rejudge', { id: note.id }); await load(); }
    catch (ex) { alert('Re-judge error: ' + ex.message); }
    finally { setRejudgingId(null); }
  }

  // The human's duplicate call. The mechanical score never decides on its own —
  // only a confirmed concern adds the duplicate paragraph to the suggested
  // reopen message, and dismissing it never reopens anything.
  async function setDupeDecision(note, decision) {
    try {
      await api.post(`/ps/cosign/notes/${note.id}/dupe-decision`, { decision });
      setCompareModal(null);
      await load();
    } catch (ex) { alert('Could not record the duplicate decision: ' + ex.message); }
  }

  async function openVersions(eid) {
    try { setVersionsModal(await api.get(`/ps/cosign/notes/${eid}/versions`)); }
    catch (ex) { alert(ex.message); }
  }

  function toggleSelect(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // Filter options come from what's actually loaded, sorted.
  const uniq = sel => [...new Set(notes.map(sel).filter(Boolean))].sort();
  const clientOpts = uniq(n => n.patientName);
  const peerOpts   = uniq(n => n.peerName);
  const lenOpts    = uniq(n => n.totalTime);
  const hasFilter  = fClient.size || fPeer.size || fLen.size || dFrom || dTo;

  const fromD = dFrom ? new Date(dFrom + 'T00:00:00') : null;
  const toD   = dTo   ? new Date(dTo   + 'T23:59:59') : null;
  const filtered = notes.filter(n => {
    if (fClient.size && !fClient.has(n.patientName)) return false;
    if (fPeer.size   && !fPeer.has(n.peerName))      return false;
    if (fLen.size    && !fLen.has(n.totalTime))      return false;
    if (fromD || toD) {
      const d = parseVisit(n.visitDate);
      if (d) { if (fromD && d < fromD) return false; if (toD && d > toD) return false; }
    }
    return true;
  });

  const clean   = filtered.filter(n => n.verdict === 'clean');
  const flagged = filtered.filter(n => n.verdict === 'flagged');
  // Clone partner is resolved against the FULL set, so a filtered-out partner
  // is still reachable from Compare.
  const partnerOf = note => note.clonePartnerEid ? notes.find(x => x.eid === note.clonePartnerEid) : null;
  const selectedFlagged = flagged.filter(n => selected.has(n.eid));
  // Flagged notes whose only-or-main gap is the explicit off-site rationale.
  const offsiteGap = flagged.filter(needsOffsiteRationale);

  const filterBar = (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <MultiFilter label="Client"  options={clientOpts} selected={fClient} onChange={setFClient} />
      <MultiFilter label="Peer"    options={peerOpts}   selected={fPeer}   onChange={setFPeer} />
      <MultiFilter label="Length"  options={lenOpts}    selected={fLen}    onChange={setFLen} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)' }}>Date</span>
        <input type="date" className="form-input" value={dFrom} onChange={e => setDFrom(e.target.value)} style={{ padding: '5px 8px', fontSize: '0.8rem' }} />
        <span style={{ color: 'var(--gray-400)' }}>–</span>
        <input type="date" className="form-input" value={dTo} onChange={e => setDTo(e.target.value)} style={{ padding: '5px 8px', fontSize: '0.8rem' }} />
      </div>
      {hasFilter ? <button className="btn btn-outline btn-sm" onClick={clearFilters}>Clear filters</button> : null}
      <div style={{ flexBasis: '100%', height: 0 }} />
      <GroupPicker mode={groupMode} onChange={setGroupMode} />
      {groupMode !== 'none' && collapsed.size > 0 && (
        <button className="btn btn-outline btn-xs" onClick={() => setCollapsed(new Set())}>Expand all</button>
      )}
    </div>
  );

  function signClean() {
    if (!clean.length) return;
    if (!window.confirm(`Sign all ${clean.length} clean notes? This co-signs them in InSync.`)) return;
    signNotes(clean, 'Bulk sign clean');
  }
  function toggleAll() {
    setSelected(selected.size === flagged.length ? new Set() : new Set(flagged.map(n => n.eid)));
  }

  // One note row, with the action buttons appropriate to the current view.
  function NoteRow({ note, checkbox }) {
    const busy    = busyIds.has(note.eid);
    const partner = partnerOf(note);
    return (
      <div style={{
        background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
        padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 12,
      }}>
        {checkbox && (
          <input type="checkbox" checked={selected.has(note.eid)} onChange={() => toggleSelect(note.eid)}
            style={{ width: 15, height: 15, marginTop: 3, flexShrink: 0 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>{note.patientName}</span>
            {note.version > 1 && <Chip color="gray">v{note.version}</Chip>}
            {view === 'archive' && <Chip color={note.status === 'signed' ? 'gray' : 'blue'}>{note.status}</Chip>}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', margin: '2px 0 6px' }}>
            {note.peerName} · {fmtDt(note.visitDatetime)}
          </div>
          {/* Separate chips per track — mechanical, duplicate, AI. Never merged. */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(note.flags || [])
              .filter(f => !/possible duplicate/i.test(f))
              .map((f, i) => <Chip key={i} color={flagChipColor(f)}>{f}</Chip>)}
            <DupeChip note={note} />
            <AiDecisionChip decision={note.aiDecision} />
            <OffsiteChip offsite={note.offsite} />
          </div>
          {note.reopenReason && view === 'reopened' && (
            <div style={{ fontSize: '0.78rem', color: '#9a3412', marginTop: 4 }}><strong>Reopen reason:</strong> {note.reopenReason}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 260 }}>
          {partner && <button className="btn btn-outline btn-xs" onClick={() => setCompareModal({ a: note, b: partner })}>Compare</button>}
          {note.version > 1 && <button className="btn btn-outline btn-xs" onClick={() => openVersions(note.eid)}>Versions</button>}
          <button className="btn btn-outline btn-xs" onClick={() => setNoteModal(note)}>Read</button>
          {view === 'queue' && note.verdict === 'flagged' && (
            <button className="btn btn-outline btn-xs" onClick={() => rejudge(note)} disabled={rejudgingId === note.id}>
              {rejudgingId === note.id ? '…' : 'Re-judge'}
            </button>
          )}
          {view === 'queue' && (
            <button className="btn btn-outline btn-xs"
              onClick={() => setReopenCtx({ title: `Reopen ${note.patientName}'s Note`, notes: [{ note, partner }] })}>
              Reopen
            </button>
          )}
          {view === 'queue' && (
            <button className="btn btn-gold btn-xs" onClick={() => signNotes([note], 'Sign')} disabled={busy}>
              {busy ? '…' : 'Sign'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* View tabs + pull */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {VIEWS.map(([key, label]) => (
            <button key={key} onClick={() => setView(key)} style={{
              background: view === key ? 'var(--navy)' : 'white',
              color: view === key ? 'white' : 'var(--gray-600)',
              border: '1px solid var(--gray-200)', borderRadius: 999, cursor: 'pointer',
              padding: '6px 16px', fontSize: '0.8rem', fontWeight: 600,
            }}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, justifyContent: 'flex-end', minWidth: 200 }}>
          {pulling && progress && (
            <div style={{ flex: 1, maxWidth: 280 }}>
              <div style={{ fontSize: '0.74rem', color: 'var(--gray-600)', marginBottom: 4 }}>{progress.msg}</div>
              <ProgressBar pct={progress.pct} />
            </div>
          )}
          <button className="btn btn-gold btn-sm" onClick={startPull} disabled={pulling} style={{ whiteSpace: 'nowrap' }}>
            {pulling ? 'Pulling…' : '⟳ Pull new notes'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, color: 'var(--gray-400)', textAlign: 'center' }}>Loading…</div>
      ) : view === 'queue' ? (
        <div>
          {filterBar}
          <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatTile label="Clean · ready to sign" val={clean.length} color="#16a34a" />
            <StatTile label="Flagged · needs review" val={flagged.length} color="#dc2626" />
          </div>

          {notes.length === 0 && (
            <div style={{ background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '24px', textAlign: 'center', color: 'var(--gray-500)', fontSize: '0.88rem' }}>
              Queue is empty. Hit <strong>Pull new notes</strong> to fetch from InSync.
            </div>
          )}
          {notes.length > 0 && filtered.length === 0 && (
            <div style={{ background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '24px', textAlign: 'center', color: 'var(--gray-500)', fontSize: '0.88rem' }}>
              No notes match the filters. <button className="btn btn-outline btn-xs" onClick={clearFilters} style={{ marginLeft: 6 }}>Clear filters</button>
            </div>
          )}

          {/* Clean stack */}
          {clean.length > 0 && (
            <div style={{ marginBottom: 24, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius)', padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <button onClick={() => setShowClean(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 700, color: '#15803d', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {showClean ? '▾' : '▸'} Clean stack — ready to sign ({clean.length})
                </button>
                <button className="btn btn-gold btn-sm" onClick={signClean} disabled={busyIds.size > 0}>
                  Bulk sign all ({clean.length})
                </button>
              </div>
              {showClean && (
                <div style={{ marginTop: 12 }}>
                  <GroupedNotes notes={clean} mode={groupMode} collapsed={collapsed} onToggle={toggleGroup}
                    renderNote={note => <NoteRow key={note.id} note={note} />} />
                </div>
              )}
            </div>
          )}

          {/* Flagged queue */}
          {flagged.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <h4 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>Needs review ({flagged.length})</h4>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', color: 'var(--gray-600)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={flagged.length > 0 && selected.size === flagged.length} onChange={toggleAll} style={{ width: 14, height: 14 }} />
                    All
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {/* One click to select every note the AI says is missing an
                      off-site rationale — the common bulk case. */}
                  {offsiteGap.length > 0 && (
                    <button className="btn btn-outline btn-sm"
                      onClick={() => setSelected(new Set(offsiteGap.map(n => n.eid)))}
                      title="Select every flagged note whose AI review says the off-site rationale is missing or too general">
                      Select missing off-site rationale ({offsiteGap.length})
                    </button>
                  )}
                  {selectedFlagged.length > 0 && (
                    <>
                      <button className="btn btn-gold btn-sm" disabled={busyIds.size > 0}
                        onClick={() => setReopenCtx({
                          title: `Reopen ${selectedFlagged.length} Note${selectedFlagged.length > 1 ? 's' : ''}`,
                          notes: selectedFlagged.map(note => ({ note, partner: partnerOf(note) })),
                        })}>
                        Reopen selected ({selectedFlagged.length})
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => signNotes(selectedFlagged, `Sign selected (${selectedFlagged.length})`)} disabled={busyIds.size > 0}>
                        Sign selected ({selectedFlagged.length})
                      </button>
                    </>
                  )}
                </div>
              </div>
              <GroupedNotes notes={flagged} mode={groupMode} collapsed={collapsed} onToggle={toggleGroup}
                renderNote={note => <NoteRow key={note.id} note={note} checkbox />} />
            </div>
          )}
        </div>
      ) : view === 'reopened' ? (
        <div>
          {filterBar}
          {filtered.length === 0 ? (
            <div style={{ padding: 30, color: 'var(--gray-400)', textAlign: 'center', fontSize: '0.88rem' }}>
              {notes.length === 0 ? 'Nothing waiting on a peer.' : 'No notes match the filters.'}
            </div>
          ) : (
            <GroupedNotes notes={filtered} mode={groupMode} collapsed={collapsed} onToggle={toggleGroup}
              renderNote={note => <NoteRow key={note.id} note={note} />} />
          )}
        </div>
      ) : (
        <div>
          <form onSubmit={e => { e.preventDefault(); setQuery(search.trim()); }} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input className="form-input" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search archive by client or peer name…" style={{ flex: 1, maxWidth: 360 }} />
            <button className="btn btn-outline btn-sm" type="submit">Search</button>
            {query && <button className="btn btn-outline btn-sm" type="button" onClick={() => { setSearch(''); setQuery(''); }}>Clear</button>}
          </form>
          {filterBar}
          {filtered.length === 0 ? (
            <div style={{ padding: 30, color: 'var(--gray-400)', textAlign: 'center', fontSize: '0.88rem' }}>
              {notes.length === 0 ? (query ? 'No matches.' : 'No signed notes yet.') : 'No notes match the filters.'}
            </div>
          ) : (
            <GroupedNotes notes={filtered} mode={groupMode} collapsed={collapsed} onToggle={toggleGroup}
              renderNote={note => <NoteRow key={note.id} note={note} />} />
          )}
        </div>
      )}

      <NoteModal
        note={noteModal}
        onClose={() => setNoteModal(null)}
        actions={noteModal && (() => {
          const n = noteModal;
          const partner = partnerOf(n);
          const busy = busyIds.has(n.eid);
          return (
            <>
              {partner && (
                <button className="btn btn-outline btn-sm" onClick={() => { setNoteModal(null); setCompareModal({ a: n, b: partner }); }}>Compare</button>
              )}
              {view === 'queue' && n.verdict === 'flagged' && (
                <button className="btn btn-outline btn-sm" onClick={() => { rejudge(n); setNoteModal(null); }} disabled={rejudgingId === n.id}>
                  {rejudgingId === n.id ? '…' : 'Re-judge'}
                </button>
              )}
              {view === 'queue' && (
                <button className="btn btn-outline btn-sm" onClick={() => { setNoteModal(null); setReopenCtx({ title: `Reopen ${n.patientName}'s Note`, notes: [{ note: n, partner }] }); }}>Reopen</button>
              )}
              {view === 'queue' && (
                <button className="btn btn-gold btn-sm" onClick={() => { setNoteModal(null); signNotes([n], 'Sign'); }} disabled={busy}>
                  {busy ? '…' : 'Sign'}
                </button>
              )}
            </>
          );
        })()} />
      <CompareModal
        pair={compareModal}
        onClose={() => setCompareModal(null)}
        onReopen={view === 'queue' ? (ctx => { setCompareModal(null); setReopenCtx(ctx); }) : undefined}
        onSign={view === 'queue' ? (list => { setCompareModal(null); signNotes(list, 'Sign'); }) : undefined}
        onDupeDecision={view === 'queue' ? setDupeDecision : undefined} />
      <VersionsModal versions={versionsModal} onClose={() => setVersionsModal(null)} />
      <ReopenModal ctx={reopenCtx} onClose={() => setReopenCtx(null)} onDone={() => { setReopenCtx(null); load(); }} />
    </div>
  );
}

// ── PSCoSignPage ──────────────────────────────────────────────────────────────

export default function PSCoSignPage() {
  const [tab, setTab] = useState('queue');
  // Settings is admin-only; ps_cosign accounts get the Queue and nothing else,
  // so for them the tab strip collapses to a single tab and is hidden.
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const tabs = isAdmin ? [['queue', 'Queue'], ['settings', 'Settings']] : [['queue', 'Queue']];

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1000, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Co-Sign Review</h2>

      {/* Sub-tabs */}
      <div style={{ display: tabs.length > 1 ? 'flex' : 'none', gap: 0, marginBottom: 28, borderBottom: '2px solid var(--gray-100)' }}>
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 20px', fontSize: '0.85rem', fontWeight: tab === key ? 700 : 400,
            color: tab === key ? 'var(--navy)' : 'var(--gray-400)',
            borderBottom: tab === key ? '2px solid var(--navy)' : '2px solid transparent',
            marginBottom: -2, transition: 'color 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {tab === 'settings' && isAdmin ? <SettingsTab /> : <QueueTab />}
    </div>
  );
}
