// Runs on /CoSignEncounterList/* — scrapes the note list, flags bad notes,
// responds to popup messages to sign clean ones.

const BASE = 'https://thedscenter.insynchcs.com';
const FLAG_COLOR = '#fecaca';   // red tint
const CLEAN_COLOR = '#dcfce7';  // green tint

// ── Note extraction ───────────────────────────────────────────────────────────
// Each note row needs: eid, pid, cosignId, coSignRequestId
// plus (from the detail fetch): patientDob, visitDateTime

function extractNotesFromPage() {
  const notes = [];

  // InSync typically embeds onclick handlers on rows or buttons.
  // Common patterns: onclick="OpenEndEncounterCoSign(pid,eid,cosignId,coSignReqId)"
  // or links like /ENDEncounter/ENDEncounter?pid=X&eid=Y&CosignID=Z&CoSignRequestID=W
  const candidates = [
    ...document.querySelectorAll('[onclick*="CosignID"], [onclick*="CoSignRequestID"]'),
    ...document.querySelectorAll('a[href*="CosignID"], a[href*="CoSignRequestID"]'),
    ...document.querySelectorAll('[onclick*="ENDEncounter"]'),
  ];

  const seen = new Set();
  for (const el of candidates) {
    const src = el.getAttribute('onclick') || el.getAttribute('href') || '';
    const pid    = extractParam(src, 'pid')            || extractParam(src, 'PatientId');
    const eid    = extractParam(src, 'eid')            || extractParam(src, 'EncounterID');
    const cid    = extractParam(src, 'CosignID')       || extractParam(src, 'Cosignid');
    const crid   = extractParam(src, 'CoSignRequestID');

    if (!eid || seen.has(eid)) continue;
    seen.add(eid);

    const row = el.closest('tr') || el.closest('li') || el.closest('[class*="row"]') || el.parentElement;
    const rowText = row?.innerText || '';

    notes.push({ el, row, eid, pid, cosignId: cid, coSignRequestId: crid, rowText, flag: null, reason: null, detail: null });
  }

  return notes;
}

function extractParam(src, key) {
  // URL query param style: key=VALUE
  const urlMatch = new RegExp(`[?&]${key}=([\\d]+)`, 'i').exec(src);
  if (urlMatch) return urlMatch[1];
  // JS function arg style: key,VALUE or 'VALUE' preceded by key variable assignment
  const jsMatch = new RegExp(`${key}\\s*[=,]\\s*['\"]?(\\d+)`, 'i').exec(src);
  if (jsMatch) return jsMatch[1];
  return null;
}

// ── Detail page fetch ─────────────────────────────────────────────────────────
// Opens the ENDEncounter page in the background to extract DOB + visit datetime.

async function fetchNoteDetail(note) {
  if (!note.pid || !note.eid) return null;
  const url = `${BASE}/ENDEncounter/ENDEncounter?isScritAdd=0&pid=${note.pid}&eid=${note.eid}` +
              (note.cosignId ? `&CosignID=${note.cosignId}` : '') +
              (note.coSignRequestId ? `&CoSignRequestID=${note.coSignRequestId}` : '');
  try {
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();

    const dob       = extractJsVar(html, 'PatientDOB');        // 'MM/DD/YYYY'
    const visitDT   = extractJsVar(html, 'VisitDateTime') ||
                      extractJsVar(html, 'VisitDate');          // 'M/D/YYYY h:mm AM'
    const cosignId  = extractJsVar(html, 'CosignID')  || note.cosignId;
    const coSignRequestId = extractJsVar(html, 'CoSignRequestID') || note.coSignRequestId;

    // Try to get duration (start/end time fields)
    const startTime = extractJsVar(html, 'StartTime') || extractJsVar(html, 'EncounterStartTime');
    const endTime   = extractJsVar(html, 'EndTime')   || extractJsVar(html, 'EncounterEndTime');

    return { dob, visitDT, cosignId, coSignRequestId, startTime, endTime };
  } catch {
    return null;
  }
}

function extractJsVar(html, varName) {
  const re = new RegExp(`${varName}\\s*[=:]\\s*['"]?([^'";\\r\\n]+?)['"]?\\s*[;,\\r\\n]`, 'i');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

// ── Flag rules ────────────────────────────────────────────────────────────────

function applyRules(note) {
  const { detail } = note;
  if (!detail) { note.flag = false; return; }

  const { dob, visitDT, startTime, endTime } = detail;
  const visit = visitDT ? new Date(visitDT) : null;

  // Rule 1: Saturday
  if (visit && visit.getDay() === 6) {
    note.flag = true; note.reason = 'Saturday'; return;
  }

  // Rule 2: 3-hour session (180+ min)
  if (startTime && endTime) {
    const start = parseTime(startTime);
    const end   = parseTime(endTime);
    if (start !== null && end !== null) {
      const mins = (end - start + 1440) % 1440;
      if (mins >= 180) { note.flag = true; note.reason = '3hr session'; return; }
    }
  }

  // Rule 3: under-18 client, before 3pm, M–F
  if (dob && visit) {
    const age = ageAt(dob, visit);
    const hour = visit.getHours();
    const dow  = visit.getDay(); // 1=Mon … 5=Fri
    if (age < 18 && hour < 15 && dow >= 1 && dow <= 5) {
      note.flag = true; note.reason = `Under 18 before 3pm (age ${age})`; return;
    }
  }

  note.flag = false;
}

function parseTime(t) {
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function ageAt(dobStr, asOf) {
  // dobStr: 'MM/DD/YYYY'
  const [mo, d, y] = dobStr.split('/').map(Number);
  const dob = new Date(y, mo - 1, d);
  let age = asOf.getFullYear() - dob.getFullYear();
  const m = asOf.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < dob.getDate())) age--;
  return age;
}

// ── Visual marking ────────────────────────────────────────────────────────────

function markRow(note) {
  if (!note.row) return;
  note.row.style.backgroundColor = note.flag ? FLAG_COLOR : CLEAN_COLOR;

  // Remove existing badge if any
  note.row.querySelectorAll('.pns-badge').forEach(b => b.remove());

  const badge = document.createElement('span');
  badge.className = 'pns-badge';
  badge.style.cssText = `
    display:inline-block; margin-left:8px; padding:2px 7px; border-radius:4px;
    font-size:11px; font-weight:700;
    background:${note.flag ? '#dc2626' : '#16a34a'}; color:white;
  `;
  badge.textContent = note.flag ? `⚑ ${note.reason}` : '✓ Clean';
  const firstTd = note.row.querySelector('td,li');
  if (firstTd) firstTd.appendChild(badge);
}

// ── Sign ──────────────────────────────────────────────────────────────────────

async function signNote(note, epin) {
  const eid  = note.eid;
  const cid  = note.detail?.cosignId  || note.cosignId  || '';
  const crid = note.detail?.coSignRequestId || note.coSignRequestId || '';

  const xml = `<CoSignEncounters><RowData>` +
    `<EncounterID>${eid}</EncounterID>` +
    `<CoSignNoteType>1</CoSignNoteType>` +
    `<NoteID></NoteID><FilePath></FilePath>` +
    `<CosignID>${cid}</CosignID>` +
    `<CoSignRequestID>${crid}</CoSignRequestID>` +
    `</RowData></CoSignEncounters>`;

  const body = new URLSearchParams({
    EncounterIds: eid,
    EncounterIdxml: xml,
    EPIN: epin,
    CoSignReason: '',
    IncludeOtherCosign: 'false',
  });

  const res = await fetch(`${BASE}/CoSignEncounterList/CoSignEPIN`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  return json; // [signed, total] or similar
}

// ── Main ──────────────────────────────────────────────────────────────────────

let NOTES = [];

async function analyzeAll(sendResponse) {
  NOTES = extractNotesFromPage();
  if (!NOTES.length) {
    sendResponse({ status: 'error', message: 'No co-sign notes found on this page. Make sure you\'re on the Co-Sign list.' });
    return;
  }

  sendResponse({ status: 'analyzing', total: NOTES.length });

  for (let i = 0; i < NOTES.length; i++) {
    const note = NOTES[i];
    note.detail = await fetchNoteDetail(note);
    applyRules(note);
    markRow(note);
  }

  const flagged = NOTES.filter(n => n.flag).length;
  const clean   = NOTES.filter(n => !n.flag).length;

  // Notify popup of final counts via storage
  chrome.storage.local.set({ pns_state: { done: true, total: NOTES.length, flagged, clean } });
}

async function signAll(epin, sendResponse) {
  const toSign = NOTES.filter(n => !n.flag);
  let signed = 0, errors = 0;
  for (const note of toSign) {
    try {
      await signNote(note, epin);
      signed++;
      if (note.row) note.row.style.backgroundColor = '#bbf7d0';
    } catch {
      errors++;
      if (note.row) note.row.style.backgroundColor = '#fca5a5';
    }
  }
  sendResponse({ status: 'done', signed, errors });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'analyze') {
    analyzeAll(sendResponse);
    return true; // keep channel open for async response
  }
  if (msg.action === 'sign') {
    signAll(msg.epin, sendResponse);
    return true;
  }
  if (msg.action === 'status') {
    const flagged = NOTES.filter(n => n.flag).length;
    const clean   = NOTES.filter(n => n.flag === false).length;
    sendResponse({ total: NOTES.length, flagged, clean });
  }
});
