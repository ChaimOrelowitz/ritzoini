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
  getGroups: () => authFetch('/api/groups'),
  getGroup: (id) => authFetch(`/api/groups/${id}`),
  createGroup: (body) => authFetch('/api/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup: (id, body) => authFetch(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteGroup: (id) => authFetch(`/api/groups/${id}`, { method: 'DELETE' }),

  getSessions: (groupId) => authFetch(`/api/sessions${groupId ? `?group_id=${groupId}` : ''}`),
  updateSession: (id, body) => authFetch(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  submitNotes: (id, notes) => authFetch(`/api/sessions/${id}/submit-notes`, { method: 'POST', body: JSON.stringify({ notes }) }),
  lockSession: (id) => authFetch(`/api/sessions/${id}/lock`, { method: 'POST' }),
  cancelSession: (id) => authFetch(`/api/sessions/${id}/cancel`, { method: 'POST' }),

  getUsers: () => authFetch('/api/users'),
  inviteUser: (email, first_name, last_name, phone) =>
    authFetch('/api/users/invite', {
      method: 'POST',
      body: JSON.stringify({ email, first_name, last_name, phone }),
    }),
  updateUser: (id, body) => authFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};
