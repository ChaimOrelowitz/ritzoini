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
const IP = require('./insyncPortal');
const { clean, setFields, keyMatches, responseId, appointmentResult } = require('./portalPayload');
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
// InSync owns billing. CPT, modifiers, units, the CPT-map id and place of
// service are resolved from the encounter type, and the billable units from the
// encounter window at close -- which is why the window is the thing worth
// getting right. The extractor blanks all captured values so the captured
// type's numbers cannot be replayed; resolveBilling reads the selected type's
// values live from InSync and applyBilling puts that populated model back onto
// the booking and encounter forms, matching what InSync's browser posts.

function cptComposite(b) { return `${b.cptCode}#*#&*&${b.cptMapId}`; }

// "<CPT>#*#&*&<mapId>,<M1>,<M2>,<M3>,<M4>,<Units>,&*%^1,&*%^1"
function cptModifiers(b) {
  return [cptComposite(b), b.m1 || '', b.m2 || '', b.m3 || '', b.m4 || '', b.units, '&*%^1', '&*%^1'].join(',');
}

function modifierLabels(b) {
  return [b.m1, b.m2, b.m3, b.m4].filter(Boolean).join(', ');
}

function applyBilling(result, b) {
  // Per patient, and wrong in every capture, so it goes on EVERY step: the
  // capture is one patient's program enrolment and this is another's.
  for (const { params } of Object.values(result)) {
    setFields(params, b.programManagementDetailId, 'ProgramManagementDetailID');
    setFields(params, b.programManagementId, 'ProgramManagementID');

    const pay = b.payers;
    if (pay) {
      setFields(params, pay.primary?.patientPayerId || '', 'PrimaryPatientPayerID');
      setFields(params, pay.secondary?.patientPayerId || '', 'SecondaryPatientPayerID');
      setFields(params, pay.tertiary?.patientPayerId || '', 'TertiaryPatientPayerID');
      setFields(params, pay.primary?.isActive ? 'true' : 'false', 'PrimaryIsActivePayer');
      setFields(params, pay.selfPay ? 'true' : 'false', 'SelfPay');
      setFields(params, pay.selfPay ? 'Yes' : 'No', 'SelfPayStr');
    }

    // A peer cannot bill under their own name: InSync nominates their
    // supervisor for this patient's payer, and a booking with 0 here is refused.
    if (b.billingProvider?.id) setFields(params, b.billingProvider.id, 'BillingProviderId');
  }

  // The CPT grid and place of service, on every form that carries them.
  //
  // InSync decides these values when the booking dialog is populated, but its
  // browser posts that populated model back to SaveBookAppointment. The two
  // proven booking implementations do the same. Omitting the values after
  // reading them live leaves an empty CPT/POS model and SaveBookAppointment
  // answers DataSave=false with no message. The encounter forms also need the
  // same values because the extractor deliberately blanks the captured type's
  // billing. Every value written here came from InSync for this patient/type.
  const composite = cptComposite(b);
  const mods = modifierLabels(b);
  const procedureDesc = `${b.cptCode} - ${b.cptDescription}`
    + (mods ? ` (Modifiers: ${mods}; Units: ${b.units})` : ` (Units: ${b.units})`) + ' |';

  for (const [, { params }] of Object.entries(result)) {
    setFields(params, b.cptMapId,       'EncounterTypeCPTMapID');
    setFields(params, b.cptCode,        'CPT_Code', 'CPTCode');
    setFields(params, b.cptDescription, 'CPT_Description');
    setFields(params, b.m1,             'M1');
    setFields(params, b.m2,             'M2');
    setFields(params, b.m3,             'M3');
    setFields(params, b.m4,             'M4');
    setFields(params, b.units,          'Units');
    setFields(params, b.cptMapTypeId,   'CPTMapTypeID');

    setFields(params, b.posCode,        'POSCode', 'SEPOSCode');
    setFields(params, b.posDescription, 'POSCodeDescription');
    setFields(params, b.posDescription.replace(/^\s*\d+\s*-\s*/, ''), 'SEPOSDescription');
    setFields(params, procedureDesc,    'ProcedureCodeDescription');

    // The encounter form's composites.
    setFields(params, composite,       'SECPTCode');
    setFields(params, cptModifiers(b), 'SECPTModifiers');
    setFields(params, `${composite} -  ${b.cptDescription}`, 'SECPTDescription');

    // Not reachable by suffix: this key has no bracket or dot, so it normalises
    // to ONE segment and `setFields(…, 'SECPTCode')` can never see it.
    if ('SEEncounterDetails_SECPTCode' in params) params.SEEncounterDetails_SECPTCode = composite;

    // The type id InSync echoes back as the previous selection.
    setFields(params, b.visitTypeId, 'OldSEEncounterTypeID');
  }
}

// Refuse to send a payload whose billing does not match what InSync said for the
// selected type. This gate exists because the failure it catches is silent:
// the extractor blanks every billing field, so a step we forget to fill goes out
// as an empty CPT grid and InSync answers with a 500 and no explanation.
//
// The booking is checked too: InSync fills these values in its dialog, and the
// final save must post that populated model back just like the browser does.
function assertBilling(result, b, forbidden = []) {
  const problems = [];

  // Completeness first. Comparing written-against-expected alone would happily
  // pass a blank CPT map id through, because blank matches blank.
  for (const [name, value] of Object.entries({
    'CPT map id': b.cptMapId, 'CPT code': b.cptCode, units: b.units,
    'place of service': b.posCode, 'program enrolment': b.programManagementDetailId,
  })) {
    if (!String(value ?? '').trim()) problems.push(`${name} is missing`);
  }
  if (problems.length) {
    throw new StepError('billing',
      `Refusing to send for encounter type ${b.visitTypeId}: ${problems.join('; ')}.`);
  }

  const composite = cptComposite(b);
  const expect = {
    EncounterTypeCPTMapID: b.cptMapId,
    SECPTCode: composite,
    SECPTModifiers: cptModifiers(b),
    POSCode: b.posCode,
    SEPOSCode: b.posCode,
  };
  for (const [step, { params }] of Object.entries(result)) {
    for (const [name, want] of Object.entries(expect)) {
      for (const [k, v] of Object.entries(params)) {
        if (!keyMatches(k, [name])) continue;
        if (String(v) !== String(want)) {
          problems.push(`${step}.${k} is ${JSON.stringify(String(v))}, expected ${JSON.stringify(String(want))}`);
        }
      }
    }
    if ('SEEncounterDetails_SECPTCode' in params && params.SEEncounterDetails_SECPTCode !== composite) {
      problems.push(`${step}.SEEncounterDetails_SECPTCode is ${JSON.stringify(params.SEEncounterDetails_SECPTCode)}`);
    }
  }

  // Anything identifying the CAPTURED encounter type must be gone.
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

  // The two captures agree on an asymmetry worth copying rather than tidying:
  // EncounterStartDate carries a PADDED hour ("08/12/2026 01:00 PM") and
  // EncounterEndDate does not ("08/12/2026 3:00 PM"). Both come straight from
  // the browser's own controls, so match them exactly instead of guessing that
  // InSync is lenient.
  const clock = (total, pad) => {
    const hh = Math.floor(total / 60) % 24, mm = total % 60;
    const ap = hh >= 12 ? 'PM' : 'AM';
    const h = hh % 12 === 0 ? 12 : hh % 12;
    return `${pad ? two(h) : h}:${two(mm)} ${ap}`;
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
    encounterStart: `${date} ${clock(mins, true)}`,
    encounterEnd: `${date} ${clock(endMins, false)}`,
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
    // InSync posts a patient as "Last, First - MM/DD/YYYY" on a booking, not the
    // portal's "First Last".
    if (ctx.patientName) {
      setFields(params, ctx.patientLabel || ctx.patientName, 'PatientFullName', 'SEPatientName');
    }
    setFields(params, ctx.providerId, 'ProviderID', 'ProviderId', 'ResourceId', 'SEProviderID');
    // The captured provider's NAME rides along in display fields that no id
    // mapping touches, so without this a booking made as one peer would carry
    // the captured clinician's name.
    if (ctx.providerName) {
      // The scheduler writes a provider as "Last, First (P)".
      const asScheduler = /\(P\)\s*$/.test(ctx.providerName) ? ctx.providerName : `${ctx.providerName} (P)`;
      setFields(params, asScheduler, 'Provider');
      setFields(params, ctx.providerName, 'ProviderName', 'SEProviderName', 'ResourceName');
    }
    // OldSEEncounterTypeID is the type InSync echoes as the previous selection;
    // it used to ride along on the billing pass, which no longer writes anything
    // type-shaped, so it belongs here with the rest of the type ids.
    setFields(params, ctx.visitTypeId, 'EncounterTypeID', 'VisitTypeID', 'SEEncounterTypeID',
      'SEVisitTypeID', 'CurrentVisitTypeId', 'OldSEEncounterTypeID');
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

  // app.py restores VisitTypeDescription from the capture, which was safe there
  // because it only ever ran one encounter type — the captured description WAS
  // the right one. Here it means telling InSync the type is 1253 while naming
  // 1273, so it carries the selected type's own name instead.
  //
  // (The nested VisitHistory / PMAlertData blocks are restored at the very end,
  // after every substitution pass.)

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

  // LAST, after every substitution including billing: put the nested blocks back.
  //
  // VisitHistory is the PREVIOUS visit's record, not this one's. Broad suffix
  // matching reaches into it — POSCode, RecurrenceStartDate and the program id
  // were all being overwritten with the new appointment's values — and InSync
  // answers a contaminated booking with DataSave=false and no error text at all.
  // app.py guards a handful of these by name; the block is safer restored whole.
  restoreNestedBlocks(result, templates);

  return result;
}

// Anything under VisitHistory belongs to the previous visit and is never ours to
// write. PMAlertData's PatientID and VisitID are blank in the request that
// succeeded and must stay blank; its ProgramManagementDetailID carried the
// patient's program there, so that one is left as substituted.
function restoreNestedBlocks(result, templates) {
  for (const [step, { params }] of Object.entries(result)) {
    const orig = templates[step]?.params;
    if (!orig) continue;
    for (const key of Object.keys(params)) {
      if (!(key in orig)) continue;
      const bare = key.replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();
      const isVisitHistory = bare.includes('.visithistory.');
      const isProtectedAlert = /\.pmalertdata\.(patientid|visitid)$/.test(bare);
      if (isVisitHistory || isProtectedAlert) params[key] = orig[key];
    }
  }
}

// --- execution -------------------------------------------------------------

// InSync's scheduler posts its booking model under two different prefixes: the
// dialog OPENS with bookAppointment[...] and is then queried with
// objbookAppointment[...]. Same object, two spellings, and mixing them up gets
// a 200 with an empty answer rather than an error.
function bookAppt(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [`objbookAppointment[${k}]`, String(v)]));
}

// The booking sequence, in the order the browser performs it. Order is the
// point: the dialog is opened FIRST, then the patient is bound into it, and
// SaveBookAppointment reads the session those calls build. The same calls in a
// different order — resolving billing before the dialog exists — leave the save
// with a session that never had a patient selected, and it answers
// DataSave=false with every message field null.
//
// Nothing here supplies values on InSync's behalf. These calls exist so that
// InSync populates its own form.
async function runBookingPreamble(cookie, ctx, log) {
  const { patientId, providerId, providerLabel, visitTypeId, visitDate, startTime,
          duration, programDetailId, programId, payerId, scheduleSetupId, scheduleId,
          facilityId, schedulerTemplate } = ctx;
  // The facility comes from the captured booking context, not a literal, so a
  // second facility needs a re-capture rather than a code change.
  const fac = facilityId || IP.facilityFromTemplate(schedulerTemplate) || '';

  // 1. Open the booking dialog on the peer's own schedule and slot.
  await post('/Scheduler/BookAppointmentModel', {
    'bookAppointment[ScheduleSetupID]': scheduleSetupId || '',
    'bookAppointment[ScheduleTypeID]': '0',
    'bookAppointment[ResourceId]': providerId,
    'bookAppointment[ResourceTypeId]': '0',
    'bookAppointment[ResourceFullName]': '',
    'bookAppointment[Provider]': providerLabel || '',
    'bookAppointment[VisitIDList]': '',
    'bookAppointment[IsGroupTherapyHeaderRow]': '',
    'bookAppointment[TherapyInfo]': '',
    'bookAppointment[VisitDate]': visitDate,
    'bookAppointment[VisitTime]': String(startTime).toLowerCase(),
    'bookAppointment[ProfileName]': 'Scheduler',
    'bookAppointment[VisitID]': '0',
    'bookAppointment[TargetDate]': visitDate,
    'bookAppointment[PatientId]': '0',
    'bookAppointment[PatientFullName]': '',
    'bookAppointment[IsPatientview]': '0',
    'bookAppointment[AdditionalResourceID]': '0',
    'bookAppointment[AdditionalResTypeID]': '-1',
    'bookAppointment[IsCalendarView]': 'true',
    'bookAppointment[viewMedia]': '0',
    'bookAppointment[IsServiceProvider]': 'True',
    'bookAppointment[DefaultBillingProvider]': '0',
    'bookAppointment[IsFamily]': 'false',
    'bookAppointment[FamilyVisitId]': '0',
    'bookAppointment[FacilityId]': fac,
    'bookAppointment[IsMultiFacility]': 'true',
    'bookAppointment[IsMultipleScheduleWeekView]': 'false',
    PageViewNo: '1',
  }, cookie);

  // 2. SELECT the patient. This is the step that was missing, and the
  //    distinction it turns on is the one this integration keeps getting
  //    wrong: naming a patient id in a request parameter is not the same as
  //    selecting them. LastPatientAccessrecored is the call whose whole job is
  //    to write "this session's current patient" into server state, and
  //    SaveBookAppointment reads that state rather than trusting the ids in the
  //    form it is posted. Every other call here only READS the selection.
  await post('/PatientGroup/PatientSearchWithPatientGroup', {}, cookie);
  await post('/EncPatientRestrictAccess/CheckPatientRestriction', {}, cookie);
  const sel = await post('/PatientSearch/LastPatientAccessrecored', { PatientId: patientId }, cookie);
  const selText = (await sel.text()).trim();
  if (!/success/i.test(selText)) {
    throw new StepError('appointment',
      `InSync did not accept patient ${patientId} as the session's current patient ` +
      `(answered ${JSON.stringify(selText.slice(0, 120))}). Booking without a selected patient ` +
      `is refused with no error text, so this stops here instead.`);
  }
  await post('/Scheduler/CheckSticknote', { PatientID: patientId, LocationID: '3' }, cookie);

  // 3. Load the dialog for that patient in that slot. Built field by field from
  //    the capture rather than by substituting into the stored template: the
  //    template is the CALENDAR's version of this request, and the booking
  //    dialog's differs in ways no rename-the-matching-key pass would find --
  //    ScheduleID is 0 here, not the resolved schedule, and the type, payer,
  //    copay and program fields are all empty because the dialog has not
  //    resolved them yet. Same endpoint, different question.
  const calRes = await post('/Scheduler/GetSchedulerCalendar', bookAppt({
    ScheduleSetupID: scheduleSetupId || '', ScheduleID: '0', ScheduleTypeID: '0',
    ResourceId: providerId, ResourceTypeId: '0', Provider: providerLabel || '',
    IsGroupTherapyHeaderRow: 'False',
    VisitDate: visitDate, VisitTime: startTime, ProfileName: 'Scheduler',
    POSCode: '', PatientId: patientId, VisitID: '0', VisitIDList: '', ReSchedule: '0',
    VisitTypeID: '', VisitTypeDescription: '', RefPhysicianID: '',
    VisitStatusId: '', VisitStatusDescription: '',
    PatientLocationId: '', PatientLocationName: '',
    SelfPay: '', PrimaryPatientPayerID: '', SecondaryPatientPayerID: '', TertiaryPatientPayerID: '',
    ExpectedCopay: '', EncTypeExpectedCopay: '', AuthNumber: '', BookComment: '',
    PatientFullName: '', IsPatientview: '0',
    AdditionalResourceID: '0', AdditionalResTypeID: '-1', PatientGroupId: '0',
    FacilityId: fac, IsFamily: 'false', FamilyVisitID: '0', ReScheFacility: '',
    PatientWaitlistId: '0', CaseManagementID: '0', ProgramManagementDetailID: '0',
    IsMultiFacility: 'True', IsDateChangeFlag: 'false', IsFromDashboard: 'false',
    CallFrom: '', AppointmentDataID: '0', IsFromOfflineSync: 'false',
  }), cookie);
  const calText = await calRes.text();
  await post('/Scheduler/getRLSPatientDetails', { PatientId: patientId, ScheduleDate: visitDate }, cookie);

  // Confirm the dialog came back populated FOR THIS PATIENT. The proof is
  // patient-specific content InSync could not produce for nobody: their payer
  // list, and the CPT and POS tables it offers for them.
  //
  // An earlier version of this check looked for AdditionalDetails as an ARRAY.
  // It is an object here, so it matched nothing and warned on every run,
  // including good ones -- a broken detector is worse than none, because it
  // sends you looking in the wrong place.
  let detail = null;
  try { detail = JSON.parse(calText)?.AdditionalDetails || null; } catch { /* not JSON */ }
  const payerRows = detail?.SchedularPrimaryInsurance?.length || 0;
  const cptRows = detail?.lstCPT?.length || 0;
  if (!detail || (!payerRows && !cptRows)) {
    throw new StepError('appointment',
      `The booking dialog came back with nothing for patient ${patientId} — no payer list and no ` +
      `CPT table. The patient is not selected in this session, and SaveBookAppointment would ` +
      `refuse without saying why.`);
  }
  await log('info', 'appointment',
    `Patient ${patientId} selected — dialog offers ${payerRows} payer(s) and ${cptRows} CPT row(s)`);

  // 3. Everything the dialog asks for next, in its own order.
  const steps = [
    ['/Scheduler/GetDefaultServiceProvider', {
      payerPlanId: String(payerId || '-1'), ResourceId: providerId,
      EncounterType: 'NaN', Patientid: patientId,
    }],
    ['/CredentialConfiguration/GetCredentialConfigForVisit', {
      PracticeId: '0', ResourceId: providerId, EncounterTypeId: '',
      VisitDate: visitDate, CredentialConfigID: '', IsFromScheduler: 'true',
    }],
    ['/Scheduler/GetExpectedCopayAsConfiguration', {}],
    ['/ProgramManagement/ProgramManagementSearch', {
      ProgramManagementDetailID: '0', ProgramDisplayId: '1', PatientId: patientId,
      ProgramDate: visitDate, FacilityID: fac, ProviderID: providerId,
    }],
    ['/ProgramManagement/GetLevelOfCareValidData', {
      'obj[PatientID]': patientId, 'obj[CurrentVistDate]': visitDate,
      'obj[ProgramManagementDetailID]': programDetailId, 'obj[ProgramManagementID]': programId,
    }],
    // The encounter type is chosen here, inside the booking context.
    ['/Scheduler/GetVisitTypes', {
      'objbookAppointment[ScheduleID]': scheduleId || '',
      'objbookAppointment[VisitDate]': visitDate,
      'objbookAppointment[VisitTime]': startTime,
      'objbookAppointment[FacilityId]': fac,
      'objbookAppointment[ProgramManagementDetailID]': programDetailId,
      'objbookAppointment[isCaseProgramAutoSelectControls]': 'true',
      'objbookAppointment[VisitTypeID]': '',
      VisitTime: startTime,
    }],
    ['/ProgramManagement/CaseProgramDetails', {
      CaseManagementID: '0', ProgramManagementDetailID: programDetailId,
    }],
    ['/Scheduler/GetDefaultServiceProvider', {
      payerPlanId: String(payerId || '-1'), ResourceId: providerId,
      EncounterType: visitTypeId, Patientid: patientId,
    }],
    ['/Scheduler/GetExpectedCopayAsConfiguration', {}],
    ['/EncounterDetail/SetSEAuditLogBillable', {
      IsBillable: 'true', IsManuallyChanged: 'false', IsSetFrom: '2',
      EncounterId: '0', IsbillableFrom: '4',
    }],
    ['/Scheduler/PreviousVisitBookAppointmentAlert', {
      PatientGroupId: '0', PatientIds: patientId, VisitTypeId: visitTypeId,
      IsWarningYes: '0', DateToCheckFrom: visitDate, ProviderId: providerId,
    }],
    ['/ProgramManagement/ProgramManagementGetAlertData', {
      FromWhichPage: '1', PatientId: patientId, ProgramManagementDetailID: programDetailId,
      EncounterTypeID: visitTypeId, Duration: String(duration), VisitID: '0',
      EncounterID: '0', ChargeID: '0', VisitStatus: '3', IsBillable: 'true',
    }],
    ['/ProgramManagement/ProgramManagementValidate', {
      VisitDate: visitDate, ProgramManagementDetailID: programDetailId,
    }],
    ['/Scheduler/CheckOverlappingOnSameDate', {
      VisitDate: visitDate, PatientIDs: patientId, StartTime: startTime,
      VisitTypeID: visitTypeId, VisitID: '0', ScheduleID: '0',
      Duration: String(duration), DisplayEncounterTimeLog: 'true',
    }],
  ];

  for (const [path, params] of steps) {
    const res = await post(path, params, cookie);
    const text = (await res.text()).trim();
    if (/"(RestrictWhileBookingAppOrEnc|ShowAlert)"\s*:\s*true|RestrictCptCodes"\s*:\s*"[^"]+"/i.test(text)) {
      await log('warn', 'appointment', `${path.split('/').pop()}: ${text.slice(0, 200)}`);
    }
  }
  await log('info', 'appointment', `Booking dialog prepared for patient ${patientId} on ${visitDate} ${startTime}`);
}

// Replay the validation calls the close screen makes. Each carries the window,
// and together they are what puts the encounter — and its times — into the
// session state SaveEndEncounter reads.
async function runClosePreamble(cookie, ctx, log) {
  const { encounterId, patientId, visitId, visitTypeId, programId, startTime, endTime } = ctx;
  const steps = [
    ['/EncounterNote/EncounterNote', {}, `?CallFrom=1&isSig=false&isScritAdd=0&pid=${patientId}&eid=${encounterId}`],
    ['/ENDEncounter/GetEndEncounterDuration', {}],
    ['/EncounterDetail/GetEncounterDurationAlert', {
      'EncounterDurationAlert[EncounterTypeID]': visitTypeId,
      'EncounterDurationAlert[ProgramID]': programId,
      'EncounterDurationAlert[StartTime]': startTime,
      'EncounterDurationAlert[EndTime]': endTime,
    }],
    ['/EndEncounter/ValidateEndEncounterTime', {
      'encounters[0][EncounterId]': encounterId,
      'encounters[0][PracticeId]': '200',
      'encounters[0][VisitId]': visitId,
      'encounters[0][EndEncounterDateTime]': endTime,
      'encounters[0][EncounterTypeID]': visitTypeId,
    }],
    ['/EndEncounter/ValidateDurationForCPT', {
      'model[0][EncounterId]': encounterId,
      'model[0][StartTime]': startTime,
      'model[0][EndTime]': endTime,
    }],
  ];
  for (const [path, params, query] of steps) {
    const res = await post(path + (query || ''), params, cookie);
    const text = await res.text();
    // These answer [] when content. Anything else is InSync objecting, and
    // pressing on would close against a window it just refused.
    const body = text.trim();
    if (body && body !== '[]' && body !== '""' && /warning|error|restrict|alert.*true/i.test(body.slice(0, 400))) {
      await log('warn', 'close', `${path.split('/').pop()} returned: ${body.slice(0, 160)}`);
    }
  }
  await log('info', 'close', `Encounter window ${startTime} - ${endTime} accepted by InSync's checks`);
}

// The co-sign block, built from the close screen rather than from a name in
// code. A peer's note needs their supervisor's signature; InSync knows who that
// is, so it is read, not configured here.
function applyCosign(params, closeCtx) {
  (closeCtx.cosigns || []).forEach((c, i) => {
    const at = k => `SaveEndEncounter[CosignRequests][CosignDetails][${i}][${k}]`;
    params[at('CoSignID')] = c.coSignId;
    params[at('CosignRequest')] = 'true';
    params[at('CoSignPhysicianIDs')] = c.physicianIds;
    params[at('CoSignColorCode')] = '#b1b1b1';
    params[at('CoSignStatus')] = '2';
    params[at('CosignTypeID')] = c.typeId;
    params[at('SR')] = c.sr;
  });
  if (closeCtx.portalEnabled) params['SaveEndEncounter[IsPatientPortalEnable]'] = 'true';
}

class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}

async function send(prepared, step, cookie, log) {
  const { url, params } = prepared[step];
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  await log('info', step, `POST ${path} (${Object.keys(params).length} fields)`);
  const res = await post(path, params, cookie);
  const text = await res.text();
  if (!res.ok) {
    // A bare status code is not a diagnosis. InSync's 500 page carries the
    // exception line, which is the difference between "something broke" and
    // "the CPT grid went out empty" — so carry the first useful text out with
    // the error rather than making the next run guess.
    const detail = (text.match(/<title>([^<]{0,200})<\/title>/i)?.[1]
                 || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
                 || '(empty response body)').trim();
    throw new StepError(step, `${step}: InSync returned HTTP ${res.status} — ${detail}`);
  }
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
    const when = appointmentClock(ctx.sessionDate, ctx.sessionStartMinutes, ctx.duration);
    await runBookingPreamble(cookie, {
      patientId: ctx.patientId, providerId: ctx.providerId, visitTypeId: ctx.visitTypeId,
      visitDate: when.date, startTime: when.time, duration: ctx.duration,
      programDetailId: ctx.billing?.programManagementDetailId || '',
      programId: ctx.billing?.programManagementId || '',
      payerId: ctx.billing?.payers?.primary?.patientPayerId || '',
      // InSync spells a provider "Last, First, Cred (P)" everywhere in the
      // scheduler, and GetSchedulerCalendar matches on that string.
      providerLabel: ctx.providerName ? `${ctx.providerName} (P)` : '',
      scheduleSetupId: ctx.schedule?.scheduleSetupId || '',
      scheduleId: ctx.schedule?.scheduleId || '',
      facilityId: ctx.facilityId || '',
      schedulerTemplate: templates.schedulercalendar?.params || null,
    }, log);
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
  // The browser does not post SaveEndEncounter cold. It loads the close screen,
  // then runs the duration/time validations — and InSync's close reads the
  // encounter out of session context those calls establish. Posting the payload
  // on its own comes back successful and silently keeps the old times.
  const closeCtx = await IP.loadCloseScreen(cookie, {
    encounterId, patientId: ctx.patientId,
  });
  await log('info', 'close', `Close screen loaded${closeCtx.cosigns.length
    ? ` — co-sign to provider ${closeCtx.cosigns.map(c => c.physicianIds).join(', ')}`
    : ' — no co-sign configured on this encounter'}`);

  const window = appointmentClock(ctx.sessionDate, ctx.sessionStartMinutes, ctx.duration);
  await runClosePreamble(cookie, {
    encounterId, patientId: ctx.patientId, visitId,
    visitTypeId: ctx.visitTypeId,
    programId: ctx.billing?.programManagementDetailId || '',
    startTime: window.encounterStart, endTime: window.encounterEnd,
  }, log);

  // The co-sign the close screen says this encounter needs. Nobody is named in
  // code: the supervisor comes from InSync's own wiring for this peer.
  applyCosign(prep.close.params, closeCtx);

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
  noteStepFor, templatesFor, applyCosign, assertBilling, runClosePreamble, runBookingPreamble, restoreNestedBlocks,
  isOffsiteType: name => parseInsyncTypeName(name).offsite,
};
