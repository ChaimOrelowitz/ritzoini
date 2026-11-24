import { api } from '../../utils/api';

// One-time setup / troubleshooting tools for the Zoho connection. They used to
// sit on the Groups toolbar; they're rarely needed, so they live here, folded
// away, on the Zoho Sync page. Behaviour is unchanged.
export default function ZohoDiagnostics() {
  async function handleTestZoho() {
    try {
      const r = await api.testZoho();
      const lines = [
        `Configured: ${r.configured ? 'yes' : 'NO'}`,
        `Token/auth: ${r.tokenOk ? 'OK' : 'FAILED'}`,
        `Read ${r.module}: ${r.moduleReadOk ? 'OK' : 'FAILED'}`,
        r.errors?.length ? `\nErrors:\n- ${r.errors.join('\n- ')}` : '\nAll checks passed ✅',
      ];
      alert('Zoho connection test\n\n' + lines.join('\n'));
    } catch (err) {
      alert('Zoho test failed: ' + err.message);
    }
  }

  async function handleTestZohoWrite() {
    if (!window.confirm('Run a safe Zoho write test?\n\nThis rewrites one occurrence’s note to its own current value to prove write access. No data is changed and no status is advanced.')) return;
    try {
      const r = await api.testZohoWrite();
      const occ = r.occurrence ? `${r.occurrence.name || '(unnamed)'} — ${r.occurrence.date || 'no date'}` : '(none)';
      const lines = [
        `Token/auth: ${r.tokenOk ? 'OK' : 'FAILED'}`,
        `Write access: ${r.writeOk ? 'OK ✅' : 'FAILED'}`,
        `Tested against: ${occ}`,
        r.errors?.length ? `\nErrors:\n- ${r.errors.join('\n- ')}` : '',
      ];
      alert('Zoho write test\n\n' + lines.join('\n'));
    } catch (err) {
      alert('Zoho write test failed: ' + err.message);
    }
  }

  async function handleZohoExchange() {
    const code = window.prompt('Paste the grant token (code) generated in the Zoho API console (Self Client → Generate Code, scope ZohoCRM.modules.ALL). It expires in minutes, so do this promptly:');
    if (!code || !code.trim()) return;
    try {
      const r = await api.zohoExchange(code.trim());
      const msg = r.saved
        ? '✅ Success! Refresh token minted and saved automatically — it\'s live now. Click "Test Zoho" to confirm.'
        : '✅ Token minted, but auto-save failed. Copy this and set it as ZOHO_REFRESH_TOKEN in env, then redeploy:';
      if (r.saved) alert(msg);
      else window.prompt(msg, r.refresh_token);
    } catch (err) {
      alert('Exchange failed: ' + err.message);
    }
  }

  async function handleInspectOccurrence() {
    const id = window.prompt('Zoho occurrence id to inspect:', '6513966000028141570');
    if (!id || !id.trim()) return;
    try {
      const r = await api.inspectOccurrence(id.trim());
      const s = r.Session; // parent lookup {name, id}
      const lines = [
        `Session_Name (occ field): ${JSON.stringify(r.Session_Name)}`,
        `Session_Date: ${JSON.stringify(r.Session_Date)}`,
        `Start_Time: ${JSON.stringify(r.Start_Time)}`,
        `Session_Code: ${JSON.stringify(r.Session_Code)}`,
        `Parent Session: ${s ? `${s.name}  (id ${s.id})` : '(none)'}`,
        `ECW: ${r.ECW}   Locked_Notes: ${r.Locked_Notes}`,
      ];
      alert('Occurrence ' + id.trim() + '\n\n' + lines.join('\n'));
    } catch (err) {
      alert('Inspect failed: ' + err.message);
    }
  }

  async function handleLockBackfill() {
    try {
      const r = await api.zohoLockBackfill(false); // dry run
      const lines = [
        `Sessions with a Zoho note: ${r.totalWithZohoNote}`,
        `  not yet locked in Ritzoini: ${r.unlockedInRitzoini}`,
        `  checked against Zoho: ${r.checked}`,
        ``,
        `WOULD set Locked: ${r.wouldLock}`,
        `WOULD set Ready to Lock: ${r.wouldReady}`,
        `Errors: ${r.errors}`,
        r.sample.length ? `\nSample:\n` + r.sample.map(x => `• ${x.date} — ${x.group || '?'} → ${x.action}`).join('\n') : '',
      ];
      if (r.wouldLock + r.wouldReady === 0) {
        alert('Lock backfill — dry run\n\n' + lines.join('\n') + '\n\nNothing to change.');
        return;
      }
      const go = window.confirm('Lock backfill — DRY RUN\n\n' + lines.join('\n') + `\n\nApply these ${r.wouldLock + r.wouldReady} change(s) to Ritzoini? (Zoho is not touched.)`);
      if (!go) return;
      const applied = await api.zohoLockBackfill(true);
      alert(`✅ Applied ${applied.applied} change(s) (${applied.wouldLock} locked, ${applied.wouldReady} ready-to-lock).`);
    } catch (err) {
      alert('Lock backfill failed: ' + err.message);
    }
  }

  const btn = { color: '#6941C6', fontSize: '0.75rem' };
  return (
    <details style={{ marginTop: 28, borderTop: '1px solid var(--gray-200)', paddingTop: 14 }}>
      <summary style={{ cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--gray-500)' }}>
        Diagnostics &amp; setup tools
      </summary>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn btn-outline btn-sm" style={btn} onClick={handleTestZoho}
          title="Read-only check of Zoho connection, token scope, and module access">Test Zoho</button>
        <button className="btn btn-outline btn-sm" style={btn} onClick={handleTestZohoWrite}
          title="Safe write test — proves Zoho write access without changing any data">Test Write</button>
        <button className="btn btn-outline btn-sm" style={btn} onClick={handleZohoExchange}
          title="Turn a Zoho Self Client grant code into a refresh token">Get Refresh Token</button>
        <button className="btn btn-outline btn-sm" style={btn} onClick={handleInspectOccurrence}
          title="Dump a Zoho occurrence's raw fields (read-only)">Inspect Occurrence</button>
        <button className="btn btn-outline btn-sm" style={btn} onClick={handleLockBackfill}
          title="One-time: reconcile Locked status from Zoho for all sessions with a Zoho note (dry run first)">Lock Backfill</button>
      </div>
    </details>
  );
}
