#!/usr/bin/env node
//
// Portal POC — build the capture pack from local HAR files.
//
//   node scripts/extract-insync-captures.js [dir ...] [--dry]
//
// With no arguments it scans the repo root and portal_POC/. Pass directories to
// scan somewhere else. Large HARs need headroom:
//   node --max-old-space-size=8192 scripts/extract-insync-captures.js
//
// app.py reads its request templates straight out of .har files at runtime.
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

// endpoint → step. `note` is split after the fact: the peer note form comes in
// two shapes (base and Offsite) with DIFFERENT TemplateIds, and one stored
// template cannot serve both.
const ENDPOINTS = {
  appointment: '/Scheduler/SaveBookAppointment',
  start:       '/Scheduler/StartEncounter',
  encounter:   '/EncounterDetail/AddEditStartEncounter',
  note:        '/ConfigurePracticeTemplate/SaveDynamicTemplateDetails',
  generate:    '/EncounterNote/GenerateEncounterNote',
  close:       '/ENDEncounter/SaveEndEncounter',
  calendar:    '/Scheduler/LoadCalendarView',
};

// Every control a human types into. Blanked here and repopulated at run time
// from the portal note — the same guard app.py applies, moved earlier so the
// clinical text never lands in Supabase at all.
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
// provider's. Not clinical text, but PHI all the same.
const IDENTITY_CONTROLS = ['ControlId_12', 'ControlId_13'];
const SCRUB_CONTROLS = [...ANSWER_CONTROLS, ...IDENTITY_CONTROLS];

const IDENTITY_NUMERIC = /(^|\.)(patientid|sepatientid|patientdelegateid|subpatientformid)(\.|$)/i;
const IDENTITY_TEXT = /(^|\.)(patientfullname|sepatientname|patientname|firstname|lastname|dob|mrnnumber|note|bookcomment)(\.|$)/i;

function decodeKey(k) { try { return decodeURIComponent(k); } catch { return k; } }
function decodeVal(v) { try { return decodeURIComponent(String(v).replace(/\+/g, ' ')); } catch { return v; } }
function bareKey(k) { return decodeKey(k).replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase(); }

// Pull every POST body for every endpoint of interest out of one HAR, then let
// the file go — these run to 86MB and holding two at once is what OOMs.
function scanHar(file) {
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const found = {};
  for (const entry of har.log?.entries || []) {
    const req = entry.request;
    if (req?.method !== 'POST') continue;
    const url = String(req.url || '');
    for (const [step, endpoint] of Object.entries(ENDPOINTS)) {
      if (!url.includes(endpoint)) continue;
      const params = req.postData?.params || [];
      if (!params.length) continue;
      const payload = {};
      for (const p of params) {
        if (p.name) payload[decodeKey(p.name)] = decodeVal(p.value ?? '');
      }
      // Last one wins: in a session that retried, the final request is the one
      // that actually succeeded.
      found[step] = { url: url.split('?')[0], params: payload, from: path.basename(file) };
    }
  }
  return found;
}

// Which encounter type was this captured against? The appointment and encounter
// payloads carry it, and it is what the type-verification gate compares against.
function capturedVisitType(params) {
  for (const [k, v] of Object.entries(params)) {
    const b = bareKey(k);
    if (/(^|\.)(visittypeid|encountertypeid|sevisittypeid)$/.test(b) && /^\d{3,}$/.test(String(v).trim())) {
      return String(v).trim();
    }
  }
  return null;
}

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

// Values that identify the captured patient leak into places no field name
// predicts — a rendered onclick argument list, a hidden grid key. Collect them
// from the capture's own id fields and blank every literal occurrence.
function identifierLiterals(params) {
  const lits = new Set();
  for (const [k, v] of Object.entries(params)) {
    const b = bareKey(k);
    const val = String(v || '').trim();
    if (!val) continue;
    if (/(^|\.)(patientid|sepatientid)$/.test(b) && /^\d{3,}$/.test(val)) lits.add(val);
    if (/(^|\.)(patientfullname|sepatientname|patientname)$/.test(b) && val.length >= 3) lits.add(val);
    if (/controlid_12$/.test(b) && val.length >= 3) lits.add(val);
  }
  return [...lits].sort((a, b) => b.length - a.length);
}

function blankLiterals(text, literals) {
  let out = String(text);
  for (const lit of literals) out = out.split(lit).join(/^\d+$/.test(lit) ? '0' : '');
  return out;
}

function scrub(params) {
  const out = {};
  const removed = [];
  const literals = identifierLiterals(params);

  for (const [k, v] of Object.entries(params)) {
    const key = decodeKey(k);
    const b = bareKey(k);

    if (SCRUB_CONTROLS.some(c => new RegExp(`(^|\\.)${c.toLowerCase()}$`).test(b))) {
      out[key] = ''; removed.push(key); continue;
    }
    if (/dynamichtml/i.test(b)) {
      out[key] = blankLiterals(scrubDynamicHtml(v), literals);
      removed.push(key + ' (inner values)'); continue;
    }
    // InSync's mirror of the saved answers, "<ControlId_N>value</ControlId_N>".
    // Kept — it is scaffolding the save expects — with any answer stripped out.
    if (/databasevaluecollection|controlxml/i.test(b)) {
      let mirror = String(v);
      for (const c of SCRUB_CONTROLS) {
        mirror = mirror.replace(new RegExp(`(<${c}>)[\\s\\S]*?(</${c}>)`, 'gi'), '$1$2');
      }
      out[key] = blankLiterals(mirror, literals); removed.push(key); continue;
    }
    if (IDENTITY_NUMERIC.test(b)) { out[key] = '0'; removed.push(key); continue; }
    if (IDENTITY_TEXT.test(b))    { out[key] = ''; removed.push(key); continue; }
    // Never store a signing PIN, even the captured one.
    if (/\bepin\b/i.test(b))      { out[key] = ''; removed.push(key); continue; }

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
    if (new RegExp(`"[^"]*${cid}[^"]*"\\s*:\\s*"([^"]{3,})"`).test(blob)) leaks.push(`${cid} still holds a value`);
  }
  for (const lit of identifierLiterals(raw)) {
    if (blob.includes(lit)) leaks.push(`the captured patient identifier ${JSON.stringify(lit)} survives`);
  }
  if (leaks.length) throw new Error(`Capture "${step}" failed the scrub check: ${leaks.join('; ')}`);
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--dry');
  const dry = process.argv.includes('--dry');
  const dirs = args.length ? args : [
    path.join(__dirname, '../..'),
    path.join(__dirname, '../../portal_POC'),
  ];

  const files = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) { console.log(`  (skipping ${d} — not found)`); continue; }
    for (const f of fs.readdirSync(d)) {
      if (f.toLowerCase().endsWith('.har')) files.push(path.join(d, f));
    }
  }
  if (!files.length) { console.error('No .har files found in: ' + dirs.join(', ')); process.exit(1); }

  // step → best capture. The peer note form is collected as a LIST because it
  // comes in two shapes that must both be stored.
  const best = {};
  const noteCaptures = [];

  for (const file of files) {
    let hits;
    try { hits = scanHar(file); }
    catch (e) { console.log(`  (skipping ${path.basename(file)} — ${e.message.slice(0, 60)})`); continue; }

    // How much of the chain does this one HAR cover? A capture taken from a HAR
    // that recorded the whole sequence came from a session that actually
    // worked end to end; one cherry-picked out of a partial HAR did not.
    const coverage = Object.keys(hits).filter(s => s !== 'calendar').length;

    for (const [step, hit] of Object.entries(hits)) {
      const desc = Object.entries(hit.params).find(([k]) => /visittypedescription|encountertype$/i.test(bareKey(k)));
      hit.visitTypeId = capturedVisitType(hit.params);
      // The generic scheduler HAR books a completely different service, and its
      // CPT / POS / copay scaffolding is wrong for a peer encounter.
      hit.isPeer = /peer support/i.test(String(desc?.[1] || ''));
      hit.coverage = coverage;

      if (step === 'note') { noteCaptures.push(hit); continue; }

      const cur = best[step];
      const better = !cur
        || (hit.isPeer && !cur.isPeer)
        || (hit.isPeer === cur.isPeer && hit.coverage > cur.coverage);
      if (better) best[step] = hit;
    }
  }

  // Split the note captures by form shape. ControlId_27 — the offsite
  // justification — is the discriminator, read from the payload rather than
  // guessed from a filename.
  for (const cap of noteCaptures) {
    const hasOffsiteField = Object.keys(cap.params).some(k => /controlid_27$/.test(bareKey(k)));
    const step = hasOffsiteField ? 'note_offsite' : 'note';
    cap.templateId = Object.entries(cap.params).find(([k]) => bareKey(k).endsWith('templateid'))?.[1] || null;
    if (!best[step] || cap.coverage > best[step].coverage) best[step] = cap;
  }

  const rows = [];
  for (const [step, hit] of Object.entries(best)) {
    const { params, removed } = scrub(hit.params);
    assertClean(step, params, hit.params);
    rows.push({
      step, url: hit.url, params,
      captured_from: hit.from,
      captured_visit_type_id: hit.visitTypeId || null,
      field_count: Object.keys(params).length,
      updated_at: new Date().toISOString(),
    });
    console.log(
      `✓ ${step.padEnd(13)} ${String(Object.keys(params).length).padStart(4)} fields  ` +
      `${hit.visitTypeId ? `type ${hit.visitTypeId}  ` : hit.templateId ? `tmpl ${hit.templateId}  ` : ''}` +
      `from ${hit.from}  (scrubbed ${removed.length})`);
  }

  const required = ['appointment', 'start', 'encounter', 'note', 'generate', 'close'];
  const missing = required.filter(s => !best[s]);
  if (missing.length) {
    console.log('\n⚠ Not found in the HARs supplied: ' + missing.join(', '));
    console.log('  Live execution stays blocked for any step without a capture.');
  }
  if (!best.note_offsite) {
    console.log('\nNote: no Offsite note-form capture found. Offsite encounter types stay blocked;');
    console.log('  base (non-offsite) types are unaffected.');
  }

  if (dry) { console.log('\n--dry: nothing written.'); return; }

  let { error } = await supabase.from('portal_capture_templates').upsert(rows, { onConflict: 'step' });

  // db/portal_poc.sql is applied by hand, so an older schema is a normal state
  // to land in. Say exactly what is missing instead of leaking a Postgres error.
  if (error && /captured_visit_type_id/.test(error.message)) {
    console.log('\n⚠ portal_capture_templates has no captured_visit_type_id column — storing without it.');
    console.log('  Re-run db/portal_poc.sql in the Supabase SQL editor to enable the payload-diff gate.');
    ({ error } = await supabase.from('portal_capture_templates')
      .upsert(rows.map(({ captured_visit_type_id, ...r }) => r), { onConflict: 'step' }));
  }
  if (error && /step_check|violates check constraint/i.test(error.message)) {
    console.error('\nUpsert refused: the portal_capture_templates.step CHECK predates the');
    console.error('note/note_offsite split. Re-run db/portal_poc.sql in the Supabase SQL editor');
    console.error('(it is idempotent and drops that constraint), then run this script again.');
    process.exit(1);
  }
  if (error) { console.error('\nUpsert failed:', error.message); process.exit(1); }
  console.log(`\nStored ${rows.length} capture template(s) in portal_capture_templates.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
