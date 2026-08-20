// Portal POC — pure matching logic (no I/O, no InSync calls).
//
// Two jobs: turn a person's name into something comparable across two systems
// that spell names differently, and pick the InSync encounter type whose name
// expresses the same dimensions as the portal note.
//
// Nothing here is hardcoded to a VisitTypeID. The caller passes the LIVE
// GetVisitTypes list every run, so a new encounter type appearing in InSync
// resolves without a code change.

// --- names -----------------------------------------------------------------

const CREDENTIALS = /\b(cps|cprs|cpss|cpp|ma|ms|msw|lmsw|lcsw|lmhc|lpc|phd|psyd|md|do|rn|np|pa|bs|ba|casac|chw)\b\.?/gi;

// "Brand, Shmuel, CPS" and "Shmuel Brand" both become "brand shmuel".
function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw)
    .replace(/’/g, "'")
    .replace(/[.]/g, ' ')
    .replace(CREDENTIALS, ' ')
    .replace(/[^a-z\s,'-]/gi, ' ')
    .trim();

  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  let tokens;
  if (parts.length >= 2) {
    // "Last, First[, Credential]" — the credential parts were mostly stripped
    // above, but drop any single-token trailing part just in case.
    tokens = [parts[0], parts[1]].join(' ').split(/\s+/);
  } else {
    // "First Last" → reorder to last-first so both shapes compare equal.
    const t = s.split(/\s+/).filter(Boolean);
    tokens = t.length >= 2 ? [t[t.length - 1], ...t.slice(0, -1)] : t;
  }

  return tokens.map(t => t.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean).join(' ');
}

// Cheap edit distance, capped — enough to tolerate the spelling drift between
// the portal and InSync ("Segelbaum" / "Siegelbaum") without matching strangers.
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Returns { exact: [...], near: [...] } over candidates shaped { id, name }.
// The caller decides what to do — a near match is a suggestion for a human to
// confirm, never an automatic binding.
function matchName(target, candidates) {
  const t = normalizeName(target);
  const exact = [];
  const near = [];
  for (const c of candidates) {
    const n = normalizeName(c.name);
    if (!n) continue;
    if (n === t) { exact.push(c); continue; }
    const d = editDistance(n, t);
    if (d <= 2) near.push({ ...c, distance: d });
  }
  near.sort((a, b) => a.distance - b.distance);
  return { exact, near };
}

// --- encounter-type dimensions ---------------------------------------------

const LANG = { ENGLISH: 'ENGLISH', NON_ENGLISH: 'NON_ENGLISH' };
const MODE = { IN_PERSON: 'IN_PERSON', TELEHEALTH_VIDEO: 'TELEHEALTH_VIDEO', TELEHEALTH_AUDIO: 'TELEHEALTH_AUDIO' };
const LOC  = { IN_CLINIC: 'IN_CLINIC', CLIENT_HOME: 'CLIENT_HOME', OTHER_LOCATION: 'OTHER_LOCATION' };

// Is this one of the encounter types this system is allowed to touch at all?
function isPeerIndividualType(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('peer support') && n.includes('individual');
}

// Read the three dimensions (plus offsite) back out of an InSync type NAME.
// InSync encodes them in prose, so this is prose parsing — but it is parsing a
// controlled vocabulary that has been stable across every capture.
function parseInsyncTypeName(name) {
  const n = String(name || '').toLowerCase();

  const language = /language other than english|other than english|non-?english/.test(n)
    ? LANG.NON_ENGLISH
    : /english/.test(n) ? LANG.ENGLISH : null;

  // Telehealth types always say so; everything else in this family is
  // in-person. That is not a shortcut — InSync's offsite twin names are
  // inconsistent, and 1273 ("…Language other than English - outside the clinic
  // Offsite") omits "In-person" while its base twin 1252 includes it. Requiring
  // the literal word would leave that type permanently unmatchable.
  let mode = null;
  if (/telehealth/.test(n)) {
    mode = /audio only/.test(n) ? MODE.TELEHEALTH_AUDIO
         : /video/.test(n)      ? MODE.TELEHEALTH_VIDEO
         : null;
  } else {
    mode = MODE.IN_PERSON;
  }

  let location = null;
  if (/in the clinic/.test(n)) location = LOC.IN_CLINIC;
  else if (/at home|client is home/.test(n)) location = LOC.CLIENT_HOME;
  else if (/outside the clinic|not home/.test(n)) location = LOC.OTHER_LOCATION;

  return {
    language,
    mode,
    location,
    // The Offsite twin carries a different note template — one extra field,
    // ControlId_27. Detecting it from the NAME is what keeps the template shape
    // driven by the selected type rather than by an assumption.
    offsite: /\boffsite\b/.test(n),
  };
}

// Read the same dimensions off a portal note. Unknown values come back null so
// the caller flags the row instead of falling back to a guess.
function parsePortalNote(note) {
  const lang = String(note.sessionLanguageCategory || '').toUpperCase();
  const language = lang === 'ENGLISH' ? LANG.ENGLISH
                 : lang === 'NON_ENGLISH' || lang === 'OTHER' || lang === 'OTHER_THAN_ENGLISH' ? LANG.NON_ENGLISH
                 : null;

  const rawMode = String(note.sessionMode || '').toUpperCase();
  const mode = rawMode === 'IN_PERSON' ? MODE.IN_PERSON
             : /VIDEO/.test(rawMode) ? MODE.TELEHEALTH_VIDEO
             : /AUDIO|PHONE/.test(rawMode) ? MODE.TELEHEALTH_AUDIO
             : null;

  const rawLoc = String(note.locationCategory || '').toUpperCase();
  const location = rawLoc === 'CLIENT_HOME' ? LOC.CLIENT_HOME
                 : rawLoc === 'OTHER_LOCATION' ? LOC.OTHER_LOCATION
                 : /CLINIC/.test(rawLoc) ? LOC.IN_CLINIC
                 : null;

  return { language, mode, location, offsite: note.isOffsite === true };
}

// Pick the InSync type expressing the same dimensions. `visitTypes` is the live
// GetVisitTypes list: [{ VisitTypeID, VisitType, Duration, IsBillable }].
//
// Returns { matched, candidates, dimensions, reason }. `matched` is set ONLY on
// exactly one dimension-identical candidate — 0 or 2+ leaves it null and the
// row goes to Needs attention for a human to pick from the dropdown.
function matchEncounterType(note, visitTypes) {
  const dimensions = parsePortalNote(note);
  const peerTypes = (visitTypes || []).filter(t => isPeerIndividualType(t.VisitType));

  const missing = ['language', 'mode', 'location'].filter(k => !dimensions[k]);
  if (missing.length) {
    return {
      matched: null,
      candidates: peerTypes,
      dimensions,
      reason: `Portal note does not express ${missing.join(' / ')} in a form this app recognizes`,
    };
  }

  const candidates = peerTypes.filter(t => {
    const d = parseInsyncTypeName(t.VisitType);
    return d.language === dimensions.language
        && d.mode === dimensions.mode
        && d.location === dimensions.location
        && d.offsite === dimensions.offsite;
  });

  if (candidates.length === 1) {
    return { matched: candidates[0], candidates: peerTypes, dimensions, reason: null };
  }
  return {
    matched: null,
    candidates: peerTypes,
    dimensions,
    reason: candidates.length === 0
      ? `No InSync "Peer Support - Individual" type matches ${dimensions.language} / ${dimensions.mode} / ${dimensions.location}${dimensions.offsite ? ' / Offsite' : ''}`
      : `${candidates.length} InSync types match those dimensions — pick one`,
  };
}

module.exports = {
  normalizeName, matchName, editDistance,
  isPeerIndividualType, parseInsyncTypeName, parsePortalNote, matchEncounterType,
  LANG, MODE, LOC,
};
