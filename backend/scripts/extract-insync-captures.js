#!/usr/bin/env node
//
// Portal POC — build the capture pack from local HAR files.
//
//   node scripts/extract-insync-captures.js "/path/to/har/dir" [--dry]
//
// app.py reads its six request templates straight out of .har files at runtime.
// Those files carry live session cookies and a real patient's chart, so they are
// neither committed nor deployed. This script does the equivalent once, on a
// trusted machine: pull the POST parameter shapes, SCRUB the captured patient's
// identity and every answer-bearing field, and upsert the result into
// portal_capture_templates for the hosted app to replay.
//
// What survives scrubbing is configuration scaffolding — template ids, section
// ids, the rendered control skeleton, the ~200 InSync business-rule flags whose
// captured values are what made the original request succeed. What does not
// survive is anything a clinician wrote or anything that identifies a patient.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../db/supabase');

// step → [har filename candidates, endpoint]. The POC's own unified capture is
// listed first for each step: if it is present it wins, because it is the one
// capture proven end-to-end.
const UNIFIED = 'InSync Apointment Note Close Encounter.har';
const SPECS = {
  appointment: [[UNIFIED, 'InSynch Create Appoinment.har'], '/Scheduler/SaveBookAppointment'],
  start:       [[UNIFIED], '/Scheduler/StartEncounter'],
  encounter:   [[UNIFIED], '/EncounterDetail/AddEditStartEncounter'],
  note:        [[UNIFIED, 'InSync Save Peer Encounter Note.har'], '/ConfigurePracticeTemplate/SaveDynamicTemplateDetails'],
  generate:    [[UNIFIED, 'InSync End Peer Encounter.har'], '/EncounterNote/GenerateEncounterNote'],
  close:       [[UNIFIED, 'InSync End Peer Encounter.har'], '/ENDEncounter/SaveEndEncounter'],
  calendar:    [[UNIFIED, 'InSynch Create Appoinment.har'], '/Scheduler/LoadCalendarView'],
};

// Every control a human types into. These are blanked here and repopulated at
// run time from the portal note — the same guard app.py applies, moved earlier
// so the clinical text never lands in Supabase at all.
const ANSWER_CONTROLS = [
  'ControlId_3',  // persons present
  'ControlId_5',  // focus of the meeting
  'ControlId_7',  // intervention detail
  'ControlId_9',  // patient response
  'ControlId_11', // plan
  'ControlId_20', // interventions multi-select
  'ControlId_22', // activities and duration
  'ControlId_24', // location
  'ControlId_27', // offsite justification (Offsite templates only)
];

// Auto-populated identity controls: 12 is the patient's name, 13 the rendering
// provider's. Not clinical text, but PHI all the same — blanked here and
// rewritten per-run by the engine.
const IDENTITY_CONTROLS = ['ControlId_12', 'ControlId_13'];
const SCRUB_CONTROLS = [...ANSWER_CONTROLS, ...IDENTITY_CONTROLS];

// Identity fields. Each is overwritten per-run anyway; zeroing them means a
// stolen capture pack points at nobody.
const IDENTITY_NUMERIC = /(^|\.)(patientid|sepatientid|patientdelegateid|subpatientformid)(\.|$)/i;
const IDENTITY_TEXT = /(^|\.)(patientfullname|sepatientname|patientname|firstname|lastname|dob|mrnnumber|note|bookcomment)(\.|$)/i;

function decodeKey(k) { try { return decodeURIComponent(k); } catch { return k; } }
function decodeVal(v) { try { return decodeURIComponent(String(v).replace(/\+/g, ' ')); } catch { return v; } }

function loadRequest(file, endpoint) {
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hits = (har.log?.entries || []).filter(e =>
    e.request?.method === 'POST' && String(e.request?.url || '').includes(endpoint));
  if (!hits.length) return null;
  const req = hits[hits.length - 1].request;
  const params = req.postData?.params || [];
  if (!params.length) return null;
  const payload = {};
  for (const p of params) {
    if (!p.name) continue;
    payload[decodeKey(p.name)] = decodeVal(p.value ?? '');
  }
  return { url: String(req.url).split('?')[0], params: payload };
}

// Blank an answer control wherever it is rendered inside the DynamicHTML blob,
// using the same element shapes app.py patches values back into. If the shapes
// ever drift, the scrub misses and the check below refuses to store the pack.
function scrubDynamicHtml(html) {
  let out = String(html);
  for (const cid of SCRUB_CONTROLS) {
    const id = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(<(label|div|textarea)[^>]*\\sid="${id}"[^>]*>)([\\s\\S]*?)(</\\2>)`, 'gi'),
      (_m, open, _t, _inner, close) => open + close);
    out = out.replace(
      new RegExp(`(<input[^>]*\\sid="${id}"[^>]*\\bvalue=")[^"]*(")`, 'gi'),
      (_m, a, b) => a + b);
  }
  // The interventions multi-select renders its selection into sibling hidden
  // inputs rather than into the control element itself.
  out = out.replace(/(<input[^>]*id="hdnField(?:Text|Val)_\d+"[^>]*value=")[^"]*(")/gi, (_m, a, b) => a + b);
  out = out.replace(/data-encid="[^"]*"/gi, 'data-encid="0"');
  return out;
}

// Values that identify the captured patient/provider leak into places no field
// name predicts — a rendered onclick argument list, a hidden grid key. Collect
// them from the capture's own id fields and blank every literal occurrence.
function identifierLiterals(params) {
  const lits = new Set();
  for (const [k, v] of Object.entries(params)) {
    const bare = k.replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();
    const val = String(v || '').trim();
    if (!val) continue;
    if (/(^|\.)(patientid|sepatientid)$/.test(bare) && /^\d{3,}$/.test(val)) lits.add(val);
    if (/(^|\.)(patientfullname|sepatientname|patientname)$/.test(bare) && val.length >= 3) lits.add(val);
    if (/controlid_12$/.test(bare) && val.length >= 3) lits.add(val);
  }
  return [...lits].sort((a, b) => b.length - a.length);
}

function blankLiterals(text, literals) {
  let out = String(text);
  for (const lit of literals) {
    out = out.split(lit).join(/^\d+$/.test(lit) ? '0' : '');
  }
  return out;
}

function scrub(step, params) {
  const out = {};
  const removed = [];
  const literals = identifierLiterals(params);
  for (const [k, v] of Object.entries(params)) {
    const key = decodeKey(k);
    // "obj[A][B]" -> "obj.a.b" so one dot-delimited pattern matches every
    // nesting depth the MVC model binder produces.
    const bare = key.replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();

    if (SCRUB_CONTROLS.some(c => new RegExp(`(^|\\.)${c.toLowerCase()}$`).test(bare))) {
      out[key] = ''; removed.push(key); continue;
    }
    if (/dynamichtml/i.test(bare)) {
      out[key] = blankLiterals(scrubDynamicHtml(v), literals);
      removed.push(key + ' (inner values)'); continue;
    }
    // InSync's mirror of the saved answers, "<ControlId_N>value</ControlId_N>".
    // Kept — it is scaffolding the save expects — with any answer stripped out.
    if (/databasevaluecollection|controlxml/i.test(bare)) {
      let mirror = String(v);
      for (const c of SCRUB_CONTROLS) {
        mirror = mirror.replace(new RegExp(`(<${c}>)[\\s\\S]*?(</${c}>)`, 'gi'), '$1$2');
      }
      out[key] = blankLiterals(mirror, literals);
      removed.push(key); continue;
    }
    if (IDENTITY_NUMERIC.test(bare)) { out[key] = '0'; removed.push(key); continue; }
    if (IDENTITY_TEXT.test(bare))    { out[key] = ''; removed.push(key); continue; }
    // Never store a signing PIN, even the captured one.
    if (/\bepin\b/i.test(bare))      { out[key] = ''; removed.push(key); continue; }
    const blanked = blankLiterals(v, literals);
    if (blanked !== v) removed.push(key + ' (embedded identifier)');
    out[key] = blanked;
  }
  return { params: out, removed };
}

// Refuse to store a pack that still looks like it holds someone's chart.
function assertClean(step, params, raw) {
  const blob = JSON.stringify(params);
  const leaks = [];
  for (const cid of SCRUB_CONTROLS) {
    const m = blob.match(new RegExp(`"[^"]*${cid}[^"]*"\\s*:\\s*"([^"]{3,})"`));
    if (m) leaks.push(`${cid} still holds a value`);
  }
  for (const lit of identifierLiterals(raw)) {
    if (blob.includes(lit)) leaks.push(`the captured patient identifier ${JSON.stringify(lit)} survives`);
  }
  if (leaks.length) throw new Error(`Capture "${step}" failed the scrub check: ${leaks.join('; ')}`);
}

async function main() {
  const dir = process.argv[2] || process.cwd();
  const dry = process.argv.includes('--dry');
  const found = [];
  const missing = [];

  for (const [step, [files, endpoint]] of Object.entries(SPECS)) {
    let hit = null, from = null;
    for (const f of files) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      hit = loadRequest(p, endpoint);
      if (hit) { from = f; break; }
    }
    if (!hit) { missing.push(`${step} (${endpoint})`); continue; }

    const { params, removed } = scrub(step, hit.params);
    assertClean(step, params, hit.params);
    found.push({
      step, url: hit.url, params, captured_from: from,
      field_count: Object.keys(params).length, updated_at: new Date().toISOString(),
    });
    console.log(`✓ ${step.padEnd(12)} ${String(Object.keys(params).length).padStart(4)} fields  from ${from}  (scrubbed ${removed.length})`);
  }

  if (missing.length) {
    console.log('\n⚠ Not found in the HARs supplied:');
    for (const m of missing) console.log(`   - ${m}`);
    console.log('  Live execution stays blocked for any step without a capture.');
  }

  if (dry) { console.log('\n--dry: nothing written.'); return; }
  if (!found.length) { console.log('\nNothing to write.'); return; }

  const { error } = await supabase.from('portal_capture_templates').upsert(found, { onConflict: 'step' });
  if (error) { console.error('\nUpsert failed:', error.message); process.exit(1); }
  console.log(`\nStored ${found.length} capture template(s) in portal_capture_templates.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
