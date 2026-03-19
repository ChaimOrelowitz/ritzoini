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
  cancelSession: (id) => authFetch(`/api/sessions/${id}/cancel`,         { method: 'POST' }),
  uncancelSession:(id) => authFetch(`/api/sessions/${id}/uncancel`,      { method: 'POST' }),
  returnToAuto:  (id) => authFetch(`/api/sessions/${id}/return-to-auto`, { method: 'POST' }),
  lockSession:   (id) => authFetch(`/api/sessions/${id}/lock`,           { method: 'POST' }),
  bulkNotes:     (groupId, notes_text) => authFetch(`/api/sessions/bulk-notes/${groupId}`, {
    method: 'POST', body: JSON.stringify({ notes_text }),
  }),

  // Users
  getUsers:   () => authFetch('/api/users'),
  inviteUser: (email, first_name, last_name, phone) =>
    authFetch('/api/users/invite', { method: 'POST', body: JSON.stringify({ email, first_name, last_name, phone }) }),
  updateUser: (id, body) => authFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Config
  getEmailEnabled:  () => authFetch('/api/config/email'),
  setEmailEnabled:  (enabled) => authFetch('/api/config/email', { method: 'POST', body: JSON.stringify({ enabled }) }),

  // Instructors
  getInstructors:   () => authFetch('/api/instructors'),
  createInstructor: (body) => authFetch('/api/instructors', { method: 'POST', body: JSON.stringify(body) }),
  updateInstructor: (id, body) => authFetch(`/api/instructors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteInstructor: (id) => authFetch(`/api/instructors/${id}`, { method: 'DELETE' }),
};
