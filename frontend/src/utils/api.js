import supabase from '../supabaseClient';

const API = process.env.REACT_APP_API_URL || 'http://localhost:4000';

async function authFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export const api = {
  // Groups
  getGroups:      (archived = false) => authFetch(`/api/groups?archived=${archived}`),
  getGroup:       (id) => authFetch(`/api/groups/${id}`),
  createGroup:    (body) => authFetch('/api/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup:    (id, body) => authFetch(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  endGroup:       (id) => authFetch(`/api/groups/${id}/end`,       { method: 'POST' }),
  unendGroup:     (id) => authFetch(`/api/groups/${id}/unend`,     { method: 'POST' }),
  archiveGroup:   (id) => authFetch(`/api/groups/${id}/archive`,   { method: 'POST' }),
  unarchiveGroup: (id) => authFetch(`/api/groups/${id}/unarchive`, { method: 'POST' }),

  // Sessions
  getSessions:        (groupId) => authFetch(`/api/sessions?group_id=${groupId}`),
  getCalendarSessions:(supervisorId, includeArchived) => {
    const params = new URLSearchParams();
    if (supervisorId) params.set('supervisor_id', supervisorId);
    if (includeArchived) params.set('include_archived', 'true');
    const qs = params.toString();
    return authFetch(`/api/sessions/calendar${qs ? `?${qs}` : ''}`);
  },
  updateSession: (id, body) => authFetch(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  cancelSession:    (id) => authFetch(`/api/sessions/${id}/cancel`,         { method: 'POST' }),
  uncancelSession:  (id) => authFetch(`/api/sessions/${id}/uncancel`,      { method: 'POST' }),
  restoreSkip:      (id) => authFetch(`/api/sessions/${id}/restore-skip`,  { method: 'POST' }),
  returnToAuto:     (id) => authFetch(`/api/sessions/${id}/return-to-auto`, { method: 'POST' }),
  lockSession:    (id) => authFetch(`/api/sessions/${id}/lock`,           { method: 'POST' }),
  generateNote:   (id) => authFetch(`/api/sessions/${id}/generate-note`,  { method: 'POST' }),
  sendEmail:      (id) => authFetch(`/api/sessions/${id}/send-email`,      { method: 'POST' }),
  bulkNotes:     (groupId, notes_text, start_from) => authFetch(`/api/sessions/bulk-notes/${groupId}`, {
    method: 'POST', body: JSON.stringify({ notes_text, start_from }),
  }),
  compileNotes:  (groupId) => authFetch(`/api/sessions/compile-notes/${groupId}`),

  // Users
  getUsers:   () => authFetch('/api/users'),
  getMyProfile: () => authFetch('/api/users/me'),
  updateMyProfile: (body) => authFetch('/api/users/me', { method: 'PATCH', body: JSON.stringify(body) }),
  inviteUser: (email, first_name, last_name, phone, role) =>
    authFetch('/api/users/invite', { method: 'POST', body: JSON.stringify({ email, first_name, last_name, phone, role }) }),
  updateUser:     (id, body) => authFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetPassword:  (id) => authFetch(`/api/users/${id}/reset-password`, { method: 'POST' }),

  // Config
  getEmailEnabled:  () => authFetch('/api/config/email'),
  setEmailEnabled:  (enabled) => authFetch('/api/config/email', { method: 'POST', body: JSON.stringify({ enabled }) }),

  // Pay Periods
  getPayPeriods:    () => authFetch('/api/pay-periods'),
  createPayPeriod:  (body) => authFetch('/api/pay-periods', { method: 'POST', body: JSON.stringify(body) }),
  generatePayPeriods: (anchor_date) => authFetch('/api/pay-periods/generate', { method: 'POST', body: JSON.stringify({ anchor_date }) }),
  updatePayPeriod:  (id, body) => authFetch(`/api/pay-periods/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePayPeriod:  (id) => authFetch(`/api/pay-periods/${id}`, { method: 'DELETE' }),

  // Payments / Reconciliation
  getPaymentSessions: (supervisor_id, start_date, end_date) =>
    authFetch(`/api/payments/sessions?supervisor_id=${supervisor_id}&start_date=${start_date}&end_date=${end_date}`),
  confirmPayment: (session_ids) => authFetch('/api/payments/confirm', { method: 'POST', body: JSON.stringify({ session_ids }) }),

  // Bulk Import
  parseBulkImport: async (file) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API}/api/bulk-import/parse`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Parse failed');
    return json;
  },
  confirmBulkImport: (groups) => authFetch('/api/bulk-import/confirm', { method: 'POST', body: JSON.stringify({ groups }) }),

  // Instructors
  getInstructors:   () => authFetch('/api/instructors'),
  createInstructor: (body) => authFetch('/api/instructors', { method: 'POST', body: JSON.stringify(body) }),
  updateInstructor: (id, body) => authFetch(`/api/instructors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteInstructor: (id) => authFetch(`/api/instructors/${id}`, { method: 'DELETE' }),
};
