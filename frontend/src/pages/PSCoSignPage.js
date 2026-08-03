import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { api } from '../utils/api';
import supabase from '../supabaseClient';

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
  if (partner) {
    const who = partner.mrn ? `MRN# ${partner.mrn}` : (partner.patientName || 'other client');
    return `Possible duplicate of other client's note — please revise. (${who} and ${noteDateStr(partner.visitDatetime)})`;
  }
  const flags = [...(note.flags || [])];
  if (note.aiFlag) flags.push(note.aiFlag);
  return flags.length ? flags.join('; ') : '';
}

// ── At-a-glance clinical context ──────────────────────────────────────────────

// Age, diagnoses and treatment-plan problems, pulled straight off the note text
// (the demographics line, the Diagnosis section, and the "Problem:" headers the
// backend injects into the treatment plan). These three are what the supervisor
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
      {note.flags?.length > 0 && (
        <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {note.flags.map((f, i) => <Chip key={i} color={flagChipColor(f)}>{f}</Chip>)}
          {note.aiFlag && <Chip color="red">AI: {note.aiFlag}</Chip>}
        </div>
      )}
    </>
  );
  return (
    <DraggableModal
      storageKey="ps.modal.read" defaultWidth={760} defaultHeight={Math.round(window.innerHeight * 0.86)}
      onClose={onClose} header={header}
      footer={actions && (
        <div style={{ flexShrink: 0, padding: '14px 24px', borderTop: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}>
      <div style={{ padding: '20px 24px' }}>
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

function CompareModal({ pair, onClose, onReopen, onSign }) {
  const ranges = pair ? scopedCommonRanges(pair.a.fullNoteText || '', pair.b.fullNoteText || '') : null;
  if (!pair) return null;
  const { a, b } = pair;
  const pct = a.clonePct || b.clonePct;
  const header = (
    <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '1rem' }}>Possible Cloned Notes</h3>
        {pct && <Chip color="orange">{pct}% match</Chip>}
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
      footer={(onReopen || onSign) && (
        <div style={{ flexShrink: 0, padding: '0 20px 16px', display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
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
      <div style={{ height: '100%', boxSizing: 'border-box', padding: '16px 20px', display: 'flex', gap: 14, minHeight: 0 }}>
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
  const [results, setResults] = useState(null);   // { [eid]: { ok, message } }

  useEffect(() => {
    if (ctx) { setReasons(ctx.notes.map(n => defaultReopenReason(n.note, n.partner))); setResults(null); setBusy(false); }
  }, [ctx]);

  if (!ctx) return null;

  async function submit() {
    setBusy(true);
    try {
      const payload = ctx.notes.map((n, i) => ({
        eid: n.note.eid, pid: n.note.pid, reason: reasons[i],
        client:    n.note.patientName,
        visitDate: n.note.visitDate,
        startTime: n.note.startTimeStr,
        endTime:   n.note.endTimeStr,
        peer:      n.note.peerName,
        // Same segments the Read view renders → identical PDF.
        segments:  segmentNote(n.note.fullNoteText || ''),
      }));
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
      <div style={{ background: 'white', borderRadius: 'var(--radius)', width: '100%', maxWidth: 1040, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
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
              <div key={n.note.eid || i} style={{
                display: 'flex', gap: 16, flexWrap: 'wrap',
                paddingTop: i > 0 ? 18 : 0, borderTop: i > 0 ? '1px solid var(--gray-100)' : 'none',
              }}>
                {/* Left: the note itself, to reference while writing the reason */}
                <div style={{ flex: '1 1 340px', minWidth: 0, border: '1px solid var(--gray-100)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--gray-100)', background: '#f8fafc' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--navy)' }}>{n.note.patientName}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginTop: 2 }}>
                      {n.note.peerName} · {fmtDt(n.note.visitDatetime)}{n.note.mrn ? ` · MRN ${n.note.mrn}` : ''}
                    </div>
                  </div>
                  <div style={{ padding: '12px 14px', maxHeight: '52vh', overflowY: 'auto' }}>
                    <NoteBody text={n.note.fullNoteText} />
                  </div>
                </div>
                {/* Right: the reopen reason */}
                <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <label style={lbl}>Reason for reopening</label>
                  <textarea
                    className="form-input" value={reasons[i] || ''}
                    onChange={e => setReasons(rs => rs.map((v, j) => j === i ? e.target.value : v))}
                    disabled={busy || (r && r.ok)}
                    placeholder="Reason for reopening (required)"
                    style={{ width: '100%', flex: 1, minHeight: 180, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.82rem' }}
                  />
                  {r && (
                    <div style={{ marginTop: 8, fontSize: '0.78rem', fontWeight: 600 }}>
                      <div style={{ color: r.ok ? '#15803d' : '#dc2626' }}>
                        {r.ok ? '✓ Reopened for revision' : `✗ ${r.message || 'Failed'}`}
                      </div>
                      {r.ok && (r.emailSent
                        ? <div style={{ color: '#15803d', fontWeight: 500 }}>✉ QA notified by email</div>
                        : <div style={{ color: '#b45309', fontWeight: 500 }}>⚠ Reopened, but QA email failed: {r.emailError || 'unknown error'}</div>)}
                    </div>
                  )}
                </div>
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

// ── SettingsTab ───────────────────────────────────────────────────────────────

function SettingsTab() {
  const [form, setForm] = useState({
    insync_username: '', insync_password: '', anthropic_api_key: '',
    no_school_start: '', no_school_end: '', provider_id: '',
    prompt_coherence: '', prompt_clone: '',
    qa_email: '', qa_cc: '', reopen_from: '', reopen_reply_to: '',
  });
  const [defaults, setDefaults] = useState({ prompt_coherence: '', prompt_clone: '' });
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
        prompt_coherence:  s.prompt_coherence  || '',
        prompt_clone:      s.prompt_clone      || '',
        qa_email:          s.qa_email          || '',
        qa_cc:             s.qa_cc             || '',
        reopen_from:       s.reopen_from       || '',
        reopen_reply_to:   s.reopen_reply_to   || '',
      });
      setDefaults({
        prompt_coherence: s.default_prompt_coherence || '',
        prompt_clone:     s.default_prompt_clone     || '',
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
        <p style={sectionLabel}>Reopen QA Email</p>
        <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: 'var(--gray-500)' }}>
          When a note is reopened, email the reviewer a PDF of the note. Leave the recipient blank to disable.
          The "From" address must be a domain you've verified in Resend — otherwise leave it blank (system default) and set Reply-to to your work email.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={lbl}>QA recipient (Avi)</label>
            <input className="form-input" value={form.qa_email} onChange={set('qa_email')} placeholder="avi@example.com" style={{ width: '100%' }} />
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

      <PromptEditor
        title="AI Prompt — Note QA Review"
        help="Runs on every note. Edit the criteria the AI flags on."
        tokens={['{{duration}}', '{{narrative}}', '{{plan}}', '{{dx}}', '{{machine_flags}}']}
        value={form.prompt_coherence}
        onChange={v => setForm(f => ({ ...f, prompt_coherence: v }))}
        defaultValue={defaults.prompt_coherence}
        requiredKeys={['"flag"', '"reason"']}
      />

      <PromptEditor
        title="AI Prompt — Duplicate / Copied-Note Judge"
        help="Runs only on candidate pairs. Edit what counts as a copy vs. legitimate repetition."
        tokens={['{{a_name}}', '{{a_date}}', '{{a_content}}', '{{b_name}}', '{{b_date}}', '{{b_content}}']}
        value={form.prompt_clone}
        onChange={v => setForm(f => ({ ...f, prompt_clone: v }))}
        defaultValue={defaults.prompt_clone}
        requiredKeys={['"copy"', '"reason"']}
      />

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
function PromptEditor({ title, help, tokens, value, onChange, defaultValue, requiredKeys }) {
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
        Placeholders — keep these, they inject the note's data:{' '}
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
          {(note.flags?.length > 0 || note.aiFlag) && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {note.flags.map((f, i) => <Chip key={i} color={flagChipColor(f)}>{f}</Chip>)}
              {note.aiFlag && <Chip color="red">AI: {note.aiFlag}</Chip>}
            </div>
          )}
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                  {clean.map(note => <NoteRow key={note.id} note={note} />)}
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
                {selectedFlagged.length > 0 && (
                  <button className="btn btn-outline btn-sm" onClick={() => signNotes(selectedFlagged, `Sign selected (${selectedFlagged.length})`)} disabled={busyIds.size > 0}>
                    Sign selected ({selectedFlagged.length})
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {flagged.map(note => <NoteRow key={note.id} note={note} checkbox />)}
              </div>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map(note => <NoteRow key={note.id} note={note} />)}
            </div>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map(note => <NoteRow key={note.id} note={note} />)}
            </div>
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
        onSign={view === 'queue' ? (list => { setCompareModal(null); signNotes(list, 'Sign'); }) : undefined} />
      <VersionsModal versions={versionsModal} onClose={() => setVersionsModal(null)} />
      <ReopenModal ctx={reopenCtx} onClose={() => setReopenCtx(null)} onDone={() => { setReopenCtx(null); load(); }} />
    </div>
  );
}

// ── PSCoSignPage ──────────────────────────────────────────────────────────────

export default function PSCoSignPage() {
  const [tab, setTab] = useState('queue');

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1000, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Co-Sign Review</h2>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 28, borderBottom: '2px solid var(--gray-100)' }}>
        {[['queue', 'Queue'], ['settings', 'Settings']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 20px', fontSize: '0.85rem', fontWeight: tab === key ? 700 : 400,
            color: tab === key ? 'var(--navy)' : 'var(--gray-400)',
            borderBottom: tab === key ? '2px solid var(--navy)' : '2px solid transparent',
            marginBottom: -2, transition: 'color 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {tab === 'settings' ? <SettingsTab /> : <QueueTab />}
    </div>
  );
}
