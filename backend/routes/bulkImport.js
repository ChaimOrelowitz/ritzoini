const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_ABBREV  = { sunday:'SUN', monday:'MON', tuesday:'TUE', wednesday:'WED', thursday:'THU', friday:'FRI', saturday:'SAT' };
const DAY_INT     = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };

const HISTORICAL_NAMES = [
  'Aqua Renewal','BrainBounce','Calming Comotion','Color Blasters','Creative Crew',
  'Cupcake Club','Feel & Flow Collective','Feel & Flow Collective (II)','Flip Force',
  'Grow & Glow','HydraBloom','Ink & Intent','Kinetic Kids','Liquid Calm',
  'Little Makers: Create','Little Makers: Discover','Little Makers: Explore',
  'MindMotion Kids','Momentum Moment','Motion Masters','Motion Room','Perspective Place',
  'Power Lab','Power Pop','Regulation Station','Scribble & Sparkle','Spark Motion',
  'Sparkle Squad','Sprinkle Squad','Happy Hoppers','Balance & Bounce','Mighty Movers',
  'Revive & Thrive','Renew & Move',
];

function parseDate(val) {
  if (!val && val !== 0) return null;
  if (typeof val === 'number') {
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length === 3) {
    let [m, d, y] = parts.map(p => parseInt(p));
    if (y < 100) y += 2000;
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  return null;
}

function parseTime(val) {
  if (!val && val !== 0) return null;
  if (typeof val === 'number' && val > 0 && val < 1) {
    const totalMin = Math.round(val * 24 * 60);
    return `${String(Math.floor(totalMin / 60)).padStart(2,'0')}:${String(totalMin % 60).padStart(2,'0')}`;
  }
  const str = String(val).trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) {
    const [h, m] = str.split(':');
    return `${String(parseInt(h)).padStart(2,'0')}:${m.slice(0,2)}`;
  }
  const match = str.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const mer = (match[3] || '').toUpperCase();
  if (mer === 'PM' && h !== 12) h += 12;
  else if (mer === 'AM' && h === 12) h = 0;
  else if (!mer && h < 12) h += 12;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0,5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function addMinutesToTime(timeStr, mins) {
  if (!timeStr) return null;
  const [h, m] = timeStr.slice(0,5).split(':').map(Number);
  const total = h * 60 + m + parseInt(mins || 0);
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

function computeNumSessions(startDate, endDate, dowInt) {
  if (!startDate || !endDate) return null;
  const [sy,sm,sd] = startDate.split('-').map(Number);
  const [ey,em,ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy,sm-1,sd);
  const endMs   = Date.UTC(ey,em-1,ed);
  const daysAhead = (dowInt - new Date(startMs).getUTCDay() + 7) % 7;
  const firstMs = startMs + daysAhead * 24*60*60*1000;
  if (firstMs > endMs) return 0;
  return Math.floor((endMs - firstMs) / (7*24*60*60*1000)) + 1;
}

function parseInstructor(val) {
  if (!val) return null;
  const str = String(val).trim();
  const phoneMatch = str.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
  if (!phoneMatch) return { first_name: str, last_name: '', phone: '' };
  const phone = phoneMatch[1].replace(/\D/g, '');
  const namePart = str.slice(0, phoneMatch.index).trim();
  const tokens = namePart.split(/\s+/).filter(Boolean);
  return {
    first_name: tokens[0] || '',
    last_name:  tokens.slice(1).join(' ') || '',
    phone,
  };
}

function buildInternalName(gender, groupLabel, dayAbbrev, time) {
  return [gender, groupLabel, dayAbbrev, fmt12(time)].filter(Boolean).join(' ');
}

async function generateNames(groups) {
  if (!groups.length) return [];
  const descriptions = groups.map((g, i) =>
    `${i+1}. ${g.gender || ''} ${g.groupLabel} on ${g.dayName}s at ${fmt12(g.time)}${g.description ? `, setting: ${g.description}` : ''}`
  ).join('\n');

  const prompt = `You are naming enrichment and therapy groups for children, teens, and adults. Generate one short, catchy, creative name (2-3 words) for each group below.

Style: Names are energetic and activity-inspired. Use alliteration, paired words with "&", or evocative imagery. Never literal — "Sensory Gym" → "Kinetic Kids". Never mention day, time, or demographics in the name.

Do NOT reuse any of these existing names: ${HISTORICAL_NAMES.join(', ')}.

Groups:
${descriptions}

Reply with ONLY the names, one per line, numbered. Example:
1. Sparkle Squad
2. Motion Masters`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text
    .split('\n')
    .filter(l => l.trim())
    .map(l => l.replace(/^\d+\.\s*/, '').trim());
}

// POST /api/bulk-import/parse
router.post('/parse', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const groups = [];
    let currentDay = null, currentDayAbbrev = null, currentDayInt = null;

    for (const row of rows) {
      const col0 = String(row[0] || '').trim();
      const col1 = String(row[1] || '').trim();

      // Day header row detection
      const dayKey = col0.toLowerCase();
      if (DAY_INT[dayKey] !== undefined && col1.toLowerCase() === 'group time') {
        currentDay      = col0;
        currentDayAbbrev = DAY_ABBREV[dayKey];
        currentDayInt   = DAY_INT[dayKey];
        continue;
      }
      if (!currentDay) continue;

      // CO Added = TRUE → already imported, skip
      const coAdded = row[9];
      if (coAdded === true || String(coAdded).toUpperCase() === 'TRUE') continue;

      const groupLabel  = col0;
      const timeVal     = row[1];
      const instructorVal = row[2];
      const startDateVal  = row[3];
      const endDateVal    = row[4];
      const cancellations = String(row[5] || '').trim();
      const grade         = String(row[6] || '').trim();
      const gender        = String(row[7] || '').trim();
      const description   = String(row[8] || '').trim();

      if (!groupLabel || !timeVal) continue;

      const time      = parseTime(timeVal);
      const startDate = parseDate(startDateVal);
      const endDate   = parseDate(endDateVal);
      const instructor = parseInstructor(instructorVal);
      const internalName = buildInternalName(gender, groupLabel, currentDayAbbrev, time);
      const sessions = computeNumSessions(startDate, endDate, currentDayInt);

      groups.push({
        dayName: currentDay,
        dayAbbrev: currentDayAbbrev,
        dayInt: currentDayInt,
        groupLabel,
        time,
        startDate,
        endDate,
        sessions,
        grade,
        gender,
        description,
        cancellations,
        instructor,
        internalName,
        suggestedName: '',
      });
    }

    const names = await generateNames(groups);
    groups.forEach((g, i) => { g.suggestedName = names[i] || ''; });

    res.json({ groups });
  } catch (err) {
    console.error('[bulk-import parse]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bulk-import/confirm
router.post('/confirm', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { groups } = req.body;
    if (!groups?.length) return res.status(400).json({ error: 'No groups provided' });

    // Cache existing instructors by phone
    const { data: existingInstructors } = await supabase.from('instructors').select('id, phone');
    const byPhone = {};
    (existingInstructors || []).forEach(i => { byPhone[i.phone.replace(/\D/g,'')] = i.id; });

    const results = [];
    for (const g of groups) {
      try {
        // Find or create instructor
        let instructorId = null;
        if (g.instructor?.phone) {
          const phone = g.instructor.phone.replace(/\D/g,'');
          if (byPhone[phone]) {
            instructorId = byPhone[phone];
          } else {
            const { data: ins } = await supabase.from('instructors').insert({
              first_name: g.instructor.first_name || '',
              last_name:  g.instructor.last_name  || '',
              phone:      g.instructor.phone,
            }).select().single();
            if (ins) { instructorId = ins.id; byPhone[phone] = ins.id; }
          }
        }

        const duration  = 45;
        const endTime   = addMinutesToTime(g.time, duration);
        const sessions  = computeNumSessions(g.startDate, g.endDate, g.dayInt);

        const { data: group, error } = await supabase.from('groups').insert({
          internal_name:    g.internalName,
          group_name:       g.suggestedName || g.internalName,
          name:             g.suggestedName || g.internalName,
          description:      g.description || null,
          supervisor_id:    null,
          instructor_id:    instructorId,
          start_date:       g.startDate,
          end_date:         g.endDate,
          day_of_week_int:  g.dayInt,
          day_of_week:      g.dayName,
          start_time:       g.time,
          session_time:     g.time,
          end_time:         endTime,
          ecw_time:         g.time,
          ecw_end_time:     endTime,
          total_sessions:   sessions,
          default_duration: duration,
          status:           'active',
          created_by:       req.user.id,
        }).select().single();

        if (error) throw error;

        if (sessions) {
          await supabase.rpc('generate_sessions_for_group', { p_group_id: group.id });
        }

        results.push({ success: true, name: g.suggestedName || g.internalName });
      } catch (err) {
        results.push({ success: false, name: g.suggestedName || g.internalName, error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
