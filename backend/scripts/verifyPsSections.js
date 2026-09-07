// Corpus check: for every stored PS note, does each narrative section that the
// note plainly contains actually survive into the review payload?
//
// This exists because the activities field read "" for 2,271 of 2,273 stored
// notes and nothing noticed. InSync ends that heading with "?" and findHeadings
// only accepted ":", so the section was never detected — the text was still
// there, silently absorbed into "Focus of the meeting". A blank field is
// indistinguishable from a genuinely blank field, so only a sweep like this can
// tell the two apart at scale.
//
// Read-only. Run after any change to findHeadings / splitSections, and whenever
// InSync changes how it renders a note.
//
//   node scripts/verifyPsSections.js
//
// Exits non-zero if any section is empty while its heading is present with
// substantive content.
require('dotenv').config();
const supabase = require('../db/supabase');
const { sectionSource, splitSections, SECTION_LABELS } = require('../utils/peerSupervisorEngine');

const PAGE = 500;
const MIN_CHARS = 40;   // matches SECTION_ASSERT_MIN_CHARS in the engine

// Deliberately NOT findHeadings: this must not share the parser's blind spot, or
// it would stay silent for the same reason the bug did. Looks for the label
// followed by either terminator InSync uses, ":" or "?".
function headingPresentWithContent(source, label) {
  const body = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,/g, ',?').replace(/\s+/g, '\\s+');
  const m = new RegExp('(?<![A-Za-z])(?:' + body + ')[ \\t]*[:?]', 'i').exec(source);
  if (!m) return null;
  const after = source.slice(m.index + m[0].length).replace(/\s+/g, ' ').trim();
  return after.length >= MIN_CHARS ? after : null;
}

(async () => {
  const blank = {}, examples = {};
  for (const s of SECTION_LABELS) { blank[s.key] = 0; examples[s.key] = []; }

  let from = 0, scanned = 0, structured = 0, legacy = 0;
  for (;;) {
    const { data, error } = await supabase.from('ps_notes')
      .select('eid, peer_name, visit_date, note_data').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;

    for (const row of data) {
      const note = row.note_data || {};
      const source = sectionSource(note);
      if (!source) continue;
      scanned++;
      if (note.structuredText) structured++; else legacy++;

      const secs = splitSections(source);
      for (const s of SECTION_LABELS) {
        if (secs[s.key]) continue;
        const following = headingPresentWithContent(source, s.label);
        if (!following) continue;
        blank[s.key]++;
        if (examples[s.key].length < 3)
          examples[s.key].push({ eid: row.eid, peer: row.peer_name, date: row.visit_date, following: following.slice(0, 120) });
      }
    }
    from += PAGE;
    if (data.length < PAGE) break;
  }

  console.log(`Scanned ${scanned} notes (${structured} with structuredText, ${legacy} legacy flat-only)\n`);
  let failures = 0;
  for (const s of SECTION_LABELS) {
    const n = blank[s.key];
    failures += n;
    console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'}  ${s.key.padEnd(14)} ${n} note(s) with the heading present but the section empty`);
    for (const e of examples[s.key]) console.log(`          eid=${e.eid} ${e.peer} ${e.date} -> ${JSON.stringify(e.following)}`);
  }

  console.log(failures === 0
    ? '\nAll sections derived on every stored note.'
    : `\n${failures} section(s) lost across the corpus — the parser is missing a heading shape.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
