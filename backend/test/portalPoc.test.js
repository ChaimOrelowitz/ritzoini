// Portal POC tests — encounter-type matching, name resolution, credential
// crypto, the appointment-exists rule, and the note/payload assembly.
//
// Run: node test/portalPoc.test.js
//
// No network and no database: the visit-type list is the reference snapshot from
// portal_POC/INSYNC_API.md, and the notes are the real portal export in
// portal_POC/sample_notes.json.

const assert = require('assert');
const path = require('path');

process.env.PORTAL_CRED_KEY = require('crypto').randomBytes(32).toString('base64');

const M = require('../utils/portalMatch');
const X = require('../utils/portalExecute');
const P = require('../utils/portalPayload');
const C = require('../utils/portalCrypto');
const IP = require('../utils/insyncPortal');

const SAMPLE = require(path.join(__dirname, '../../portal_POC/sample_notes.json'));

// The live GetVisitTypes shape, populated from the verified snapshot.
const VISIT_TYPES = [
  [1241, 'Peer Support - Individual - English - In the clinic'],
  [1253, 'Peer Support - Individual - English - In-person at Home'],
  [1242, 'Peer Support - Individual - English - Telehealth with video and audio when the client is home'],
  [1254, 'Peer Support - Individual - Language other than English - In-person Home'],
  [1243, 'Peer Support - Individual - English - Telehealth audio only when the client is home'],
  [1244, 'Peer Support - Individual - English - Telehealth with video when the client is not home'],
  [1245, 'Peer Support - Individual - English - Telehealth audio only when the client is not home'],
  [1246, 'Peer Support - Individual - English - In-person outside the clinic'],
  [1247, 'Peer Support - Individual - Language other than English - In the clinic'],
  [1248, 'Peer Support - Individual - Language other than English - Telehealth video & audio when client is home'],
  [1249, 'Peer Support - Individual - Language other than English - Telehealth audio only when client is home'],
  [1250, 'Peer Support - Individual - Language other than English - Telehealth video when client is not home'],
  [1251, 'Peer Support - Individual - Language other than English - Telehealth audio when client is not home'],
  [1252, 'Peer Support - Individual - Language other than English - In-person outside the clinic'],
  [1271, 'Peer Support - Individual - English - In-person outside the clinic - Offsite'],
  [1272, 'Peer Support - Individual - English - In-person at Home Offsite'],
  [1273, 'Peer Support - Individual - Language other than English - outside the clinic Offsite'],
  [1274, 'Peer Support - Individual - Language other than English - In-person at Home Offsite'],
  // Non-peer noise that must never be considered.
  [900, 'Telehealth Individual Therapy - 30m'],
  [901, 'Peer Support - Group - English - In the clinic'],
].map(([VisitTypeID, VisitType]) => ({ VisitTypeID: String(VisitTypeID), VisitType, Duration: 60, IsBillable: true }));

let passed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        e => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }));
      return;
    }
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('\nname normalization');
test('"Last, First, Cred" and "First Last" collapse to the same key', () => {
  assert.strictEqual(M.normalizeName('Brand, Shmuel, CPS'), M.normalizeName('Shmuel Brand'));
  assert.strictEqual(M.normalizeName('Jacobowitz, Arielle'), M.normalizeName('Arielle Jacobowitz'));
});
test('different people do not collapse together', () => {
  assert.notStrictEqual(M.normalizeName('Shmuel Brand'), M.normalizeName('Shmuel Brandt Weiss'));
});
test('matchName separates exact from near, and excludes strangers', () => {
  const dir = [
    { id: '1', name: 'Segelbaum, Avrum, CPS' },
    { id: '2', name: 'Siegelbaum, Avrum' },
    { id: '3', name: 'Brand, Shmuel' },
  ];
  const r = M.matchName('Avrum Segelbaum', dir);
  assert.strictEqual(r.exact.length, 1);
  assert.strictEqual(r.exact[0].id, '1');
  assert.deepStrictEqual(r.near.map(x => x.id), ['2']);
});

console.log('\nInSync type-name parsing');
test('offsite twins are detected by name, never by id', () => {
  assert.strictEqual(M.parseInsyncTypeName(VISIT_TYPES.find(t => t.VisitTypeID === '1273').VisitType).offsite, true);
  assert.strictEqual(M.parseInsyncTypeName(VISIT_TYPES.find(t => t.VisitTypeID === '1252').VisitType).offsite, false);
});
test('language / mode / location come back off the prose', () => {
  const d = M.parseInsyncTypeName('Peer Support - Individual - Language other than English - Telehealth audio only when client is home');
  assert.deepStrictEqual(d, { language: 'NON_ENGLISH', mode: 'TELEHEALTH_AUDIO', location: 'CLIENT_HOME', offsite: false });
});
test('only Peer Support - Individual types are eligible', () => {
  assert.ok(M.isPeerIndividualType('Peer Support - Individual - English - In the clinic'));
  assert.ok(!M.isPeerIndividualType('Peer Support - Group - English - In the clinic'));
  assert.ok(!M.isPeerIndividualType('Telehealth Individual Therapy - 30m'));
});

console.log('\nencounter-type matching against the real portal export');
const [n1, n2, n3] = SAMPLE.notes;
test('English / In Person / Client Home, not offsite -> 1253', () => {
  const r = M.matchEncounterType(n1, VISIT_TYPES);
  assert.ok(r.matched, r.reason);
  assert.strictEqual(r.matched.VisitTypeID, '1253');
});
test('the portal isOffsite flag is IGNORED — routes to the base twin, not 1271', () => {
  assert.strictEqual(n2.isOffsite, true, 'fixture should still carry the flag');
  const r = M.matchEncounterType(n2, VISIT_TYPES);
  assert.ok(r.matched, r.reason);
  assert.strictEqual(r.matched.VisitTypeID, '1246');
  assert.strictEqual(M.parseInsyncTypeName(r.matched.VisitType).offsite, false);
  // The flag is still reported, so the reason for ignoring it stays visible.
  assert.strictEqual(r.dimensions.portalIsOffsite, true);
  assert.strictEqual(r.dimensions.offsite, false);
});
test('Other than English / In Person / Other Location -> base 1252, not offsite 1273', () => {
  assert.strictEqual(n3.isOffsite, true);
  const r = M.matchEncounterType(n3, VISIT_TYPES);
  assert.ok(r.matched, r.reason);
  assert.strictEqual(r.matched.VisitTypeID, '1252');
});
test('an Offsite type is still reachable as an operator override, and still demands ControlId_27', () => {
  // The machinery has to survive being switched off by default: picking an
  // Offsite type from the dropdown must switch the template shape.
  const offsiteType = VISIT_TYPES.find(t => t.VisitTypeID === '1271');
  assert.strictEqual(M.parseInsyncTypeName(offsiteType.VisitType).offsite, true);
  const { fields, warnings } = X.buildNoteFields(n2, { offsite: true });
  assert.ok('ControlId_27' in fields);
  assert.ok(warnings.some(w => /required by the Offsite template/.test(w)));
});
test('the note FORM follows the selected type, not the portal flag', () => {
  const pack = { note: { url: 'u', params: { base: 1 } }, note_offsite: { url: 'u', params: { offsite: 1 } } };
  assert.strictEqual(X.noteStepFor(false), 'note');
  assert.strictEqual(X.noteStepFor(true), 'note_offsite');
  assert.deepStrictEqual(X.templatesFor(pack, false).note.params, { base: 1 });
  assert.deepStrictEqual(X.templatesFor(pack, true).note.params, { offsite: 1 });
});
test('an Offsite type with no Offsite capture stored refuses rather than replaying the base form', () => {
  assert.throws(() => X.templatesFor({ note: { url: 'u', params: {} } }, true),
    /No Offsite note-form capture/);
});
test('an unrecognized dimension blocks instead of guessing', () => {
  const r = M.matchEncounterType({ ...n1, sessionMode: 'HOLOGRAM' }, VISIT_TYPES);
  assert.strictEqual(r.matched, null);
  assert.match(r.reason, /mode/);
});
test('an ambiguous list blocks rather than picking the first', () => {
  const dupes = [...VISIT_TYPES, { VisitTypeID: '9999', VisitType: 'Peer Support - Individual - English - In-person at Home', Duration: 60 }];
  const r = M.matchEncounterType(n1, dupes);
  assert.strictEqual(r.matched, null);
  assert.match(r.reason, /2 InSync types/);
});

console.log('\nnote field assembly');
test('every portal field lands on its control, verbatim', () => {
  const { fields } = X.buildNoteFields(n1, {});
  assert.strictEqual(fields.ControlId_3, n1.personsPresent);
  assert.strictEqual(fields.ControlId_24, n1.locationText);
  assert.strictEqual(fields.ControlId_5, n1.focusOfMeeting);
  assert.strictEqual(fields.ControlId_22, n1.activitiesSummary);
  assert.strictEqual(fields.ControlId_9, n1.patientResponse);
  assert.strictEqual(fields.ControlId_11, n1.nextPlan);
});
test('interventions map label -> InSync code', () => {
  const { fields } = X.buildNoteFields(n1, {});
  assert.strictEqual(fields.ControlId_20, '1,20,21');
});
test('an intervention InSync does not know is flagged, not silently dropped', () => {
  const { warnings } = X.buildNoteFields({ ...n1, interventions: ['Active Listening', 'Interpretive Dance'] }, {});
  assert.ok(warnings.some(w => /Interpretive Dance/.test(w)));
});
test('the offsite justification exists only on offsite types, and blocks when empty', () => {
  const base = X.buildNoteFields(n2, { offsite: false });
  assert.ok(!('ControlId_27' in base.fields));

  const off = X.buildNoteFields(n2, { offsite: true });
  assert.strictEqual(off.fields.ControlId_27, '');
  assert.ok(off.warnings.some(w => /required by the Offsite template/.test(w)));

  const filled = X.buildNoteFields(n2, { offsite: true, manual: { ControlId_27: 'Community setting per treatment plan.' } });
  assert.strictEqual(filled.fields.ControlId_27, 'Community setting per treatment plan.');
  assert.ok(!filled.warnings.some(w => /required by the Offsite template/.test(w)));
});
test('intervention details mirror the interventions, and stay overridable', () => {
  // The portal has no field for this; the convention is to repeat the selection.
  const { fields, warnings } = X.buildNoteFields(n1, {});
  assert.strictEqual(fields.ControlId_7, 'Active Listening, Social Connection, Strengths-Based Approach');
  assert.strictEqual(fields.ControlId_20, '1,20,21', 'and the codes still go to the multi-select');
  assert.ok(!warnings.some(w => /Intervention Details is empty/.test(w)));

  const manual = X.buildNoteFields(n1, { manual: { ControlId_7: 'Practised active listening throughout.' } });
  assert.strictEqual(manual.fields.ControlId_7, 'Practised active listening throughout.');
});
test('an intervention InSync does not know is left out of the mirrored text too', () => {
  const odd = { ...n1, interventions: ['Active Listening', 'Interpretive Dance'] };
  assert.strictEqual(X.interventionLabels(odd), 'Active Listening');
});

console.log('\nclock formatting');
test('portal minute-of-day becomes InSync clock strings without a timezone', () => {
  assert.deepStrictEqual(X.appointmentClock('2026-08-17', 840), {
    date: '08/17/2026', dateLoose: '8/17/2026', time: '02:00 PM',
    timeSeconds: '02:00:00 PM', dateTime: '08/17/2026 02:00 PM',
  });
  assert.strictEqual(X.appointmentClock('2026-01-05', 0).time, '12:00 AM');
  assert.strictEqual(X.appointmentClock('2026-01-05', 720).time, '12:00 PM');
});

console.log('\npayload helpers');
test('setFields reaches every nesting depth of one logical field', () => {
  const p = { 'obj[VisitID]': 'a', VisitID: 'b', 'obj[Inner][VisitID]': 'c', VisitIDList: 'keep' };
  assert.strictEqual(P.setFields(p, '77', 'VisitID'), 3);
  assert.strictEqual(p.VisitIDList, 'keep');
});
test('a boolean in an id-named field is never taken for an id', () => {
  assert.strictEqual(P.responseId({ EncounterId: true, nested: { eid: '4455' } }, '', 'EncounterId', 'eid'), '4455');
});
test('DataSave=false surfaces InSync\'s own refusal reason', () => {
  assert.throws(() => P.appointmentResult({ DataSave: false, Alert: { WarningMessage: 'Overlapping visit' } }),
    /Overlapping visit/);
});
test('a "successful" appointment with no VisitID is still a failure', () => {
  assert.throws(() => P.appointmentResult({ DataSave: true, BookAppoint: {} }), /no numeric VisitID/);
});

console.log('\nappointment-exists rule');

// Shapes taken from real calendars, not invented.
const appt = o => ({
  visitId: '1', startMinutes: 540, cancelled: false, statusId: 3, statusText: 'Pending',
  encounterId: '', encounterStatus: '', chargeStatus: 0, closedBy: null,
  appText: 'Heilpern, Chaya (Pending, Peer Support)', participants: [{ PatientId: 626427 }], ...o,
});
const FOR_CHAYA = { patientId: '626427', startMinutes: 540, clientName: 'Chaya Heilpern' };

test('booked but untouched -> reuse', () => {
  const r = IP.findExistingAppointment([appt()], FOR_CHAYA);
  assert.strictEqual(r.disposition, 'reusable');
  assert.strictEqual(r.appointment.visitId, '1');
});
test('a cancelled appointment is invisible', () => {
  const r = IP.findExistingAppointment([appt({ cancelled: true, statusId: 4 })], FOR_CHAYA);
  assert.strictEqual(r.appointment, null);
  assert.strictEqual(r.disposition, 'none');
});
test('the right patient at the wrong time is not a match', () => {
  assert.strictEqual(IP.findExistingAppointment([appt()], { ...FOR_CHAYA, startMinutes: 600 }).appointment, null);
});
test('AppText name matching covers calendars with no Participants', () => {
  const r = IP.findExistingAppointment(
    [appt({ visitId: '9', startMinutes: 1140, appText: 'Kahana, Yakov (Pending, Peer Support)', participants: [] })],
    { patientId: '999', startMinutes: 1140, clientName: 'Yakov Kahana' });
  assert.strictEqual(r.appointment.visitId, '9');
});

test('a clearly closed encounter -> already_closed, never reused', () => {
  // The real shape: status 1 "Check In", not 4, so the old rule reused it.
  const r = IP.findExistingAppointment([appt({
    visitId: '642215', statusId: 1, statusText: 'Check In',
    encounterId: '1010479', encounterStatus: '3', chargeStatus: 1,
    closedBy: { name: 'Orelowitz, Chaim, LCSW', on: '08/18/2026', text: '' },
  })], FOR_CHAYA);
  assert.strictEqual(r.disposition, 'already_closed');
});
test('closed-by alone is enough, without status/charge', () => {
  const r = IP.findExistingAppointment([appt({
    encounterId: '1010479', encounterStatus: '', chargeStatus: 0,
    closedBy: { name: 'Someone', on: '08/18/2026', text: '' },
  })], FOR_CHAYA);
  assert.strictEqual(r.disposition, 'already_closed');
});
test('status 3 + charge 1 is enough, without a closed-by name', () => {
  const r = IP.findExistingAppointment([appt({
    encounterId: '1010479', encounterStatus: '3', chargeStatus: 1, closedBy: null,
  })], FOR_CHAYA);
  assert.strictEqual(r.disposition, 'already_closed');
});
test('an encounter that is NOT clearly closed -> needs_review, not duplicate', () => {
  // An encounter id can exist while the encounter is still open. That is its own
  // case: neither safe to reuse nor safe to call already-entered.
  const r = IP.findExistingAppointment([appt({
    encounterId: '1011943', encounterStatus: '1', chargeStatus: 0, closedBy: null,
  })], FOR_CHAYA);
  assert.strictEqual(r.disposition, 'needs_review');
  assert.notStrictEqual(r.disposition, 'already_closed');
});
test('status 3 without a charge is still only needs_review', () => {
  const r = IP.findExistingAppointment([appt({
    encounterId: '1011943', encounterStatus: '3', chargeStatus: 0, closedBy: null,
  })], FOR_CHAYA);
  assert.strictEqual(r.disposition, 'needs_review');
});

test('EncounterClosedByName HTML is parsed into a name and a date', () => {
  const c = IP.parseClosedBy(
    "<div class='p-5'><b>Closed By:</b> Orelowitz, Chaim, LCSW On 08/18/2026 12:38 PM</div>");
  assert.strictEqual(c.name, 'Orelowitz, Chaim, LCSW');
  assert.strictEqual(c.on, '08/18/2026');
  assert.strictEqual(IP.parseClosedBy(''), null);
  assert.strictEqual(IP.parseClosedBy(null), null);
});

console.log('\ncapture scrubbing (regressions found against the real captures)');
test('the DynamicHTML scrub survives entity-escaped markup', () => {
  // InSync stores the rendered controls escaped. Scrubbing the raw string
  // silently matched nothing and left a whole note's answers in place.
  const escaped = '&lt;label id="ControlId_3"&gt;PRIOR ANSWER&lt;/label&gt;';
  const unesc = X.unescHtml(escaped);
  assert.ok(unesc.includes('<label id="ControlId_3">'), 'unescape must expose the element');
  const patched = X.patchDynamicHtml(unesc, { ControlId_3: 'new value' }, '1');
  assert.ok(!patched.includes('PRIOR ANSWER'));
  assert.ok(patched.includes('new value'));
});
test('the acting peer\'s name replaces the captured clinician\'s in display fields', () => {
  // ProviderID mappings do not touch these, so a booking made as one peer used
  // to carry the captured clinician's name.
  const templates = { note: { url: 'u', params: {} }, appointment: { url: 'u', params: {
    'objBookAppointmentss[Provider]': 'Captured, Clinician (P)',
    'objBookAppointmentss[ResourceId]': '2317',
    'SEEncounterDetails.SEProviderName': 'Captured, Clinician, LCSW',
  } } };
  const out = X.preparePayloads({
    templates,
    ctx: {
      patientId: '1', patientName: 'P', providerId: '2401', providerName: 'Brand, Shmuel',
      visitTypeId: '1253', visitTypeName: 'Peer Support - Individual - English - In-person at Home',
      sessionDate: '2026-08-17', sessionStartMinutes: 840, duration: 180, noteFields: {},
    },
    visitId: '0', encounterId: '0', signingPin: '',
  });
  const p = out.appointment.params;
  assert.strictEqual(p['objBookAppointmentss[Provider]'], 'Brand, Shmuel');
  assert.strictEqual(p['SEEncounterDetails.SEProviderName'], 'Brand, Shmuel');
  assert.strictEqual(p['objBookAppointmentss[ResourceId]'], '2401');
  assert.ok(!JSON.stringify(p).includes('Captured, Clinician'));
});

console.log('\nper-type billing (the whole mapping, at every occurrence)');

// A stand-in for the stored pack, carrying type 1273's billing in all eighteen
// places the real capture does -- including the underscore variant that a
// dot-segment suffix rule structurally cannot reach.
function packWith1273() {
  return {
    appointment: { url: 'u', params: {
      'objCpt[0][EncounterTypeCPTMapID]': '418', 'objCpt[0][CPT_Code]': 'H0038',
      'objCpt[0][CPT_Description]': 'Self-help/peer svc per 15min',
      'objCpt[0][M1]': '338', 'objCpt[0][M2]': '', 'objCpt[0][M3]': '', 'objCpt[0][M4]': '',
      'objCpt[0][Units]': '1', 'objCpt[0][CPTMapTypeID]': '1',
      'objBookAppointmentss[POSCode]': '99',
      'objBookAppointmentss[POSCodeDescription]': '99 - Other Place of Service',
      'objBookAppointmentss[ProcedureCodeDescription]': 'H0038 - Self-help (Modifiers: U4; Units: 1.00) |',
      'objBookAppointmentss[ProgramManagementDetailID]': '6519',
      'objBookAppointmentss[PMAlertData][ProgramManagementDetailID]': '6519',
      'objBookAppointmentss[VisitTypeID]': '1273',
    } },
    encounter: { url: 'u', params: {
      'SEEncounterDetails.SECPTCode': 'H0038#*#&*&418',
      'SEEncounterDetails_SECPTCode': 'H0038#*#&*&418',
      'SEEncounterDetails.SECPTModifiers': 'H0038#*#&*&418,338,,,,1.00,&*%^1,&*%^1',
      'SEEncounterDetails.SECPTDescription': 'H0038#*#&*&418 -  Self-help/peer svc per 15min',
      'SEEncounterDetails.SEPOSCode': '99',
      'SEEncounterDetails.SEPOSDescription': 'Other Place of Service',
      'SEEncounterDetails.SEEncounterTypeID': '1273',
      'SEEncounterDetails.OldSEEncounterTypeID': '1273',
      'SEEncounterDetails.ProgramManagementDetailID': '6519',
      'SEEncounterDetails.ProgramManagementID': '18',
    } },
    close: { url: 'u', params: {
      'SaveEndEncounter[EncounterTypeID]': '1273',
      'SaveEndEncounter[ProgramManagementDetailID]': '6519',
    } },
    note: { url: 'u', params: { 'data[ControlId_3]': '', 'data[ControlId_24]': '', 'data[ControlId_5]': '',
      'data[ControlId_22]': '', 'data[ControlId_7]': '', 'data[ControlId_20]': '', 'data[ControlId_9]': '',
      'data[ControlId_11]': '', 'data[ControlId_12]': '', 'data[ControlId_13]': '', 'data[TemplateId]': '973' } },
  };
}

// What InSync actually returns for 1253 (verified live).
const BILLING_1253 = {
  cptMapId: '401', cptCode: 'H0038', cptDescription: 'Self-help/peer svc per 15min',
  m1: '', m2: '', m3: '', m4: '', units: '1.00', cptMapTypeId: '1',
  posCode: '12', posId: '2', posDescription: '12 - Home',
  programManagementDetailId: '5996', programManagementId: '30',
};

function prepared1253() {
  const { fields } = X.buildNoteFields(n1, {});
  return X.preparePayloads({
    templates: packWith1273(),
    capturedVisitTypeId: '1273',
    ctx: {
      billing: BILLING_1253,
      patientId: '622616', patientName: 'Nissim Gadayev',
      providerId: '2620', providerName: 'Brand, Shmuel',
      visitTypeId: '1253',
      visitTypeName: 'Peer Support - Individual - English - In-person at Home',
      sessionDate: n1.sessionDate, sessionStartMinutes: n1.sessionStartMinutes,
      duration: n1.durationMinutes, noteFields: fields,
    },
    visitId: '0', encounterId: '99', signingPin: '',
  });
}

test('no value belonging to the captured type survives anywhere', () => {
  const blob = JSON.stringify(prepared1253());
  for (const bad of ['418', '338', '6519', '1273', '99 - Other Place of Service']) {
    assert.ok(!blob.includes(bad), `${bad} (the captured type's) survived into the payload`);
  }
});

test('the appointment CPT grid carries 1253 mapping, not 1273', () => {
  const p = prepared1253().appointment.params;
  assert.strictEqual(p['objCpt[0][EncounterTypeCPTMapID]'], '401');
  assert.strictEqual(p['objCpt[0][CPT_Code]'], 'H0038');
  assert.strictEqual(p['objCpt[0][M1]'], '', 'English at-home must carry NO modifier');
  assert.strictEqual(p['objCpt[0][Units]'], '1.00');
  assert.strictEqual(p['objCpt[0][CPTMapTypeID]'], '1');
  assert.strictEqual(p['objBookAppointmentss[POSCode]'], '12');
  assert.strictEqual(p['objBookAppointmentss[POSCodeDescription]'], '12 - Home');
  assert.ok(!/Modifiers/.test(p['objBookAppointmentss[ProcedureCodeDescription]']));
  assert.strictEqual(p['objBookAppointmentss[VisitTypeID]'], '1253');
});

test('the encounter composites are rebuilt, including the underscore variant', () => {
  const p = prepared1253().encounter.params;
  assert.strictEqual(p['SEEncounterDetails.SECPTCode'], 'H0038#*#&*&401');
  assert.strictEqual(p['SEEncounterDetails_SECPTCode'], 'H0038#*#&*&401',
    'the underscore key is one dot-segment; a suffix rule cannot reach it');
  assert.strictEqual(p['SEEncounterDetails.SECPTModifiers'], 'H0038#*#&*&401,,,,,1.00,&*%^1,&*%^1');
  assert.strictEqual(p['SEEncounterDetails.SECPTDescription'], 'H0038#*#&*&401 -  Self-help/peer svc per 15min');
  assert.strictEqual(p['SEEncounterDetails.SEPOSCode'], '12');
  assert.strictEqual(p['SEEncounterDetails.SEPOSDescription'], 'Home');
  assert.strictEqual(p['SEEncounterDetails.SEEncounterTypeID'], '1253');
  assert.strictEqual(p['SEEncounterDetails.OldSEEncounterTypeID'], '1253');
});

test("the patient's own program replaces the captured one, everywhere", () => {
  const r = prepared1253();
  assert.strictEqual(r.appointment.params['objBookAppointmentss[ProgramManagementDetailID]'], '5996');
  assert.strictEqual(r.appointment.params['objBookAppointmentss[PMAlertData][ProgramManagementDetailID]'], '5996');
  assert.strictEqual(r.encounter.params['SEEncounterDetails.ProgramManagementDetailID'], '5996');
  assert.strictEqual(r.encounter.params['SEEncounterDetails.ProgramManagementID'], '30');
  assert.strictEqual(r.close.params['SaveEndEncounter[ProgramManagementDetailID]'], '5996');
});

test('the base note form is used, with no offsite justification field', () => {
  const p = prepared1253().note.params;
  assert.strictEqual(p['data[TemplateId]'], '973');
  assert.ok(!Object.keys(p).some(k => /ControlId_27/.test(k)));
  assert.strictEqual(p['data[ControlId_12]'], 'Nissim Gadayev');
  assert.strictEqual(p['data[ControlId_13]'], 'Brand, Shmuel');
});

test('a half-written billing pass is refused rather than sent', () => {
  // Simulate a field the writer missed: assertBilling must catch the mismatch.
  const templates = packWith1273();
  templates.encounter.params['SEEncounterDetails.SECPTCodeX'] = 'unused';
  const bad = { ...BILLING_1253, cptMapId: '' };
  const { fields } = X.buildNoteFields(n1, {});
  assert.throws(() => X.preparePayloads({
    templates, capturedVisitTypeId: '1273',
    ctx: { billing: bad, patientId: '1', patientName: 'p', providerId: '2', providerName: 'q',
      visitTypeId: '1253', visitTypeName: 'Peer Support - Individual - English - In-person at Home',
      sessionDate: n1.sessionDate, sessionStartMinutes: n1.sessionStartMinutes,
      duration: 180, noteFields: fields },
    visitId: '0', encounterId: '0', signingPin: '',
  }), /billing does not match/);
});

console.log('\nOffsite is switched off');
test('executing an Offsite type is refused', async () => {
  let threw = null;
  try {
    await X.executeNote({
      templates: packWith1273(), dryRun: true, log: async () => {},
      ctx: { offsite: true, visitTypeId: '1271',
        visitTypeName: 'Peer Support - Individual - English - In-person outside the clinic - Offsite' },
    });
  } catch (e) { threw = e; }
  assert.ok(threw && /Offsite encounter types are not enabled/.test(threw.message));
});

console.log('\npatient search name forms');
test('portal "First Last" becomes InSync "Last, First", surname as fallback', () => {
  assert.deepStrictEqual(M.splitName('Yitzchok Hornstein'), { first: 'Yitzchok', last: 'Hornstein' });
  assert.deepStrictEqual(M.patientQueries('Yitzchok Hornstein'), ['Hornstein, Yitzchok', 'Hornstein']);
  // middle names ride with the first name
  assert.deepStrictEqual(M.patientQueries('Chana Rochel Englard'), ['Englard, Chana Rochel', 'Englard']);
  // single-token and hyphenated surnames stay intact
  assert.deepStrictEqual(M.patientQueries('Madonna'), ['Madonna']);
  assert.strictEqual(M.splitName('Anne-Marie Dyke').last, 'Dyke');
  assert.deepStrictEqual(M.patientQueries(''), []);
});

console.log('\ncredential crypto');
test('round-trips, and two encryptions of one secret differ', () => {
  const a = C.encrypt('hunter2'), b = C.encrypt('hunter2');
  assert.notStrictEqual(a, b);
  assert.strictEqual(C.decrypt(a), 'hunter2');
  assert.strictEqual(C.decrypt(b), 'hunter2');
});
test('a tampered ciphertext throws rather than returning garbage', () => {
  const blob = C.encrypt('1111').split('.');
  blob[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => C.decrypt(blob.join('.')));
});
test('the wrong key cannot read it', () => {
  const blob = C.encrypt('secret');
  const saved = process.env.PORTAL_CRED_KEY;
  delete require.cache[require.resolve('../utils/portalCrypto')];
  process.env.PORTAL_CRED_KEY = require('crypto').randomBytes(32).toString('base64');
  const C2 = require('../utils/portalCrypto');
  assert.throws(() => C2.decrypt(blob));
  process.env.PORTAL_CRED_KEY = saved;
  delete require.cache[require.resolve('../utils/portalCrypto')];
});
test('scrub keeps a secret out of a message that would be logged', () => {
  assert.strictEqual(C.scrub('login failed for pw hunter2', 'hunter2'), 'login failed for pw «redacted»');
});

console.log('\nnote payload assembly (real capture pack shape)');
test('answer fields are blanked before the current note is written in', () => {
  const templates = {
    note: {
      url: 'https://x/ConfigurePracticeTemplate/SaveDynamicTemplateDetails',
      params: {
        // A template still carrying a previous patient's answers.
        'data[ControlId_3]': 'PRIOR PATIENT persons',
        'data[ControlId_24]': 'PRIOR PATIENT location',
        'data[ControlId_5]': 'PRIOR', 'data[ControlId_22]': 'PRIOR',
        'data[ControlId_7]': 'PRIOR', 'data[ControlId_20]': '9',
        'data[ControlId_9]': 'PRIOR', 'data[ControlId_11]': 'PRIOR',
        'data[ControlId_12]': 'PRIOR NAME', 'data[ControlId_13]': 'PRIOR PROVIDER',
        'data[PatientId]': '626427',
        'data[DynamicHTML]': '&lt;label id="ControlId_3"&gt;PRIOR PATIENT persons&lt;/label&gt;',
      },
    },
  };
  const { fields } = X.buildNoteFields(n1, {});
  const out = X.preparePayloads({
    templates,
    ctx: {
      patientId: '700001', patientName: 'Nissim Gadayev',
      providerId: '2401', providerName: 'Brand, Shmuel',
      visitTypeId: '1253', visitTypeName: 'Peer Support - Individual - English - In-person at Home',
      sessionDate: n1.sessionDate, sessionStartMinutes: n1.sessionStartMinutes,
      duration: n1.durationMinutes, noteFields: fields,
    },
    visitId: '0', encounterId: '55', signingPin: '',
  });
  const p = out.note.params;
  const blob = JSON.stringify(p);
  assert.ok(!blob.includes('PRIOR'), 'a prior patient\'s text survived into the new note');
  assert.ok(!blob.includes('626427'), 'the prior patient id survived');
  assert.strictEqual(p['data[ControlId_3]'], n1.personsPresent);
  assert.strictEqual(p['data[ControlId_12]'], 'Nissim Gadayev');
  assert.ok(X.unescHtml(p['data[DynamicHTML]']).includes(n1.personsPresent));
});
test('a template missing a control the type needs refuses rather than silently dropping it', () => {
  const templates = { note: { url: 'https://x/note', params: { 'data[ControlId_3]': '' } } };
  const { fields } = X.buildNoteFields(n2, { offsite: true, manual: { ControlId_27: 'because' } });
  assert.throws(() => X.preparePayloads({
    templates,
    ctx: {
      patientId: '1', patientName: 'x', providerId: '2', providerName: 'y',
      visitTypeId: '1271', visitTypeName: 'Peer Support - Individual - English - In-person outside the clinic - Offsite',
      sessionDate: n2.sessionDate, sessionStartMinutes: n2.sessionStartMinutes,
      duration: 120, noteFields: fields,
    },
    visitId: '0', encounterId: '0', signingPin: '',
  }), /has no ControlId_/);
});
test('the interventions multi-select is patched into the rendered HTML as labels + codes', () => {
  const html = '<div data-currentcontrolid="ControlId_20"><span></span><div class="elem-control has-no-label">OLD</div><img src="x">';
  const out = X.patchDynamicHtml(html, { ControlId_20: '1,20' }, '77');
  assert.ok(out.includes('Active Listening, Social Connection'));
  assert.ok(/hdnFieldVal_20[^>]*value="1,20"/.test(out));
  assert.ok(!out.includes('OLD'));
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures above)' : ''}\n`);
});
