// New York wall-clock time → the real moment (a Date), correct on both sides
// of every daylight-saving change. Use this instead of a hard-coded offset:
// the clocks change on the second Sunday of March and the first Sunday of
// November, so "March–November = EDT" is wrong for weeks every year.
//
//   easternToUtc('2026-11-04', '19:40')  → 2026-11-05T00:40:00Z  (EST, −5)
//   easternToUtc('2026-10-28', '19:40')  → 2026-10-28T23:40:00Z  (EDT, −4)

const TZ = 'America/New_York';

// Offset (in minutes) of New York from UTC at the given instant.
function nyOffsetMinutes(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

// dateStr 'YYYY-MM-DD', timeStr 'HH:MM' (seconds ignored) in New York time.
// minutesToAdd lets callers ask for "end + 5 min" without hand-rolling the math.
function easternToUtc(dateStr, timeStr, minutesToAdd = 0) {
  const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const [h, m] = String(timeStr).slice(0, 5).split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m + Number(minutesToAdd || 0), 0);
  // Two passes: the offset depends on the instant, which depends on the offset.
  let t = wall - nyOffsetMinutes(new Date(wall)) * 60000;
  t = wall - nyOffsetMinutes(new Date(t)) * 60000;
  return new Date(t);
}

module.exports = { easternToUtc, nyOffsetMinutes };
