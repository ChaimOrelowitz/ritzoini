const COSIGN_URL = 'thedscenter.insynchcs.com/CoSignEncounterList';

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
}

function showStats(total, flagged, clean) {
  document.getElementById('statTotal').textContent   = total;
  document.getElementById('statFlagged').textContent = flagged;
  document.getElementById('statClean').textContent   = clean;
  document.getElementById('stats').style.display = 'block';
  document.getElementById('btnSign').disabled = (clean === 0);
}

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await getTab();
  const onPage = tab?.url?.includes(COSIGN_URL);

  if (!onPage) {
    document.getElementById('wrongPage').style.display = 'block';
    document.getElementById('mainUI').style.display = 'none';
    return;
  }

  // Restore saved PIN
  const { pns_pin } = await chrome.storage.local.get('pns_pin');
  if (pns_pin) document.getElementById('epin').value = pns_pin;

  document.getElementById('btnAnalyze').addEventListener('click', async () => {
    const epin = document.getElementById('epin').value.trim();
    if (!epin) { setStatus('Enter your PIN first.', true); return; }
    chrome.storage.local.set({ pns_pin: epin });

    document.getElementById('btnAnalyze').disabled = true;
    document.getElementById('btnSign').disabled = true;
    document.getElementById('stats').style.display = 'none';
    setStatus('Analyzing notes… (fetching details, this may take a moment)');

    chrome.tabs.sendMessage(tab.id, { action: 'analyze' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setStatus('Could not reach the page. Make sure you\'re on the Co-Sign list.', true);
        document.getElementById('btnAnalyze').disabled = false;
        return;
      }
      if (resp.status === 'error') {
        setStatus(resp.message, true);
        document.getElementById('btnAnalyze').disabled = false;
        return;
      }

      // Poll for completion
      const poll = setInterval(async () => {
        const { pns_state } = await chrome.storage.local.get('pns_state');
        if (pns_state?.done) {
          clearInterval(poll);
          const { total, flagged, clean } = pns_state;
          setStatus(`Done. ${flagged} flagged, ${clean} ready to sign.`);
          showStats(total, flagged, clean);
          document.getElementById('btnAnalyze').disabled = false;
          chrome.storage.local.remove('pns_state');
        }
      }, 500);
    });
  });

  document.getElementById('btnSign').addEventListener('click', async () => {
    const epin = document.getElementById('epin').value.trim();
    if (!epin) { setStatus('Enter your PIN first.', true); return; }

    const clean = parseInt(document.getElementById('statClean').textContent) || 0;
    if (!clean) return;

    document.getElementById('btnSign').disabled = true;
    document.getElementById('btnAnalyze').disabled = true;
    setStatus(`Signing ${clean} notes…`);

    chrome.tabs.sendMessage(tab.id, { action: 'sign', epin }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setStatus('Sign failed — check the page.', true);
        document.getElementById('btnSign').disabled = false;
        document.getElementById('btnAnalyze').disabled = false;
        return;
      }
      setStatus(`✓ Signed ${resp.signed} notes${resp.errors ? `, ${resp.errors} errors` : ''}.`);
      document.getElementById('btnAnalyze').disabled = false;
    });
  });
});
