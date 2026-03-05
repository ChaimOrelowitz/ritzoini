require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const supabase = require('../db/supabase');

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function deriveDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function addMinutesToTime(timeStr, mins) {
  if (!timeStr) return null;
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const total = h * 60 + m + parseInt(mins || 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function computeNumSessions(startDate, endDate, dowInt) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs   = Date.UTC(ey, em - 1, ed);
  const startDow = new Date(startMs).getUTCDay();
  const daysAhead = (dowInt - startDow + 7) % 7;
  const firstMs = startMs + daysAhead * 24 * 60 * 60 * 1000;
  if (firstMs > endMs) return 0;
  return Math.floor((endMs - firstMs) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

const groups = [
  {
    internal_name:    '4:20 PM Gymnastics - Girls',
    group_name:       'Sparkle Squad',
    description:      'Girls grades 5-8',
    start_date:       '2026-01-06',
    end_date:         '2026-03-03',
    start_time:       '16:20',
    ecw_time:         null,
    default_duration: 45,
  },
  {
    internal_name:    '5:15 PM Painting - Boys',
    group_name:       'Color Blasters',
    description:      'Boys grades 3-4',
    start_date:       '2025-12-30',
    end_date:         '2026-03-24',
    start_time:       '17:15',
    ecw_time:         null,
    default_duration: 45,
  },
  {
    internal_name:    '6:20 PM Sofres - Boys',
    group_name:       'Ink & Intent',
    description:      'Boys learning sofros grades 5-8',
    start_date:       '2026-01-06',
    end_date:         '2026-03-24',
    start_time:       '18:20',
    ecw_time:         null,
    default_duration: 45,
  },
  {
    internal_name:    '8:50 PM Aerobics - Girls',
    group_name:       'Momentum Moment',
    description:      'High school girls aerobics',
    start_date:       '2025-12-23',
    end_date:         '2026-03-17',
    start_time:       '20:50',
    ecw_time:         null,
    default_duration: 45,
  },
];

async function run() {
  for (const g of groups) {
    const dowInt   = deriveDayOfWeek(g.start_date);
    const duration = parseInt(g.default_duration) || 45;
    const sTime    = g.start_time.slice(0, 5);
    const effEcw   = g.ecw_time ? g.ecw_time.slice(0, 5) : sTime;
    const end_time = addMinutesToTime(sTime, duration);
    const ecwEnd   = addMinutesToTime(effEcw, duration);
    const totalSessions = computeNumSessions(g.start_date, g.end_date, dowInt);

    console.log(`Creating group: ${g.internal_name}`);
    console.log(`  Day: ${DAY_NAMES[dowInt]}, Sessions: ${totalSessions}`);

    const { data: group, error } = await supabase.from('groups').insert({
      internal_name:    g.internal_name,
      group_name:       g.group_name || g.internal_name,
      name:             g.group_name || g.internal_name,
      description:      g.description || null,
      supervisor_id:    g.supervisor_id || null,
      instructor_id:    g.instructor_id || null,
      start_date:       g.start_date,
      end_date:         g.end_date,
      day_of_week_int:  dowInt,
      day_of_week:      DAY_NAMES[dowInt],
      start_time:       sTime,
      session_time:     sTime,
      end_time,
      ecw_time:         effEcw,
      ecw_end_time:     ecwEnd,
      total_sessions:   totalSessions,
      default_duration: duration,
    }).select().single();

    if (error) { console.error(`  ERROR: ${error.message}`); continue; }

    console.log(`  Created group ID: ${group.id}`);

    const { error: rpcErr } = await supabase.rpc('generate_sessions_for_group', { p_group_id: group.id });
    if (rpcErr) { console.error(`  Session generation ERROR: ${rpcErr.message}`); continue; }

    console.log(`  Sessions generated OK`);
  }
  console.log('Done.');
}

run().catch(console.error);
