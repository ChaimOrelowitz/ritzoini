// Portal POC — payload massaging for the InSync write chain.
//
// A direct port of app.py's `set_fields` / `recursive_id` / `appointment_result`
// helpers. The POC earned these the hard way against a live EHR; the shapes and
// the quirks they work around are treated as proven and reproduced rather than
// re-derived. Pure functions — no I/O — so they are testable on their own.

// "objBookAppointmentss[PMAlertData][PatientID]" -> "objbookappointmentss.pmalertdata.patientid"
function normalizeKey(key) {
  let k = key;
  try { k = decodeURIComponent(key); } catch { /* already decoded */ }
  return k.replace(/[[\]]+/g, '.').replace(/\.+$/, '').toLowerCase();
}

// InSync's MVC model binder nests the same logical field under many prefixes.
// A name matches on full equality or as the last dot-segment, which is how the
// POC reaches "…[VisitID]" and a bare "VisitID" with one rule.
function keyMatches(key, names) {
  const k = normalizeKey(key);
  return names.some(n => {
    const c = n.toLowerCase();
    return k === c || k.endsWith('.' + c);
  });
}

function clean(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// Set every field whose name matches any of `names`. Returns how many were hit,
// which the caller uses to notice a template that no longer carries a field.
function setFields(payload, value, ...names) {
  let count = 0;
  for (const key of Object.keys(payload)) {
    if (keyMatches(key, names)) { payload[key] = clean(value); count++; }
  }
  return count;
}

// Depth-first hunt for a positive integer id under any of `names`.
function recursiveId(data, names) {
  if (Array.isArray(data)) {
    for (const v of data) { const f = recursiveId(v, names); if (f) return f; }
    return '';
  }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (!names.has(k.toLowerCase())) continue;
      // JS has no bool/int conflation, but InSync does return `true` in id-named
      // fields; the POC guards against it and so does this.
      if (typeof v === 'boolean') continue;
      const c = clean(v);
      if (/^\d+$/.test(c) && Number(c) > 0) return c;
    }
    for (const v of Object.values(data)) { const f = recursiveId(v, names); if (f) return f; }
  }
  return '';
}

// Pull an id out of a response body, falling back to a text scan for the
// endpoints that answer with HTML-ish payloads.
function responseId(body, text, ...names) {
  const lowered = new Set(names.map(n => n.toLowerCase()));
  if (body) {
    const found = recursiveId(body, lowered);
    if (found) return found;
  }
  const head = String(text || '').slice(0, 10000);
  for (const name of names) {
    const m = head.match(new RegExp(`["'\\s:=]+${name}["'\\s:=]+(\\d+)`, 'i'));
    if (m) return m[1];
  }
  return '';
}

// SaveBookAppointment answers 200 whether or not it booked anything, so the
// only honest success signal is DataSave === true plus a numeric VisitID.
// A refusal carries its reason in one of many *Message/*Error/*Warning fields;
// surface them instead of "something went wrong".
function appointmentResult(body) {
  if (!body || typeof body !== 'object') throw new Error('Appointment response was not JSON');
  if (body.DataSave !== true) {
    const diagnostics = [];
    (function collect(v) {
      if (Array.isArray(v)) return v.forEach(collect);
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) {
          if (child && typeof child === 'object') { collect(child); continue; }
          if (/message|error|warning/i.test(k) && child !== null && child !== '' && child !== false) {
            diagnostics.push(`${k}=${clean(child).slice(0, 300)}`);
          }
        }
      }
    })(body);
    // No *Message/*Error/*Warning field carried anything: fall back to naming the
    // non-empty top-level keys, so a silent refusal is still diagnosable instead
    // of being a dead end.
    let reason = [...new Set(diagnostics)].join('; ');
    if (!reason) {
      const hints = Object.entries(body)
        .filter(([, v]) => v !== null && v !== '' && v !== false && v !== 0 &&
                           !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : clean(v).slice(0, 80)}`)
        .slice(0, 8);
      reason = hints.length
        ? `InSync gave no error text. Response carried: ${hints.join('; ')}`
        : 'InSync returned DataSave=false and an otherwise empty response';
    }
    throw new Error(`Appointment was not created: ${reason}`);
  }
  const visitId = recursiveId(body.BookAppoint || {}, new Set(['visitid']));
  if (!visitId) throw new Error('Appointment reported success but returned no numeric VisitID');
  return visitId;
}

module.exports = { normalizeKey, keyMatches, clean, setFields, recursiveId, responseId, appointmentResult };
