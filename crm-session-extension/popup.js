const $ = id => document.getElementById(id);

function showLast(last) {
  const el = $('status');
  if (!last) { el.className = 'status'; el.textContent = 'No session sent yet.'; return; }
  el.className = `status ${last.ok ? 'ok' : 'bad'}`;
  el.innerHTML = '';
  el.append(last.message);
  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent = `${new Date(last.at).toLocaleString()} · ${last.reason}`;
  el.append(meta);
}

chrome.storage.local.get(['token', 'machineName', 'apiBase', 'last'], s => {
  $('token').value = s.token || '';
  $('machineName').value = s.machineName || '';
  $('apiBase').value = s.apiBase || '';
  showLast(s.last);
});

async function save() {
  await chrome.storage.local.set({
    token: $('token').value.trim(),
    machineName: $('machineName').value.trim(),
    apiBase: $('apiBase').value.trim(),
  });
}

$('save').addEventListener('click', async () => {
  await save();
  $('save').textContent = 'Saved';
  setTimeout(() => { $('save').textContent = 'Save'; }, 1200);
});

$('send').addEventListener('click', async () => {
  await save();
  $('send').disabled = true;
  $('send').textContent = 'Sending…';
  const last = await chrome.runtime.sendMessage({ type: 'sendNow' });
  showLast(last);
  $('send').disabled = false;
  $('send').textContent = 'Send session now';
});
