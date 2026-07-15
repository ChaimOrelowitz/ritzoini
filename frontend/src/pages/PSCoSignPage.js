import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import supabase from '../supabaseClient';

const API = process.env.REACT_APP_API_URL || 'http://localhost:4000';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDt(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  return isNaN(d) ? dt : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

function flagChipColor(flag) {
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
        if (seg.divider && !hasValue) return null;   // drop empty banner headers
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
  if (partner) {
    const who = partner.mrn ? `MRN# ${partner.mrn}` : (partner.patientName || 'other client');
    return `Possible duplicate of other client's note — please revise. (${who} and ${noteDateStr(partner.visitDatetime)})`;
  }
  const flags = [...(note.flags || [])];
  if (note.aiFlag && note.aiReason) flags.push(note.aiReason);
  return flags.length ? flags.join('; ') : '';
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

function NoteModal({ note, onClose }) {
  if (!note) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 16px', overflowY: 'auto',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'white', borderRadius: 'var(--radius)', width: '100%', maxWidth: 760,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>{note.patientName}</h3>
            <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--gray-500)' }}>
              {note.peerName} · {fmtDt(note.visitDatetime)}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', padding: '4px 8px' }}>✕</button>
        </div>
        {note.flags?.length > 0 && (
          <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {note.flags.map((f, i) => <Chip key={i} color={flagChipColor(f)}>{f}</Chip>)}
            {note.aiFlag && note.aiReason && <Chip color="red">AI: {note.aiReason}</Chip>}
          </div>
        )}
        <div style={{ padding: '20px 24px', maxHeight: '60vh', overflowY: 'auto' }}>
          <NoteBody text={note.fullNoteText} />
        </div>
      </div>
    </div>
  );
}

// ── CompareModal ──────────────────────────────────────────────────────────────

function ComparePane({ note, highlightRanges }) {
  return (
    <div style={{ flex: '1 1 320px', minWidth: 0, border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--gray-100)', background: '#f8fafc' }}>
        <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>{note.patientName}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', marginTop: 2 }}>
          {note.peerName} · {fmtDt(note.visitDatetime)}
        </div>
      </div>
      <div style={{ padding: '14px 16px', maxHeight: '58vh', overflowY: 'auto' }}>
        <NoteBody text={note.fullNoteText} highlightRanges={highlightRanges} />
      </div>
    </div>
  );
}

function CompareModal({ pair, onClose, onReopen }) {
  const ranges = pair ? scopedCommonRanges(pair.a.fullNoteText || '', pair.b.fullNoteText || '') : null;
  if (!pair) return null;
  const { a, b } = pair;
  const pct = a.clonePct || b.clonePct;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 16px', overflowY: 'auto',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'white', borderRadius: 'var(--radius)', width: '100%', maxWidth: 1200,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>Possible Cloned Notes</h3>
            {pct && <Chip color="orange">{pct}% match</Chip>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', color: 'var(--gray-500)' }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#fee2e2', borderRadius: 2, border: '1px solid #fecaca' }} />
              matching text
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', padding: '4px 8px' }}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <ComparePane note={a} highlightRanges={ranges?.a} />
          <ComparePane note={b} highlightRanges={ranges?.b} />
        </div>
        {onReopen && (
          <div style={{ padding: '0 20px 18px', display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-outline btn-sm" onClick={() => onReopen({ title: `Reopen ${a.patientName}'s Note`, notes: [{ note: a, partner: b }] })}>
              Reopen {a.patientName}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => onReopen({ title: `Reopen ${b.patientName}'s Note`, notes: [{ note: b, partner: a }] })}>
              Reopen {b.patientName}
            </button>
            <button className="btn btn-gold btn-sm" onClick={() => onReopen({ title: 'Reopen Both Notes for Revision', notes: [{ note: a, partner: b }, { note: b, partner: a }] })}>
              Reopen Both
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ReopenModal ───────────────────────────────────────────────────────────────

// ctx = { title, notes: [{ note, partner }] }. Reopens (sends back to the peer
// for revision) one or more notes, each with an editable reason. onDone receives
// the eids that were successfully reopened.
function ReopenModal({ ctx, onClose, onDone }) {
  const [reasons, setReasons] = useState([]);
  const [busy,    setBusy]    = useState(false);
  const [results, setResults] = useState(null);   // { [eid]: { ok, message } }

  useEffect(() => {
    if (ctx) { setReasons(ctx.notes.map(n => defaultReopenReason(n.note, n.partner))); setResults(null); setBusy(false); }
  }, [ctx]);

  if (!ctx) return null;

  async function submit() {
    setBusy(true);
    try {
      const payload = ctx.notes.map((n, i) => ({ eid: n.note.eid, pid: n.note.pid, reason: reasons[i] }));
      const { results: res } = await api.post('/ps/cosign/reopen', { notes: payload });
      const byEid = {}, okIds = [];
      (res || []).forEach(r => {
        byEid[r.eid] = r;
        const match = ctx.notes.find(x => x.note.eid === r.eid);
        if (r.ok && match) okIds.push(match.note.eid);
      });
      setResults(byEid);
      if (okIds.length) onDone(okIds);
    } catch (ex) { alert('Reopen error: ' + ex.message); }
    finally { setBusy(false); }
  }

  const allDone = results && ctx.notes.every(n => results[n.note.eid]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 16px', overflowY: 'auto',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'white', borderRadius: 'var(--radius)', width: '100%', maxWidth: 620, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>{ctx.title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--gray-600)' }}>
            Reopening sends the note back to the peer for revision. Billed encounters cannot be reopened.
          </p>
          {ctx.notes.map((n, i) => {
            const r = results?.[n.note.eid];
            return (
              <div key={n.note.eid || i}>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--navy)', marginBottom: 2 }}>{n.note.patientName}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginBottom: 6 }}>
                  {n.note.peerName} · {fmtDt(n.note.visitDatetime)}{n.note.mrn ? ` · MRN ${n.note.mrn}` : ''}
                </div>
                <textarea
                  className="form-input" rows={3} value={reasons[i] || ''}
                  onChange={e => setReasons(rs => rs.map((v, j) => j === i ? e.target.value : v))}
                  disabled={busy || (r && r.ok)}
                  placeholder="Reason for reopening (required)"
                  style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.82rem' }}
                />
                {r && (
                  <div style={{ marginTop: 6, fontSize: '0.78rem', fontWeight: 600, color: r.ok ? '#15803d' : '#dc2626' }}>
                    {r.ok ? '✓ Reopened for revision' : `✗ ${r.message || 'Failed'}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-outline btn-sm" onClick={onClose}>{allDone ? 'Close' : 'Cancel'}</button>
          {!allDone && (
            <button className="btn btn-gold btn-sm" onClick={submit}
              disabled={busy || reasons.some(r => !r?.trim())}>
              {busy ? 'Reopening…' : ctx.notes.length > 1 ? `Reopen ${ctx.notes.length} Notes` : 'Reopen Note'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── HistoryAccordion ──────────────────────────────────────────────────────────

function HistoryAccordion({ history, onCompare }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(null);

  if (!history.length) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 10,
        fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--gray-400)', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {open ? '▾' : '▸'} Run History ({history.length})
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {history.map(run => (
            <div key={run.id} style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', background: 'white', overflow: 'hidden' }}>
              <button onClick={() => setExpanded(expanded === run.id ? null : run.id)} style={{
                width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left',
              }}>
                <span style={{ fontSize: '0.82rem', color: 'var(--gray-500)', minWidth: 160 }}>
                  {fmtDt(run.created_at)}
                </span>
                <span style={{ fontSize: '0.82rem', color: 'var(--gray-700)' }}>
                  {run.total} scanned · <span style={{ color: '#dc2626' }}>{run.flagged_count} flagged</span> · {run.clean_count} clean · {run.signed_count} signed
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--gray-400)', fontSize: '0.8rem' }}>{expanded === run.id ? '▲' : '▼'}</span>
              </button>
              {expanded === run.id && run.flagged_notes?.length > 0 && (
                <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--gray-100)' }}>
                  <p style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '10px 0 6px' }}>
                    Flagged Notes
                  </p>
                  {run.flagged_notes.map((n, i) => {
                    const partner = n.clonePartnerEid
                      ? run.flagged_notes.find(x => x.eid === n.clonePartnerEid)
                      : null;
                    return (
                      <div key={i} style={{ fontSize: '0.8rem', color: 'var(--gray-700)', padding: '4px 0', borderBottom: '1px solid var(--gray-100)', display: 'flex', gap: 12, alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, minWidth: 160 }}>{n.patientName}</span>
                        <span style={{ color: 'var(--gray-500)' }}>{n.peerName}</span>
                        <span style={{ color: 'var(--gray-400)' }}>{fmtDt(n.visitDatetime)}</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                          {n.flags?.map((f, j) => <Chip key={j} color={flagChipColor(f)}>{f}</Chip>)}
                          {partner && (
                            <button className="btn btn-outline btn-xs" onClick={() => onCompare({ a: n, b: partner })}>Compare</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SettingsTab ───────────────────────────────────────────────────────────────

function SettingsTab() {
  const [form, setForm] = useState({
    insync_username: '', insync_password: '', anthropic_api_key: '',
    no_school_start: '', no_school_end: '', provider_id: '',
  });
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

      <button className="btn btn-gold" onClick={save} disabled={saving} style={{ marginTop: 8 }}>
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Settings'}
      </button>
    </div>
  );
}

const sectionStyle = { marginBottom: 24, padding: 18, background: '#f8fafc', borderRadius: 'var(--radius)', border: '1px solid var(--gray-100)' };
const sectionLabel = { margin: '0 0 12px', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--gray-500)' };

// ── RunReviewTab ──────────────────────────────────────────────────────────────

function RunReviewTab() {
  const [scanning,    setScanning]    = useState(false);
  const [progress,    setProgress]    = useState(null);   // { msg, pct }
  const [scanResult,  setScanResult]  = useState(null);   // { flagged, clean, runId }
  const [selected,    setSelected]    = useState(new Set());
  const [signingIds,  setSigningIds]  = useState(new Set());
  const [signedIds,   setSignedIds]   = useState(new Set());
  const [reopenedIds, setReopenedIds] = useState(new Set());
  const [noteModal,    setNoteModal]    = useState(null);
  const [compareModal, setCompareModal] = useState(null);   // { a, b }
  const [reopenCtx,    setReopenCtx]    = useState(null);   // { title, notes: [{note, partner}] }
  const [history,     setHistory]     = useState([]);
  const [histLoading, setHistLoading] = useState(true);
  const esRef = useRef(null);

  useEffect(() => {
    api.get('/ps/cosign/history').then(h => setHistory(Array.isArray(h) ? h : [])).catch(() => {}).finally(() => setHistLoading(false));
    return () => { if (esRef.current) esRef.current.close(); };
  }, []);

  async function startScan() {
    if (scanning) return;
    setScanning(true);
    setProgress({ msg: 'Connecting…', pct: 0 });
    setScanResult(null);
    setSelected(new Set());
    setSignedIds(new Set());

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) { alert('Not logged in'); setScanning(false); return; }

    const es = new EventSource(`${API}/api/ps/cosign/scan?token=${encodeURIComponent(token)}`);
    esRef.current = es;

    es.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'progress') {
          setProgress({ msg: msg.msg, pct: msg.pct });
        } else if (msg.type === 'done') {
          setScanResult({ flagged: msg.flagged || [], clean: msg.clean || [], runId: msg.runId });
          setScanning(false);
          setProgress(null);
          setHistory(h => [{ id: msg.runId, created_at: new Date().toISOString(), total: (msg.flagged?.length || 0) + (msg.clean?.length || 0), flagged_count: msg.flagged?.length || 0, clean_count: msg.clean?.length || 0, signed_count: 0, flagged_notes: msg.flagged || [] }, ...h]);
          es.close();
        } else if (msg.type === 'error') {
          alert('Scan error: ' + msg.message);
          setScanning(false);
          setProgress(null);
          es.close();
        }
      } catch {}
    };

    es.onerror = () => {
      if (!scanResult) {
        alert('Connection lost during scan.');
        setScanning(false);
        setProgress(null);
      }
      es.close();
    };
  }

  function toggleSelect(id) {
    setSelected(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  const isDone = id => signedIds.has(id) || reopenedIds.has(id);

  function toggleAll() {
    if (!scanResult) return;
    const unsignedFlagged = scanResult.flagged.filter(n => !isDone(n.eid));
    if (selected.size === unsignedFlagged.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(unsignedFlagged.map(n => n.eid)));
    }
  }

  async function signNotes(notes, label) {
    if (!notes.length) return;
    const ids = new Set(notes.map(n => n.eid));
    setSigningIds(s => new Set([...s, ...ids]));
    try {
      // Send only the fields bulkSign needs — full note objects (with note text)
      // overflow the server's JSON body limit on large batches (HTTP 413).
      const slim = notes.map(n => ({ eid: n.eid, cosignId: n.cosignId, cosignReqId: n.cosignReqId }));
      const { signed, failed } = await api.post('/ps/cosign/sign', { notes: slim, runId: scanResult?.runId });
      setSignedIds(s => new Set([...s, ...ids]));
      setSelected(sel => { const n = new Set(sel); ids.forEach(id => n.delete(id)); return n; });
      alert(`${label}: ${signed} signed${failed > 0 ? `, ${failed} failed` : ''}.`);
    } catch (ex) { alert('Sign error: ' + ex.message); }
    finally { setSigningIds(s => { const n = new Set(s); ids.forEach(id => n.delete(id)); return n; }); }
  }

  async function signClean() {
    if (!scanResult?.clean?.length) return;
    if (!window.confirm(`Sign all ${scanResult.clean.length} clean notes?`)) return;
    await signNotes(scanResult.clean, 'Sign All Clean');
  }

  const flaggedUnsigned = scanResult ? scanResult.flagged.filter(n => !isDone(n.eid)) : [];
  const selectedNotes   = scanResult ? scanResult.flagged.filter(n => selected.has(n.eid) && !isDone(n.eid)) : [];
  const cleanUnsigned   = scanResult ? scanResult.clean.filter(n => !isDone(n.eid)) : [];

  return (
    <div>
      {/* Run button + progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className="btn btn-gold" onClick={startScan} disabled={scanning} style={{ minWidth: 120 }}>
          {scanning ? 'Scanning…' : 'Run Now'}
        </button>
        {scanning && progress && (
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--gray-600)', marginBottom: 5 }}>{progress.msg}</div>
            <ProgressBar pct={progress.pct} />
          </div>
        )}
      </div>

      {/* Stats */}
      {scanResult && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Total',   val: scanResult.flagged.length + scanResult.clean.length, color: 'var(--navy)' },
            { label: 'Flagged', val: scanResult.flagged.length, color: '#dc2626' },
            { label: 'Clean',   val: scanResult.clean.length,   color: '#16a34a' },
            { label: 'Signed',  val: signedIds.size,            color: '#64748b' },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '12px 20px', minWidth: 110, textAlign: 'center' }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 800, color }}>{val}</div>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Flagged notes list */}
      {scanResult && scanResult.flagged.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h4 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>
                Flagged Notes ({flaggedUnsigned.length} remaining)
              </h4>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', color: 'var(--gray-600)', cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={flaggedUnsigned.length > 0 && selected.size === flaggedUnsigned.length}
                  onChange={toggleAll}
                  style={{ width: 14, height: 14 }} />
                All
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedNotes.length > 0 && (
                <button className="btn btn-outline btn-sm"
                  onClick={() => signNotes(selectedNotes, `Sign Selected (${selectedNotes.length})`)}
                  disabled={signingIds.size > 0}>
                  Sign Selected ({selectedNotes.length})
                </button>
              )}
              {cleanUnsigned.length > 0 && (
                <button className="btn btn-gold btn-sm" onClick={signClean} disabled={signingIds.size > 0}>
                  Sign All Clean ({cleanUnsigned.length})
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {scanResult.flagged.map(note => {
              const id       = note.eid;
              const signed   = signedIds.has(id);
              const reopened = reopenedIds.has(id);
              const signing  = signingIds.has(id);
              const done     = signed || reopened;
              const partner  = note.clonePartnerEid
                ? scanResult.flagged.find(x => x.eid === note.clonePartnerEid)
                : null;
              return (
                <div key={id} style={{
                  background: 'white', border: `1px solid ${signed ? '#bbf7d0' : reopened ? '#fed7aa' : 'var(--gray-200)'}`,
                  borderRadius: 'var(--radius)', padding: '12px 16px',
                  opacity: done ? 0.55 : 1,
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                }}>
                  <input type="checkbox"
                    checked={selected.has(id) && !done}
                    disabled={done}
                    onChange={() => toggleSelect(id)}
                    style={{ width: 15, height: 15, marginTop: 3, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>{note.patientName}</span>
                      {signed   && <Chip color="gray">Signed ✓</Chip>}
                      {reopened && <Chip color="orange">Reopened ↩</Chip>}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', margin: '2px 0 6px' }}>
                      {note.peerName} · {fmtDt(note.visitDatetime)}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {note.flags?.map((f, i) => <Chip key={i} color={flagChipColor(f)}>{f}</Chip>)}
                      {note.aiFlag && note.aiReason && <Chip color="red">AI: {note.aiReason}</Chip>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {partner && (
                      <button className="btn btn-outline btn-xs" onClick={() => setCompareModal({ a: note, b: partner })}>Compare</button>
                    )}
                    <button className="btn btn-outline btn-xs" onClick={() => setNoteModal(note)}>Read</button>
                    {!done && (
                      <button className="btn btn-outline btn-xs"
                        onClick={() => setReopenCtx({ title: `Reopen ${note.patientName}'s Note`, notes: [{ note, partner }] })}>
                        Reopen
                      </button>
                    )}
                    {!done && (
                      <button className="btn btn-outline btn-xs" onClick={() => signNotes([note], 'Sign')} disabled={signing}>
                        {signing ? '…' : 'Sign'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {scanResult && scanResult.flagged.length === 0 && scanResult.clean.length > 0 && (
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius)', padding: '14px 18px', marginBottom: 24 }}>
          <p style={{ margin: 0, fontWeight: 600, color: '#15803d', fontSize: '0.88rem' }}>
            All {scanResult.clean.length} notes are clean. No flags found.
          </p>
          {cleanUnsigned.length > 0 && (
            <button className="btn btn-gold btn-sm" onClick={signClean} disabled={signingIds.size > 0} style={{ marginTop: 10 }}>
              Sign All ({cleanUnsigned.length})
            </button>
          )}
        </div>
      )}

      {/* History */}
      {!histLoading && <HistoryAccordion history={history} onCompare={setCompareModal} />}

      <NoteModal note={noteModal} onClose={() => setNoteModal(null)} />
      <CompareModal pair={compareModal} onClose={() => setCompareModal(null)} onReopen={ctx => { setCompareModal(null); setReopenCtx(ctx); }} />
      <ReopenModal
        ctx={reopenCtx}
        onClose={() => setReopenCtx(null)}
        onDone={ids => setReopenedIds(s => new Set([...s, ...ids]))}
      />
    </div>
  );
}

// ── PSCoSignPage ──────────────────────────────────────────────────────────────

export default function PSCoSignPage() {
  const [tab, setTab] = useState('run');

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Co-Sign Review</h2>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 28, borderBottom: '2px solid var(--gray-100)' }}>
        {[['run', 'Run & Review'], ['settings', 'Settings']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 20px', fontSize: '0.85rem', fontWeight: tab === key ? 700 : 400,
            color: tab === key ? 'var(--navy)' : 'var(--gray-400)',
            borderBottom: tab === key ? '2px solid var(--navy)' : '2px solid transparent',
            marginBottom: -2, transition: 'color 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {tab === 'settings' ? <SettingsTab /> : <RunReviewTab />}
    </div>
  );
}
