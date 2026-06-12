const BASE = 'https://thedscenter.insynchcs.com';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

async function login(username, password) {
  const jar = new Map();

  function addCookies(res) {
    for (const raw of (res.headers.getSetCookie?.() || [])) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  function cookieStr() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  const step1 = await fetch(`${BASE}/account`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
    redirect: 'manual',
  });
  addCookies(step1);

  const loginBody = new URLSearchParams({
    UserName: username, Password: password,
    PageID: 'PatientSearch', hdnPageListVal: 'PatientSearch',
    IsAzureAd: 'False', IsAutoLoginWithCookie: 'False',
    GeoLocation: '', GeoErrorCode: '', GeoErrorMessage: '',
  });

  let url = `${BASE}/`, method = 'POST', body = loginBody.toString();

  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        'Content-Type': method === 'POST' ? 'application/x-www-form-urlencoded' : undefined,
        'Origin': BASE, 'Referer': `${BASE}/account`,
        'Cookie': cookieStr(), 'Accept': 'text/html,*/*',
      },
      body: method === 'POST' ? body : undefined,
      redirect: 'manual',
    });
    addCookies(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      url = loc.startsWith('http') ? loc : `${BASE}${loc}`;
      method = 'GET'; body = undefined;
    } else {
      const text = await res.text();
      if (text.includes('SIGN IN') && text.includes('Password'))
        throw new Error('InSync login failed — check credentials in ⚙ settings');
      break;
    }
  }

  if (!jar.size) throw new Error('InSync login returned no cookies');
  return cookieStr();
}

function post(path, params, cookie) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      'Origin': BASE,
      'Referer': `${BASE}/Scheduler/Index`,
      'Cookie': cookie,
    },
    body: new URLSearchParams(params).toString(),
  });
}

module.exports = { BASE, UA, login, post };
