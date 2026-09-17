// The co-sign engine, built from the settings an operator edits in the PS
// Settings tab. Shared so the routes and the CRM keep-alive timer
// (utils/crmKeepAlive.js) build it exactly the same way.

const supabase = require('../db/supabase');
const { InsyncCoSignEngine } = require('./peerSupervisorEngine');

async function buildPsEngine() {
  const { data: rows } = await supabase.from('app_settings').select('key, value')
    .in('key', ['insync_username','insync_password','insync_provider_id',
                'ps_no_school_start','ps_no_school_end','anthropic_api_key',
                'ps_prompt_core_review','ps_prompt_offsite']);
  const S = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  return new InsyncCoSignEngine({
    username:      S.insync_username    || process.env.INSYNC_USERNAME      || '',
    password:      S.insync_password    || process.env.INSYNC_PASSWORD      || '',
    anthropicKey:  S.anthropic_api_key  || process.env.ANTHROPIC_API_KEY    || '',
    providerId:    S.insync_provider_id || process.env.INSYNC_PROVIDER_ID   || '2317',
    noSchoolStart: S.ps_no_school_start || '',
    noSchoolEnd:   S.ps_no_school_end   || '',
    coreReviewPrompt: S.ps_prompt_core_review || '',
    offsitePrompt:    S.ps_prompt_offsite     || '',
  });
}

module.exports = { buildPsEngine };
