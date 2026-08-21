// Portal POC — Phase B, the InSync write chain.
//
// A port of app.py's proven create → note → generate → close → sign sequence,
// with the POC's hard-won details preserved deliberately:
//   • every answer field is blanked before the current note's values are written,
//     so no prior patient's text can ride along in a reused template;
//   • the rendered DynamicHTML blob is patched in place, including the special
//     path for the ControlId_20 multi-select;
//   • the appointment payload's PMAlertData / VisitHistory keys are restored to
//     their captured values, because broad suffix matching would otherwise
//     populate fields the successful browser request left blank;
//   • each step has an explicit success signal and stops the note on anything else.
//
// Two things this adds over the POC: it runs many notes per session (serially —
// InSync keeps a current-patient in session state, so concurrency would silently
// misattribute a note), and it has a real dry run that prepares every payload
// and sends nothing.

const { post } = require('./insync');
const { clean, setFields, responseId, appointmentResult } = require('./portalPayload');
const { parseInsyncTypeName } = require('./portalMatch');

const REQUIRED_STEPS = ['appointment', 'start', 'encounter', 'note', 'generate', 'close'];

// The peer note form exists in two shapes with DIFFERENT InSync TemplateIds:
// the base form, and the Offsite form that adds ControlId_27. One stored
// template cannot serve both, so the capture pack holds both and the SELECTED
// encounter type picks which one is replayed.
function noteStepFor(offsite) { return offsite ? 'note_offsite' : 'note'; }

// Resolve the templates for one note: the shared steps, plus whichever note
// form the chosen encounter type calls for, aliased to `note` so the rest of
// the chain does not care which shape it got.
function templatesFor(templates, offsite) {
  const step = noteStepFor(offsite);
  const note = templates[step];
  if (!note) {
    throw new StepError('captures',
      offsite
        ? 'No Offsite note-form capture is stored, so Offsite encounter types cannot be written. ' +
          'Capture a note save on an Offsite type and re-run the capture extractor, or pick the base type.'
        : 'No base note-form capture is stored. Run scripts/extract-insync-captures.js.');
  }
  return { ...templates, note };
}

// Codes InSync expects for the interventions multi-select, and the labels the
// portal exports. Matched by label — a portal label with no InSync counterpart
// flags the row rather than being dropped.
const PEER_INTERVENTIONS = [
  ['1', 'Active Listening'], ['2', 'Advocacy'], ['3', 'Boundary Setting'],
  ['4', 'Cognitive Restructuring'], ['5', 'Conflict Resolution'], ['6', 'Coping Skills'],
  ['7', 'Crisis Support'], ['8', 'Empowerment Coaching'], ['9', 'Goal Setting'],
  ['10', 'Mindfulness'], ['11', 'Motivation'], ['12', 'Normalizing'],
  ['13', 'Peer Support Groups'], ['14', 'Problem-Solving'], ['15', 'Psychoeducation'],
  ['16', 'Resource Navigation'], ['17', 'Self-Care'], ['18', 'Skill-Building'],
  ['19', 'Sleep Hygiene'], ['20', 'Social Connection'], ['21', 'Strengths-Based Approach'],
  ['22', 'Time Management'], ['23', 'Validation'], ['24', 'Wellness Coaching'],
  ['25', 'Other'],
];
const LABEL_TO_CODE = new Map(PEER_INTERVENTIONS.map(([c, l]) => [l.toLowerCase(), c]));
const CODE_TO_LABEL = new Map(PEER_INTERVENTIONS);

// The peer note template. `source` names the portal field the value comes from
// verbatim; `manual` fields have no portal counterpart and are typed by the
// operator on the review screen — the app never invents them.
const NOTE_FIELDS = [
  { control: 'ControlId_3',  label: 'Persons Present',                   source: 'personsPresent' },
  { control: 'ControlId_24', label: 'Location of the Meeting',           source: 'locationText' },
  { control: 'ControlId_5',  label: 'Focus of the Meeting',              source: 'focusOfMeeting' },
  { control: 'ControlId_22', label: 'Activities and Duration',           source: 'activitiesSummary' },
  // The portal has no counterpart for this field. The standing convention is to
  // repeat the selected interventions into it, so it is prefilled from
  // ControlId_20 — the peer's own selection copied across, not prose the app
  // composed. Still editable: a manual entry wins.
  { control: 'ControlId_7',  label: 'Peer Support Intervention Details', manual: true, mirrors: 'ControlId_20' },
  { control: 'ControlId_20', label: 'Peer Support Interventions',        source: 'interventions', kind: 'multiselect' },
  { control: 'ControlId_9',  label: 'Patient Response / Content',        source: 'patientResponse' },
  { control: 'ControlId_11', label: 'Plan',                              source: 'nextPlan' },
  // Present ONLY on Offsite encounter types — the one field that distinguishes
  // the offsite template from its base twin.
  { control: 'ControlId_27', label: 'Justification for Offsite Delivery', manual: true, offsiteOnly: true },
];

const ANSWER_CONTROLS = NOTE_FIELDS.map(f => f.control);
const PATIENT_NAME_CONTROL  = 'ControlId_12';
const PROVIDER_NAME_CONTROL = 'ControlId_13';

// --- note field assembly ---------------------------------------------------

// Turn a portal note plus the operator's manual entries into { ControlId_N: value }.
// Returns `warnings` for anything a human should look at before this is signed.
// The interventions exactly as they will read in InSync, for the details field
// that mirrors them.
function interventionLabels(note) {
  return (Array.isArray(note?.interventions) ? note.interventions : [])
    .map(l => String(l).trim())
    .filter(l => LABEL_TO_CODE.has(l.toLowerCase()))
    .join(', ');
}

function buildNoteFields(note, { manual = {}, offsite = false } = {}) {
  const fields = {};
  const warnings = [];

  for (const f of NOTE_FIELDS) {
    if (f.offsiteOnly && !offsite) continue;

    if (f.manual) {
      let v = clean(manual[f.control]);
      // A field that mirrors another falls back to that field's labels rather
      // than to empty — the operator convention, applied by default.
      if (!v && f.mirrors === 'ControlId_20') v = interventionLabels(note);
      fields[f.control] = v;
      if (!v && f.offsiteOnly) {
        warnings.push(`${f.label} is required by the Offsite template and has no portal source — enter it before running`);
      } else if (!v && !f.mirrors) {
        warnings.push(`${f.label} is empty (the portal export carries no field for it)`);
      }
      continue;
    }

    if (f.kind === 'multiselect') {
      const labels = Array.isArray(note[f.source]) ? note[f.source] : [];
      const codes = [];
      for (const l of labels) {
        const code = LABEL_TO_CODE.get(String(l).trim().toLowerCase());
        if (code) codes.push(code);
        else warnings.push(`Intervention "${l}" has no InSync equivalent — it would be dropped`);
      }
      if (!codes.length) warnings.push(`${f.label} is empty — InSync requires at least one`);
      fields[f.control] = codes.join(',');
      continue;
    }

    const v = clean(note[f.source]);
    fields[f.control] = v;
    if (!v) warnings.push(`${f.label} is empty in the portal note`);
  }

  return { fields, warnings };
}

// --- payload preparation (port of app.py prepare_payloads) -----------------

function escHtml(s, quote = true) {
  let out = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote) out = out.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  return out;
}

function unescHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function two(n) { return String(n).padStart(2, '0'); }

// --- billing ---------------------------------------------------------------
//
// Every field below mirrors the SELECTED encounter type's billing mapping, which
// InSync supplies per type (utils/insyncPortal resolveBilling). The captured
// payloads carried type 1273's numbers -- CPT map 418, modifier 338 (U4), POS 99
// -- in eighteen places across three steps. 1253 is map 401, no modifier, POS 12,
// so replaying the capture bills the wrong thing. The extractor blanks all of
// them; this writes all of them.

// InSync packs the code and its map-row id into one string.
function cptComposite(b) { return `${b.cptCode}#*#&*&${b.cptMapId}`; }

// "<CPT>#*#&*&<mapId>,<M1>,<M2>,<M3>,<M4>,<Units>,&*%^1,&*%^1"
function cptModifiers(b) {
  return [cptComposite(b), b.m1 || '', b.m2 || '', b.m3 || '', b.m4 || '', b.units, '&*%^1', '&*%^1'].join(',');
}

function modifierLabels(b) {
  return [b.m1, b.m2, b.m3, b.m4].filter(Boolean).join(', ');
}

function applyBilling(result, b) {
  const composite = cptComposite(b);
  const mods = modifierLabels(b);
  const procedureDesc = `${b.cptCode} - ${b.cptDescription}`
    + (mods ? ` (Modifiers: ${mods}; Units: ${b.units})` : ` (Units: ${b.units})`) + ' |';

  for (const { params } of Object.values(result)) {
    // The booking grid's CPT row.
    setFields(params, b.cptMapId,      'EncounterTypeCPTMapID');
    setFields(params, b.cptCode,       'CPT_Code', 'CPTCode');
    setFields(params, b.cptDescription,'CPT_Description');
    setFields(params, b.m1,            'M1');
    setFields(params, b.m2,            'M2');
    setFields(params, b.m3,            'M3');
    setFields(params, b.m4,            'M4');
    setFields(params, b.units,         'Units');
    setFields(params, b.cptMapTypeId,  'CPTMapTypeID');

    // Place of service.
    setFields(params, b.posCode,        'POSCode', 'SEPOSCode');
    setFields(params, b.posDescription, 'POSCodeDescription');
    setFields(params, b.posDescription.replace(/^\s*\d+\s*-\s*/, ''), 'SEPOSDescription');
    setFields(params, procedureDesc,    'ProcedureCodeDescription');

    // The encounter form's composites.
    setFields(params, composite,           'SECPTCode');
    setFields(params, cptModifiers(b),     'SECPTModifiers');
    setFields(params, `${composite} -  ${b.cptDescription}`, 'SECPTDescription');

    // Not reachable by suffix: this key has no bracket or dot, so it normalises
    // to ONE segment and `setFields(…, 'SECPTCode')` can never see it.
    if ('SEEncounterDetails_SECPTCode' in params) params.SEEncounterDetails_SECPTCode = composite;

    // The type id InSync echoes back as the previous selection.
    setFields(params, b.visitTypeId, 'OldSEEncounterTypeID');

    // The patient's program enrolment, resolved per patient.
    setFields(params, b.programManagementDetailId, 'ProgramManagementDetailID');
    setFields(params, b.programManagementId,       'ProgramManagementID');
  }
}

// Refuse to send a payload whose billing does not match what InSync said for the
// selected type. Catches both a field we forgot to write and a stale value that
// survived from the capture.
function assertBilling(result, b, forbidden = []) {
  const problems = [];

  // Completeness first. Comparing written-against-expected alone would happily
  // pass a blank CPT map id through, because blank matches blank — InSync would
  // then book a billable encounter with no mapping.
  for (const [name, value] of Object.entries({
    'CPT map id': b.cptMapId, 'CPT code': b.cptCode, units: b.units,
    'place of service': b.posCode, 'program enrolment': b.programManagementDetailId,
  })) {
    if (!String(value ?? '').trim()) problems.push(`${name} is missing`);
  }
  if (problems.length) {
    throw new StepError('billing',
      `Refusing to send: billing does not match InSync's mapping for encounter type ` +
      `${b.visitTypeId} — ${problems.join('; ')}.`);
  }

  const composite = cptComposite(b);

  const expect = {
    EncounterTypeCPTMapID: b.cptMapId,
    SECPTCode: composite,
    SECPTModifiers: cptModifiers(b),
    POSCode: b.posCode,
    SEPOSCode: b.posCode,
  };
  for (const { params } of Object.values(result)) {
    for (const [name, want] of Object.entries(expect)) {
      for (const [k, v] of Object.entries(params)) {
        if (!keyMatchesName(k, name)) continue;
        if (String(v) !== String(want)) problems.push(`${k} is ${JSON.stringify(String(v))}, expected ${JSON.stringify(String(want))}`);
      }
    }
    if ('SEEncounterDetails_SECPTCode' in params && params.SEEncounterDetails_SECPTCode !== composite) {
      problems.push(`SEEncounterDetails_SECPTCode is ${JSON.stringify(params.SEEncounterDetails_SECPTCode)}`);
    }
  }

  // Anything identifying the CAPTURED encounter/patient must be gone.
  const blob = JSON.stringify(Object.fromEntries(
    Object.entries(result).map(([step, { params }]) => [step, params])));
  for (const bad of forbidden) {
    if (!bad || String(bad) === String(b.visitTypeId)) continue;
    if (new RegExp(`(^|[^0-9])${String(bad)}([^0-9]|$)`).test(blob)) {
      problems.push(`the captured encounter type ${bad} still appears in the payload`);
    }
  }

  if (problems.length) {
    throw new StepError('billing',
      `Refusing to send: billing does not match InSync's mapping for encounter type ` +
      `${b.visitTypeId}. ${problems.slice(0, 6).join('; ')}`);
  }
}

function keyMatchesName(key, name) {
  const k = String(key).replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();
  const n = name.toLowerCase();
  return k === n || k.endsWith('.' + n);
}

// The portal gives a date and a minute-of-day; everything InSync wants is a
// formatting of those two. Built without Date so a server TZ can never shift a
// clinical appointment by a day.
function appointmentClock(dateIso, startMinutes, durationMinutes = 0) {
  const [y, m, d] = String(dateIso).split('-').map(Number);
  const mins = Number(startMinutes);
  const h24 = Math.floor(mins / 60), mi = mins % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const date = `${two(m)}/${two(d)}/${y}`;

  // InSync writes the encounter window without a leading zero on the hour
  // ("08/12/2026 1:45 PM"), so match that shape rather than the padded one used
  // for the appointment's own time fields.
  const loose = total => {
    const hh = Math.floor(total / 60) % 24, mm = total % 60;
    const ap = hh >= 12 ? 'PM' : 'AM';
    return `${hh % 12 === 0 ? 12 : hh % 12}:${two(mm)} ${ap}`;
  };
  const endMins = mins + (Number(durationMinutes) || 0);

  return {
    date,
    dateLoose: `${m}/${d}/${y}`,
    time: `${two(h12)}:${two(mi)} ${ampm}`,
    timeSeconds: `${two(h12)}:${two(mi)}:00 ${ampm}`,
    dateTime: `${date} ${two(h12)}:${two(mi)} ${ampm}`,
    // The session window. Billable units are derived from these at close —
    // ValidateDurationForCPT and the program alert both read start/end, not the
    // appointment's slot length — so they are the billing-critical values in the
    // whole chain.
    encounterStart: `${date} ${loose(mins)}`,
    encounterEnd: `${date} ${loose(endMins)}`,
    // Spans past midnight only if a session ever did; kept explicit so a wrong
    // end date is visible rather than silently wrapping.
    endsNextDay: endMins >= 24 * 60,
  };
}

// Patch the current note's answers into the rendered-control HTML blob InSync
// round-trips. Chart-derived treatment-plan content is deliberately NOT written
// here — InSync assembles that itself at GenerateEncounterNote.
function patchDynamicHtml(rendered, fields, encounterId) {
  let out = rendered.replace(/data-encid="[^"]*"/gi, `data-encid="${encounterId}"`);

  for (const [control, value] of Object.entries(fields)) {
    if (control === 'ControlId_20') {
      const codes = clean(value).split(',').map(s => s.trim()).filter(Boolean);
      const display = codes.map(c => CODE_TO_LABEL.get(c) || c).join(', ');
      const replacement =
        `<input type="hidden" id="hdnFieldText_20" class="SumoSelectedText" value="${escHtml(display)}" name="NaN">` +
        `<label class="full-width has-no-control textAlign-left">${escHtml(display, false)}</label>` +
        `<input type="hidden" id="hdnFieldVal_20" class="SumoSelectedVal" value="${escHtml(codes.join(','))}" name="NaN">`;
      out = out.replace(
        /(<div[^>]*data-currentcontrolid="ControlId_20"[\s\S]*?<div class="elem-control has-no-label">)[\s\S]*?(<\/div><img)/i,
        (_m, a, b) => a + replacement + b);
      continue;
    }
    const cid = reEsc(control);
    out = out.replace(
      new RegExp(`(<(?:label|div|textarea)[^>]*\\sid="${cid}"[^>]*>)([\\s\\S]*?)(</(?:label|div|textarea)>)`, 'i'),
      (_m, a, _inner, c) => a + escHtml(clean(value), false) + c);
    out = out.replace(
      new RegExp(`(<input[^>]*\\sid="${cid}"[^>]*\\bvalue=")[^"]*(")`, 'i'),
      (_m, a, b) => a + escHtml(clean(value)) + b);
  }
  return out;
}

// Build every request body for one note. `templates` is the capture pack keyed
// by step: { step: { url, params } }.
function preparePayloads({ templates, ctx, visitId, encounterId, signingPin, capturedVisitTypeId }) {
  const result = {};
  for (const [step, tpl] of Object.entries(templates)) {
    result[step] = { url: tpl.url, params: { ...tpl.params } };
  }

  const t = appointmentClock(ctx.sessionDate, ctx.sessionStartMinutes, ctx.duration);

  for (const { params } of Object.values(result)) {
    setFields(params, ctx.patientId, 'PatientId', 'SEPatientId');
    if (ctx.patientName) setFields(params, ctx.patientName, 'PatientFullName', 'SEPatientName');
    setFields(params, ctx.providerId, 'ProviderID', 'ProviderId', 'ResourceId', 'SEProviderID');
    // The captured provider's NAME rides along in display fields that no id
    // mapping touches, so without this a booking made as one peer would carry
    // the captured clinician's name.
    if (ctx.providerName) {
      setFields(params, ctx.providerName, 'Provider', 'ProviderName', 'SEProviderName', 'ResourceName');
    }
    setFields(params, ctx.visitTypeId, 'EncounterTypeID', 'VisitTypeID', 'SEEncounterTypeID', 'SEVisitTypeID', 'CurrentVisitTypeId');
    setFields(params, ctx.visitTypeName, 'EncounterType', 'VisitTypeDescription', 'SEEncounterType', 'CurrentVisitType');
    setFields(params, visitId, 'VisitID', 'SEVisitID');
    setFields(params, encounterId, 'EncounterId', 'EncounterID');
    setFields(params, t.date, 'VisitDate', 'bookVisitdate', 'RecurrenceStartDate', 'SEVisitStartDate', 'SEEncounterStartDate', 'Vdate');
    setFields(params, t.time, 'VisitTime', 'AppointmentTime', 'SEVisitStartTime', 'SEEncounterStartTime', 'StartTime');
    setFields(params, t.dateTime, 'VisitDateTime', 'SEVisitStartDateTime', 'SEEncounterStartDateTime');
    setFields(params, ctx.duration, 'Duration', 'SEDuration', 'VisitDuration');

    // The schedule the appointment is booked ON. The capture carries the
    // CAPTURED user's (setup 1329 / schedule 1399), and InSync refuses a booking
    // made on one login against another login's schedule — which is what an
    // unexplained DataSave=false turned out to mean. Resolved per peer from
    // their own calendar.
    if (ctx.schedule) {
      if (ctx.schedule.scheduleSetupId) setFields(params, ctx.schedule.scheduleSetupId, 'ScheduleSetupID');
      if (ctx.schedule.scheduleId)      setFields(params, ctx.schedule.scheduleId, 'ScheduleID');
      if (ctx.schedule.scheduleTypeId)  setFields(params, ctx.schedule.scheduleTypeId, 'ScheduleTypeID');
    }
  }

  // Fields that LOOK like ids/dates but are deliberately blank or zero in the
  // request that actually succeeded. Suffix matching above would have filled
  // them; put the captured values back.
  if (result.appointment) {
    const appt = result.appointment.params;
    const orig = templates.appointment.params;
    for (const key of [
      'objBookAppointmentss[PMAlertData][PatientID]',
      'objBookAppointmentss[PMAlertData][VisitID]',
      'objBookAppointmentss[VisitHistory][AppointmentTime]',
      'objBookAppointmentss[VisitHistory][Duration]',
      'objBookAppointmentss[VisitHistory][bookVisitdate]',
      'objBookAppointmentss[VisitTypeDescription]',
    ]) {
      if (key in orig) appt[key] = orig[key];
    }
  }

  if (result.encounter) {
    const enc = result.encounter.params;
    enc['SEEncounterDetails.SEVisitTypeID'] = '0';
    enc['SEEncounterDetails.SEEncounterStartDateTime'] = t.date;
    enc['SEEncounterDetails.SEVisitStartDateTime'] = `${t.date} undefined`;
  }

  if (result.close) {
    const c = result.close.params;
    c['SaveEndEncounter[CurrentVisitTypeId]'] = '0';
    c['SaveEndEncounter[CurrentVisitType]'] = '0';
    c['SaveEndEncounter[VisitID]'] = '0';
    c['SaveEndEncounter[VisitTypeID]'] = '0';
    c['SaveEndEncounter[VisitDateTime]'] = `${t.dateLoose} ${t.timeSeconds}`;
    c['SaveEndEncounter[VisitDate]'] = `${t.dateLoose} 12:00:00 AM`;

    // The encounter's real window. Everything InSync does at close reads these:
    // GetEncounterDurationAlert, ValidateEndEncounterTime and
    // ValidateDurationForCPT are all passed StartTime/EndTime, and the billed
    // units fall out of the span. Leaving them at the captured values closed
    // every encounter against that capture's session instead of its own.
    setFields(c, t.encounterStart, 'EncounterStartDate');
    setFields(c, t.encounterEnd, 'EncounterEndDate');
    if (t.endsNextDay) {
      throw new StepError('close',
        `Session runs past midnight (${ctx.duration} minutes from ${t.encounterStart}). ` +
        `Refusing to close it against a same-day end time.`);
    }
    // Signing happens by carrying a valid EPIN on the close request. Empty when
    // signing is off — never a PIN replayed from a capture.
    setFields(c, signingPin || '', 'EPIN');
  }

  // StartEncounter uses short, non-model-bound names.
  if (result.start) {
    Object.assign(result.start.params, {
      sPatientID: ctx.patientId,
      sVisitID: visitId,
      ResourceId: ctx.providerId,
    });
  }

  if (result.note) {
    const note = result.note.params;

    // Blank EVERY answer control before writing this note's values. The capture
    // pack is scrubbed at extraction, but this is the guard that matters: it
    // runs on whatever pack is actually loaded.
    for (const key of Object.keys(note)) {
      const bare = key.replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();
      if (ANSWER_CONTROLS.some(c => bare.endsWith(c.toLowerCase()))) note[key] = '';
    }

    const missing = [];
    for (const [control, value] of Object.entries(ctx.noteFields)) {
      const keys = Object.keys(note).filter(k => {
        const bare = k.replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();
        return bare === control.toLowerCase() || bare.endsWith('.' + control.toLowerCase());
      });
      if (!keys.length) { missing.push(control); continue; }
      for (const k of keys) note[k] = clean(value);
    }
    if (missing.length) {
      const labels = missing.map(c => (NOTE_FIELDS.find(f => f.control === c) || {}).label || c);
      throw new Error(
        `The stored note template has no ${missing.join(', ')} field (${labels.join(', ')}). ` +
        `That template belongs to a different encounter type — capture the note save for ` +
        `"${ctx.visitTypeName}" and re-run the capture extractor before writing this type.`);
    }

    // Identity controls InSync renders into the form.
    setFields(note, ctx.patientName || '', PATIENT_NAME_CONTROL);
    setFields(note, ctx.providerName || '', PROVIDER_NAME_CONTROL);

    const dynKey = Object.keys(note).find(k => /dynamichtml/i.test(k));
    if (dynKey) {
      const patched = patchDynamicHtml(unescHtml(note[dynKey]), ctx.noteFields, encounterId);
      note[dynKey] = escHtml(patched);
    }
  }

  // Everything that follows from the chosen encounter type — CPT, modifiers,
  // units, POS — plus the patient's program enrolment. Written LAST so no
  // earlier pass can leave a captured value behind, then asserted before the
  // payload is allowed out.
  if (ctx.billing) {
    const b = { ...ctx.billing, visitTypeId: ctx.visitTypeId };
    applyBilling(result, b);
    assertBilling(result, b, [capturedVisitTypeId].filter(Boolean));
  }

  return result;
}

// --- execution -------------------------------------------------------------

class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}

async function send(prepared, step, cookie, log) {
  const { url, params } = prepared[step];
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  await log('info', step, `POST ${path} (${Object.keys(params).length} fields)`);
  const res = await post(path, params, cookie);
  const text = await res.text();
  if (!res.ok) throw new StepError(step, `${step}: InSync returned HTTP ${res.status}`);
  if (/Session Timeout/i.test(text.slice(0, 4000))) {
    throw new StepError(step, `${step}: the InSync session was lost`);
  }
  let body = null;
  try { body = JSON.parse(text); } catch { /* some steps answer with HTML */ }
  return { body, text };
}

// One note, start to finish, on an already-authenticated peer session.
// `existing` is the appointment found by the calendar check, or null.
//
// Any unexpected result throws — the caller records the failure against THIS
// note and moves to the next rather than plowing on through a bad state.
async function executeNote({ templates: pack, ctx, cookie, existing, signingPin, allowSign, dryRun, log, capturedVisitTypeId }) {
  // Offsite is switched OFF by policy: the portal has no field for the
  // justification the Offsite template requires (ControlId_27), so an Offsite
  // encounter could only ever be signed with that field blank. The review screen
  // hides these types; this is the backstop for a staged row that still carries
  // one. The two-template machinery below stays intact — re-enabling is deleting
  // this guard and the dropdown filter.
  if (ctx.offsite || /\boffsite\b/i.test(String(ctx.visitTypeName || ''))) {
    throw new StepError('encounter_type',
      `Offsite encounter types are not enabled: "${ctx.visitTypeName}" requires an offsite ` +
      `justification the portal does not yet capture. Pick the non-Offsite type instead.`);
  }

  const templates = templatesFor(pack, !!ctx.offsite);
  const missingSteps = REQUIRED_STEPS.filter(s => !templates[s]);
  if (missingSteps.length && !(existing && missingSteps.length === 1 && missingSteps[0] === 'appointment')) {
    throw new StepError('captures',
      `No captured request template for: ${missingSteps.join(', ')}. ` +
      `Run scripts/extract-insync-captures.js against a HAR containing those calls.`);
  }

  if (dryRun) {
    const prepared = preparePayloads({
      templates, ctx, capturedVisitTypeId,
      visitId: existing ? existing.visitId : '<created visit>',
      encounterId: '<created encounter>',
      signingPin: allowSign ? '<peer PIN>' : '',
    });
    await log('info', 'dry_run', existing
      ? `Would REUSE appointment VisitID ${existing.visitId} (${ctx.sessionDate} @ ${ctx.sessionStartMinutes} min, not cancelled)`
      : `Would CREATE an appointment on ${ctx.sessionDate} at minute ${ctx.sessionStartMinutes}, ${ctx.duration} min`);
    for (const step of REQUIRED_STEPS) {
      if (step === 'appointment' && existing) continue;
      if (!prepared[step]) continue;
      await log('info', step, `Would POST ${prepared[step].url.replace(/^https?:\/\/[^/]+/, '')} (${Object.keys(prepared[step].params).length} fields)`);
    }
    await log('info', 'sign', allowSign
      ? 'Would sign the closed encounter with the peer PIN'
      : 'Would close WITHOUT signing');
    return { dryRun: true, visitId: existing?.visitId || null, encounterId: null, appointmentReused: !!existing, signed: false };
  }

  // 1–2. Use the existing appointment, or book one.
  let visitId = existing?.visitId || null;
  if (visitId) {
    await log('info', 'appointment', `Reusing existing appointment VisitID ${visitId}`);
  } else {
    const prep = preparePayloads({ templates, ctx, capturedVisitTypeId, visitId: '0', encounterId: '0', signingPin: '' });
    const { body } = await send(prep, 'appointment', cookie, log);
    visitId = appointmentResult(body);
    await log('info', 'appointment', `Created appointment VisitID ${visitId}`);
  }

  // 3. Open/create the encounter.
  let prep = preparePayloads({ templates, ctx, capturedVisitTypeId, visitId, encounterId: '0', signingPin: '' });
  await send(prep, 'start', cookie, log);
  const encRes = await send(prep, 'encounter', cookie, log);
  const encounterId = responseId(encRes.body, encRes.text, 'EncounterId', 'EncounterID', 'eid');
  if (!encounterId) throw new StepError('encounter', 'Encounter response exposed no EncounterID — the note was not saved');
  await log('info', 'encounter', `Created encounter ${encounterId}`);

  // 4. Fill the note.
  prep = preparePayloads({ templates, ctx, capturedVisitTypeId, visitId, encounterId, signingPin: allowSign ? signingPin : '' });
  const noteRes = await send(prep, 'note', cookie, log);
  if (!noteRes.body || noteRes.body.Status !== 1) {
    throw new StepError('note', 'InSync did not confirm the peer-note save with Status=1');
  }
  await log('info', 'note', 'Note fields saved');

  // 5. InSync assembles diagnosis / treatment plan / visit codes here. This app
  //    supplies none of that — it only asks for it to be generated.
  const gen = await send(prep, 'generate', cookie, log);
  await log('info', 'generate', gen.text.slice(0, 5000).includes('StrEncounterNote')
    ? 'InSync assembled the chart-derived diagnosis / plan / visit-code content'
    : 'Generate accepted; StrEncounterNote not visible in the response prefix');

  // 6–7. Close, and sign if the PIN was supplied.
  const closeRes = await send(prep, 'close', cookie, log);
  let signed = false;
  if (allowSign) {
    const epin = closeRes.body?.EPINStatus || {};
    if (epin.EPINCorrect !== true || epin.SignatureExist !== true) {
      throw new StepError('close', 'InSync did not confirm a correct signing PIN and a provider signature');
    }
    signed = true;
    await log('info', 'close', 'Encounter closed and signed');
  } else {
    await log('warn', 'close', 'Encounter closed WITHOUT a signature (signing was off)');
  }

  return { dryRun: false, visitId, encounterId, appointmentReused: !!existing, signed };
}

module.exports = {
  NOTE_FIELDS, ANSWER_CONTROLS, PEER_INTERVENTIONS, REQUIRED_STEPS,
  buildNoteFields, interventionLabels, preparePayloads, executeNote, appointmentClock,
  patchDynamicHtml, escHtml, unescHtml, StepError,
  noteStepFor, templatesFor,
  isOffsiteType: name => parseInsyncTypeName(name).offsite,
};
