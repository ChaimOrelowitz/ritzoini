const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET completed sessions for a supervisor in a date range
router.get('/sessions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { supervisor_id, start_date, end_date } = req.query;
    if (!supervisor_id || !start_date || !end_date)
      return res.status(400).json({ error: 'supervisor_id, start_date, end_date required' });

    const { data, error } = await supabase
      .from('sessions')
      .select('id, session_number, session_date, scheduled_date, ecw_time, start_time, status, paid, group:groups!group_id(id, internal_name, group_name, supervisor_id)')
      .eq('status', 'completed')
      .gte('session_date', start_date)
      .lte('session_date', end_date)
      .order('session_date', { ascending: true });

    if (error) throw error;
    const filtered = (data || []).filter(s => s.group?.supervisor_id === supervisor_id);
    res.json(filtered);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST upload Excel pay report and match against DB sessions
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const { supervisor_id, start_date, end_date } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!supervisor_id) return res.status(400).json({ error: 'supervisor_id required' });

    // Parse Excel
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Find header row
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || '').toLowerCase().includes('group name')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) return res.status(400).json({ error: 'Could not find "Group Name & Time" column header' });

    // Parse data rows
    const excelEntries = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const rawName = String(row[0] || '').trim();
      if (!rawName || rawName.toLowerCase().includes('thank you')) break;
      const date = parseExcelDate(row[1]);
      if (!date) continue;
      const { groupName, ecwTime } = parseGroupNameTime(rawName);
      excelEntries.push({ rawName, date, groupName, ecwTime });
    }

    if (!excelEntries.length) return res.status(400).json({ error: 'No session entries found in Excel' });

    const dates = excelEntries.map(e => e.date).sort();
    const rangeStart = start_date || dates[0];
    const rangeEnd   = end_date   || dates[dates.length - 1];

    // Fetch DB sessions for this supervisor in range
    const { data: dbSessions, error } = await supabase
      .from('sessions')
      .select('id, session_number, session_date, scheduled_date, ecw_time, start_time, status, paid, group:groups!group_id(id, internal_name, group_name, supervisor_id)')
      .eq('status', 'completed')
      .gte('session_date', rangeStart)
      .lte('session_date', rangeEnd);

    if (error) throw error;
    const supervisorSessions = (dbSessions || []).filter(s => s.group?.supervisor_id === supervisor_id);

    // Match each Excel entry to best DB session
    const usedIds = new Set();
    const matches = excelEntries.map(entry => {
      const candidates = supervisorSessions.filter(s =>
        (s.session_date || s.scheduled_date) === entry.date && !usedIds.has(s.id)
      );

      let best = null, bestScore = -1;
      for (const c of candidates) {
        const score = scoreMatch(entry, c);
        if (score > bestScore) { bestScore = score; best = c; }
      }

      let confidence = null;
      if (best && bestScore >= 0.7) confidence = 'high';
      else if (best && bestScore >= 0.35) confidence = 'medium';
      else if (best && bestScore >= 0.1) confidence = 'low';

      if (best && bestScore >= 0.1) {
        usedIds.add(best.id);
        return { excelEntry: entry, session: best, confidence, score: bestScore };
      }
      return { excelEntry: entry, session: null, confidence: null, score: 0 };
    });

    const unmatchedSessions = supervisorSessions.filter(s => !usedIds.has(s.id));

    res.json({ matches, unmatchedSessions, dateRange: { start: rangeStart, end: rangeEnd } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST confirm — mark sessions as paid
router.post('/confirm', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { session_ids } = req.body;
    if (!session_ids?.length) return res.status(400).json({ error: 'session_ids required' });
    const { error } = await supabase.from('sessions').update({ paid: true }).in('id', session_ids);
    if (error) throw error;
    res.json({ success: true, marked: session_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function parseExcelDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    // Excel serial date → UTC date
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  const match = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const [, m, d, y] = match;
  const year = y.length === 2 ? '20' + y : y;
  return `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function parseGroupNameTime(raw) {
  let cleaned = raw;
  let ecwTime = null;

  // "(group time X:XX PM)" → ECW time
  const gtMatch = cleaned.match(/\(group\s+time\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)\)/i);
  if (gtMatch) {
    ecwTime = to24h(gtMatch[1]);
    cleaned = cleaned.replace(gtMatch[0], '').trim();
    // Also remove the displayed (non-ECW) time
    cleaned = cleaned.replace(/\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/gi, '').trim();
  }

  // Remove irrelevant parentheticals like "(3:00)"
  cleaned = cleaned.replace(/\(\d+:\d+\)/g, '').trim();

  if (!ecwTime) {
    // Time is at end of string: "Sensory Gym Sunday 3:15 PM"
    const tMatch = cleaned.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)$/i);
    if (tMatch) {
      ecwTime = to24h(tMatch[1]);
      cleaned = cleaned.slice(0, cleaned.length - tMatch[0].length).trim();
    }
  }

  // Remove day-of-week
  cleaned = cleaned.replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return { groupName: cleaned, ecwTime };
}

function to24h(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]);
  const mer = (m[3] || '').toUpperCase();
  if (mer === 'PM' && h !== 12) h += 12;
  else if (mer === 'AM' && h === 12) h = 0;
  else if (!mer && h <= 8) h += 12; // no meridiem, assume PM for small hours (therapy sessions)
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function scoreMatch(entry, session) {
  let score = 0;
  const sessionEcw = (session.ecw_time || '').slice(0, 5);
  if (entry.ecwTime && sessionEcw) {
    const diff = Math.abs(toMins(entry.ecwTime) - toMins(sessionEcw));
    if (diff === 0) score += 0.5;
    else if (diff <= 5) score += 0.35;
    else if (diff <= 15) score += 0.1;
  }
  const dbName = session.group?.internal_name || session.group?.group_name || '';
  score += fuzzyScore(entry.groupName, dbName) * 0.5;
  return score;
}

function toMins(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fuzzyScore(a, b) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const tA = norm(a).split(' ').filter(t => t.length > 1);
  const tB = new Set(norm(b).split(' ').filter(t => t.length > 1));
  if (!tA.length || !tB.size) return 0;
  const overlap = tA.filter(t => tB.has(t)).length;
  return overlap / Math.max(tA.length, tB.size);
}

module.exports = router;
