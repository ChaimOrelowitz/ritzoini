// Verification harness for PS CO-SIGN REVIEW V2 (plan Step 18, section G).
// Stubs the Anthropic SDK so no real request is made, and asserts that malformed
// or schema-invalid model output becomes AI_REVIEW_ERROR — never a silent pass,
// and never an automatic second request.
require('dotenv').config();

let requests = 0;
let nextBody = '';
const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = {
  id: sdkPath, filename: sdkPath, loaded: true, children: [], paths: [],
  exports: class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async () => {
          requests++;
          return { content: [{ type: 'text', text: nextBody }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      };
    }
  },
};

const { InsyncCoSignEngine } = require('../utils/peerSupervisorEngine');
const { judgeNote } = require('../utils/psIngest');

const NOTE = {
  eid: 'TEST-1', patientName: 'Test, Client', visitDate: '07/28/2026',
  encounterType: 'Peer Support - Individual - In-person outside the clinic',
  totalTime: '1 hr 0 min', durationMinutes: 60, age: 30,
  startMins: 600, endMins: 660, startTimeStr: '07/28/2026 10:00 AM', endTimeStr: '07/28/2026 11:00 AM',
  fullNoteText: 'Focus of the meeting: ' + 'x'.repeat(200)
    + ' What activities took place, and for how long? ' + 'y'.repeat(200)
    + ' Peer Support Interventions: ' + 'z'.repeat(200)
    + " Patient's Response/Content: " + 'w'.repeat(200)
    + ' Plan: ' + 'v'.repeat(200) + ' Diagnosis F41.1 - Generalized anxiety disorder Treatment Plan Problem: Anxiety (Last Review Date: 01/01/2026)',
};
NOTE.noteText = NOTE.fullNoteText;

const VALID = JSON.stringify({
  review_version: 'ps_review_v2', decision: 'PASS', confidence: 'HIGH',
  offsite_review: { applicable: true, service_type: 'OFFSITE', status: 'PASS', rationale_status: 'PRESENT_SUFFICIENT', location_status: 'SUFFICIENT', goal_connection_status: 'SUFFICIENT', explanation: 'ok' },
  narrative_goal_alignment: { status: 'ALIGNED', explanation: 'ok' },
  diagnosis_problem_alignment: { status: 'ALIGNED', explanation: 'ok' },
  intervention_response_review: { intervention_status: 'SUFFICIENT', response_status: 'SUFFICIENT', explanation: 'ok' },
  issues: [], reopen_message_to_peer: '', supervisor_message: '', review_summary: 'Aligned.',
});

const CASES = [
  ['plain prose, not JSON',            'The note looks fine to me.'],
  ['truncated JSON',                   '{"decision": "PASS", "confidence": "HI'],
  ['valid JSON, invalid decision',     JSON.stringify({ ...JSON.parse(VALID), decision: 'LOOKS_GOOD' })],
  ['valid JSON, issues not an array',  JSON.stringify({ ...JSON.parse(VALID), issues: 'none' })],
  ['valid JSON, nested object missing', JSON.stringify({ ...JSON.parse(VALID), offsite_review: undefined })],
  ['empty response',                   ''],
  ['markdown-fenced VALID review',     '```json\n' + VALID + '\n```'],
  ['bare VALID review',                VALID],
];

(async () => {
  const engine = new InsyncCoSignEngine({ anthropicKey: 'stub-key' });
  console.log('=== G. MALFORMED / INVALID AI OUTPUT ===\n');
  let pass = 0;
  for (const [name, body] of CASES) {
    nextBody = body;
    const before = requests;
    const review = await engine.aiReview(NOTE);
    const calls = requests - before;
    const shouldError = !name.includes('VALID review');
    const isError = review.decision === 'AI_REVIEW_ERROR';
    const ok = isError === shouldError && calls === 1;
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} decision=${String(review.decision).padEnd(17)} requests=${calls} (1 = no auto-retry)`);
    if (isError && !review.raw_response && body) console.log('        WARN: raw_response not preserved');
  }

  // The queue-visibility consequence: an AI_REVIEW_ERROR must flag the note.
  nextBody = 'not json';
  const judged = await judgeNote(engine, NOTE, [], { priorReview: null });
  const verdictOk = judged.verdict === 'flagged';
  const notPass = judged.flags.review.decision === 'AI_REVIEW_ERROR';
  const chip = judged.flags.coherence;
  console.log(`\n  ${verdictOk && notPass ? 'PASS' : 'FAIL'}  AI_REVIEW_ERROR keeps the note flagged (verdict=${judged.verdict}, decision=${judged.flags.review.decision})`);
  console.log(`         visible chip text: "${chip}"`);

  // A stored AI_REVIEW_ERROR must NOT be reused as if it were a good review.
  const errored = { fingerprint: engine.fingerprintFor(NOTE), decision: 'AI_REVIEW_ERROR' };
  const before = requests;
  const retried = await judgeNote(engine, NOTE, [], { priorReview: errored });
  console.log(`  ${requests - before === 1 ? 'PASS' : 'FAIL'}  a stored AI_REVIEW_ERROR is re-reviewed on the next explicit run, not reused (requests=${requests - before})`);

  console.log(`\n  ${pass}/${CASES.length} output cases behaved correctly`);
  console.log(`  Total stub requests across the whole script: ${requests}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
