const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateSessionNote(groupDescription, sessionNumber, totalSessions, previousNotes = []) {
  const prevContext = previousNotes.length > 0
    ? `\n\nPrevious session notes for context and continuity:\n${previousNotes.map((note, i) => `--- Week ${i + 1} ---\n${note}`).join('\n\n')}`
    : '';

  const stageHint =
    sessionNumber === 1 ? 'This is the first session — focus on orientation, introductions, and building safety.' :
    sessionNumber === totalSessions ? 'This is the final session — focus on closure, celebration of growth, and saying goodbye.' :
    sessionNumber >= totalSessions - 2 ? 'The group is approaching its end — begin reflecting on growth and preparing for closure.' :
    sessionNumber <= 3 ? 'The group is in its early stage — focus on trust-building, getting comfortable, and establishing norms.' :
    'The group is in its working phase — focus on the therapeutic themes appropriate to this group.';

  const prompt = `You are writing clinical SOAP notes for a therapeutic group in an Orthodox Jewish community. Groups are always gender-separated.

Group description: ${groupDescription}
Session: ${sessionNumber} of ${totalSessions}
${stageHint}${prevContext}

Write the complete SOAP note for Session ${sessionNumber}. Requirements:
- Minimum 450 words total
- SOAP format: Subjective, Objective, Assessment, Plan sections
- Developmentally and therapeutically appropriate for this group
- Natural progression and continuity from prior sessions
- Appropriate for an Orthodox Jewish community context

Then write exactly 6 Client Participation options labeled "Client Participation:" followed by 6 numbered options.
Each option must:
- Be 1-2 sentences starting with "The client..."
- Be contextually specific to this session's themes
- Cover a range of participation styles

No extra headers or sections beyond SOAP + Client Participation.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

module.exports = { generateSessionNote };
