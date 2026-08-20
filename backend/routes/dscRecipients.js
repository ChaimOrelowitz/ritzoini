// Private recipient feed for the "Message DSC" Apple Shortcut.
//
// The server NEVER sends a message. It answers one question — "who is on the
// list right now" — and the iPhone opens a separate native Messages
// conversation per recipient. That keeps the whole thing off Twilio, off any
// A2P registration, and inside iMessage/SMS from the supervisor's own number.
//
// Recipients come from the same fetchActiveCaseload() the CardDAV book uses, so
// the phone's "DSC Peers" address book and this list can never disagree.

const express = require('express');
const router  = express.Router();

const { fetchActiveCaseload, cohortsOf } = require('../utils/psCaseload');
const { dedupeByPhone } = require('../utils/contactDirectory');
const {
  noStore, requireHttps, rateLimiter, requireShortcutAuth,
} = require('../utils/privateAccess');

const ALL = 'all';
const cohortKey   = c => `cohort:${c}`;
const cohortLabel = c => `Cohort ${c}`;

// The sendable list, resolved once per request. dedupeByPhone drops anyone with
// no usable mobile and collapses two peers who share a handset — so the counts
// the menu shows are the same counts the send loop will iterate. Deriving the
// menu from an un-deduplicated list would promise more messages than it sends.
//
// CardDAV deliberately does NOT do this: two people sharing a phone are still
// two contacts.
const sendableCaseload = async () => dedupeByPhone(await fetchActiveCaseload());

router.use(requireHttps);
router.use(noStore);
// A Shortcut run makes two calls. Anything beyond this is not a phone.
router.use(rateLimiter({ name: 'dsc', windowMs: 5 * 60000, max: 60 }));
router.use(requireShortcutAuth);

// Only the fields the Shortcut actually uses. Nothing else about a peer needs
// to travel to a phone that is about to put it in a text field.
const toRecipient = c => ({
  id:     c.uid,
  name:   c.display,
  phone:  c.phone,
  cohort: c.cohort,
});

// Builds the audience list from the live caseload so a cohort that empties out
// disappears from the menu instead of offering a zero-recipient send.
function audiencesFor(contacts) {
  return [
    { key: ALL, label: 'All active DSC peers', count: contacts.length },
    ...cohortsOf(contacts).map(c => ({
      key:   cohortKey(c),
      label: cohortLabel(c),
      count: contacts.filter(x => x.cohort === c).length,
    })),
  ].map(a => ({ ...a, menu_label: `${a.label} (${a.count})` }));
}

// Shortcuts' "Choose from List" hands back the chosen STRING, not an index, so
// the shortcut would otherwise need a loop to map a menu line back to its key.
// Emitting the menu lines and a label→key dictionary alongside turns that into
// one "Get Dictionary Value" with a variable key.
function menuFor(audiences) {
  return {
    labels:        audiences.map(a => a.menu_label),
    keys_by_label: Object.fromEntries(audiences.map(a => [a.menu_label, a.key])),
  };
}

// Exact match against the cohorts actually present — an arbitrary query
// fragment can never reach a filter.
//
// Nothing is trimmed or case-folded. "cohort:A " once resolved to cohort A,
// which is lenient matching dressed up as exact matching: the key the Shortcut
// sends must be one the audiences endpoint published, byte for byte, or the
// send is refused outright.
function resolveAudience(raw, contacts) {
  const key = String(raw ?? ALL);
  if (key === ALL) return { key, label: 'All active DSC peers', contacts };

  const m = key.match(/^cohort:(.+)$/);
  if (m) {
    const wanted = m[1];
    if (cohortsOf(contacts).includes(wanted)) {
      return {
        key:      cohortKey(wanted),
        label:    cohortLabel(wanted),
        contacts: contacts.filter(c => c.cohort === wanted),
      };
    }
  }
  return null;
}

// GET /api/dsc/audiences — menu + live counts for the Shortcut's "Choose from List"
router.get('/audiences', async (req, res) => {
  try {
    const contacts = await sendableCaseload();
    const audiences = audiencesFor(contacts);

    console.log(`[dsc] audiences audiences=${audiences.length} total=${contacts.length}`);
    res.json({
      generated_at: new Date().toISOString(),
      rule: 'open caseload period',
      audiences,
      ...menuFor(audiences),
    });
  } catch (err) {
    console.error(`[dsc] audiences failed: ${err.message}`);
    res.status(500).json({ error: 'Could not load audiences' });
  }
});

// GET /api/dsc/recipients?audience=all | cohort:A
router.get('/recipients', async (req, res) => {
  try {
    const audience = req.query.audience;
    if (audience !== undefined && typeof audience !== 'string') {
      return res.status(400).json({ error: 'audience must be a single value' });
    }

    const contacts = await sendableCaseload();
    const resolved = resolveAudience(audience, contacts);

    if (!resolved) {
      console.warn('[dsc] recipients rejected: unknown audience');
      return res.status(400).json({
        error: 'Unknown audience',
        valid: audiencesFor(contacts).map(a => a.key),
      });
    }

    const recipients = resolved.contacts.map(toRecipient);

    console.log(`[dsc] recipients audience=${resolved.key} count=${recipients.length}`);
    res.json({
      generated_at: new Date().toISOString(),
      audience:     resolved.key,
      audience_label: resolved.label,
      count:        recipients.length,
      recipients,
    });
  } catch (err) {
    console.error(`[dsc] recipients failed: ${err.message}`);
    res.status(500).json({ error: 'Could not load recipients' });
  }
});

module.exports = router;
module.exports.audiencesFor  = audiencesFor;
module.exports.menuFor       = menuFor;
module.exports.resolveAudience = resolveAudience;
module.exports.toRecipient   = toRecipient;
