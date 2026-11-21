/* 구글 계정으로 학교 설정 (다른 학교용 프로그램)
   담당 선생님이 구글에 로그인하면: 학교 구글 시트 만들기 → 프로그램 코드 넣기 → 웹앱 배포 → 웹앱 권한 허용 대기
   이후 프로그램이 업데이트되면 학교 서버 코드도 자동으로 바꿈(담당 선생님 PC에서만). */
const { app, shell, net, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 시험용 모의 서버 주소(개발 실행에서만 사용)
const MOCK = !app.isPackaged && process.env.ISU_GOOGLE_MOCK ? process.env.ISU_GOOGLE_MOCK.replace(/\/$/, '') : '';
const EP = {
  auth: MOCK ? MOCK + '/o/oauth2/v2/auth' : 'https://accounts.google.com/o/oauth2/v2/auth',
  token: MOCK ? MOCK + '/token' : 'https://oauth2.googleapis.com/token',
  userinfo: MOCK ? MOCK + '/v1/userinfo' : 'https://openidconnect.googleapis.com/v1/userinfo',
  drive: MOCK ? MOCK + '/drive/v3/files' : 'https://www.googleapis.com/drive/v3/files',
  script: MOCK ? MOCK + '/v1/projects' : 'https://script.googleapis.com/v1/projects',
  userSettings: 'https://script.google.com/home/usersettings'
};
const SCOPES = ['openid', 'email',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments'];
const APP_MARKER = '최소 성취수준 보장지도';   // 웹앱 페이지 제목(Code.gs APP_TITLE)
// 시험 때는 인터넷 창 대신 프로그램이 직접 주소를 열어 봄
const openExternal = MOCK ? (u) => net.fetch(u).catch(() => {}) : (u) => shell.openExternal(u);

class SetupError extends Error { constructor(code, msg, detail) { super(msg); this.code = code; this.detail = detail || ''; } }

/* ── 저장 ── */
const dir = () => app.getPath('userData');
const connFile = () => path.join(dir(), 'connection.json');
const tokenFile = () => path.join(dir(), 'google-token.bin');
function readConn() { try { return JSON.parse(fs.readFileSync(connFile(), 'utf8')) || {}; } catch (e) { return {}; } }
function writeConn(c) { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(connFile() + '.tmp', JSON.stringify(c, null, 2)); fs.renameSync(connFile() + '.tmp', connFile()); }
function readToken() {
  try {
    const b = fs.readFileSync(tokenFile());
    const s = safeStorage.isEncryptionAvailable() && b[0] !== 0x7b ? safeStorage.decryptString(b) : b.toString('utf8');
    return JSON.parse(s);
  } catch (e) { return null; }
}
function writeToken(t) {
  fs.mkdirSync(dir(), { recursive: true });
  const s = JSON.stringify(t);
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s, 'utf8'));
}
function forgetGoogle() { try { fs.rmSync(tokenFile(), { force: true }); } catch (e) {} }

/* ── 서버 코드(프로그램에 들어 있는 다른 학교용 웹앱 파일) ── */
function serverFiles() {
  const base = path.join(__dirname, 'server');
  const rd = (f) => fs.readFileSync(path.join(base, f), 'utf8');
  const files = [
    { name: 'appsscript', type: 'JSON', source: rd('appsscript.json') },
    { name: 'Code', type: 'SERVER_JS', source: rd('Code.gs') },
    { name: 'Index', type: 'HTML', source: rd('Index.html') }
  ];
  const hash = crypto.createHash('sha256').update(files.map(f => f.name + '\0' + f.source).join('\0')).digest('hex').slice(0, 16);
  return { files, hash };
}
function hasServerFiles() { try { serverFiles(); return true; } catch (e) { return false; } }

/* ── HTTP ── */
async function req(url, opt) {
  opt = opt || {};
  let res;
  try { res = await net.fetch(url, opt); }
  catch (e) { throw new SetupError('NETWORK', '구글 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.', String(e && e.message || e)); }
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch (e) {}
  if (!res.ok) {
    const msg = (body && body.error && (body.error.message || body.error_description || body.error)) || text.slice(0, 300);
    const err = new SetupError('HTTP_' + res.status, String(msg), text.slice(0, 1500)); err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}
const form = (o) => new URLSearchParams(o).toString();

/* ── 로그인 (PKCE + 이 PC 안의 임시 주소로 결과 받기) ── */
let loginAbort = null;
function cancelLogin() { if (loginAbort) loginAbort(); }
function login(cfg, hint) {
  return new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    let done = false, timer = null;
    const page = (title, msg) => '<!DOCTYPE html><meta charset="utf-8"><title>' + title + '</title>' +
      '<body style="font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;background:#f4f5f7;color:#1c2433">' +
      '<div style="text-align:center;line-height:1.8"><div style="font-size:22px;font-weight:700">' + title + '</div><div style="color:#667085">' + msg + '</div></div>';
    const server = http.createServer(async (rq, rs) => {
      const u = new URL(rq.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { rs.writeHead(404); return rs.end(); }
      const finish = (ok, title, msg) => { rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(page(title, msg)); };
      if (u.searchParams.get('state') !== state) return finish(false, '잘못된 요청입니다', '프로그램에서 다시 시도해 주세요.');
      if (u.searchParams.get('error')) {
        finish(false, '로그인을 취소했습니다', '프로그램으로 돌아가 다시 시도할 수 있습니다.');
        return end(new SetupError('LOGIN_CANCELLED', '구글 로그인을 취소했습니다.'));
      }
      try {
        const t = await req(EP.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret || '', code: u.searchParams.get('code'),
            code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect }) });
        const granted = String(t.scope || '').split(/\s+/);
        const missing = SCOPES.filter(s => s.startsWith('https://') && granted.indexOf(s) < 0);
        if (missing.length) {
          finish(false, '권한이 모두 선택되지 않았습니다', '프로그램으로 돌아가 다시 로그인하고, 권한 화면에서 모든 항목에 체크해 주세요.');
          return end(new SetupError('SCOPES', '구글 권한 화면에서 일부 항목이 선택되지 않았습니다. 다시 로그인해 모든 항목에 체크해 주세요.'));
        }
        t.expires_at = Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000;
        writeToken(t);
        finish(true, '로그인되었습니다 ✓', '이 창을 닫고 프로그램으로 돌아가세요. 설정은 프로그램이 이어서 진행합니다.');
        end(null, t);
      } catch (e) {
        finish(false, '로그인을 마치지 못했습니다', '프로그램으로 돌아가 다시 시도해 주세요.');
        end(e);
      }
    });
    let redirect = '';
    function end(err, val) {
      if (done) return; done = true; clearTimeout(timer); loginAbort = null;
      setTimeout(() => server.close(), 500);
      err ? reject(err) : resolve(val);
    }
    loginAbort = () => end(new SetupError('LOGIN_CANCELLED', '구글 로그인을 취소했습니다.'));
    timer = setTimeout(() => end(new SetupError('LOGIN_TIMEOUT', '10분 안에 로그인이 끝나지 않았습니다. 다시 시도해 주세요.')), 10 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      redirect = 'http://127.0.0.1:' + server.address().port;
      const q = { client_id: cfg.googleClientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
        code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state };
      if (hint) q.login_hint = hint;
      openExternal(EP.auth + '?' + form(q));
    });
    server.on('error', (e) => end(new SetupError('LOGIN_SERVER', '로그인 준비 중 문제가 생겼습니다.', String(e))));
  });
}

async function accessToken(cfg) {
  const t = readToken();
  if (!t || !t.refresh_token) throw new SetupError('NO_TOKEN', '구글 로그인이 필요합니다.');
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  let r;
  try {
    r = await req(EP.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret || '', refresh_token: t.refresh_token, grant_type: 'refresh_token' }) });
  } catch (e) {
    if (e.status === 400 || e.status === 401) { forgetGoogle(); throw new SetupError('NO_TOKEN', '구글 로그인이 만료되었습니다. 다시 로그인해 주세요.'); }
    throw e;
  }
  t.access_token = r.access_token; t.expires_at = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
  writeToken(t);
  return t.access_token;
}
async function api(cfg, method, url, body) {
  const tok = await accessToken(cfg);
  try {
    return await req(url, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    const m = String(e.message || '') + ' ' + String(e.detail || '');
    if (e.status === 403 && /has not enabled the Apps Script API|usersettings/i.test(m))
      throw new SetupError('API_DISABLED', 'Apps Script API 사용 설정이 꺼져 있습니다.');
    if (e.status === 403 && /(has not been used in project|SERVICE_DISABLED|accessNotConfigured)/i.test(m))
      throw new SetupError('CLOUD_API_OFF', '프로그램 배포자의 구글 클라우드 설정에서 API가 꺼져 있습니다. 배포한 선생님께 알려 주세요.', m);
    if (e.status === 401) { forgetGoogle(); throw new SetupError('NO_TOKEN', '구글 로그인이 만료되었습니다. 다시 로그인해 주세요.'); }
    throw e;
  }
}

/* ── 코드 올리고 배포 ── */
async function pushAndDeploy(cfg, s) {
  const { files, hash } = serverFiles();
  await api(cfg, 'PUT', EP.script + '/' + s.scriptId + '/content', { files });
  const v = await api(cfg, 'POST', EP.script + '/' + s.scriptId + '/versions', { description: '프로그램 ' + app.getVersion() });
  const conf = { versionNumber: v.versionNumber, manifestFileName: 'appsscript', description: '최소성취수준 이수관리 ' + app.getVersion() };
  let dep;
  try {
    dep = s.deploymentId
      ? await api(cfg, 'PUT', EP.script + '/' + s.scriptId + '/deployments/' + s.deploymentId, { deploymentConfig: Object.assign({ scriptId: s.scriptId }, conf) })
      : await api(cfg, 'POST', EP.script + '/' + s.scriptId + '/deployments', conf);
  } catch (e) {
    if (e.code && !/^HTTP_/.test(e.code)) throw e;
    throw new SetupError('DEPLOY', '웹앱을 배포하지 못했습니다. 학교(교육청) 구글 계정은 외부 공개 배포가 막혀 있을 수 있으니, 개인 구글 계정으로 다시 시도해 보세요.', String(e.message || ''));
  }
  const ep = (dep.entryPoints || []).find(x => x.entryPointType === 'WEB_APP' || x.webApp);
  s.deploymentId = dep.deploymentId || s.deploymentId;
  if (ep && ep.webApp && ep.webApp.url) s.webappUrl = ep.webApp.url;
  if (!s.webappUrl && s.deploymentId) s.webappUrl = 'https://script.google.com/macros/s/' + s.deploymentId + '/exec';
  s.codeHash = hash; s.codeVersion = app.getVersion(); s.updatedAt = new Date().toISOString();
}

/* 웹앱이 열리는지(=담당 선생님이 권한을 허용했는지) 확인 */
async function webappReady(url) {
  try {
    const r = await net.fetch(url, { redirect: 'follow', cache: 'no-store' });
    if (!r.ok) return false;
    const t = await r.text();
    return t.indexOf(APP_MARKER) >= 0;
  } catch (e) { return false; }
}

/* 전체 설정. progress(step, state, msg): step = login|sheet|script|deploy|consent|done */
let running = false;
async function runSetup(cfg, opts, progress) {
  if (running) throw new SetupError('BUSY', '이미 설정을 진행하고 있습니다.');
  running = true;
  const c = readConn(); const s = c.setup = c.setup || {};
  try {
    if (!readToken() || opts.relogin) {
      progress('login', 'run', '인터넷 창에서 구글에 로그인하고 [허용]을 눌러 주세요…');
      await login(cfg, opts.hint);
    }
    if (!s.email) { try { const u = await api(cfg, 'GET', EP.userinfo); s.email = u.email || ''; } catch (e) { if (e.code === 'NO_TOKEN') throw e; } }
    progress('login', 'ok', s.email ? s.email + ' 계정으로 로그인했습니다.' : '로그인했습니다.');
    writeConn(c);

    if (!s.spreadsheetId) {
      progress('sheet', 'run', '학교 구글 시트를 만드는 중입니다…');
      const f = await api(cfg, 'POST', EP.drive + '?fields=id,name', { name: '최소성취수준 이수관리 (학교 데이터)', mimeType: 'application/vnd.google-apps.spreadsheet' });
      s.spreadsheetId = f.id; writeConn(c);
    }
    progress('sheet', 'ok', '구글 드라이브에 ‘최소성취수준 이수관리 (학교 데이터)’ 시트를 만들었습니다.');

    if (!s.scriptId) {
      progress('script', 'run', '프로그램 코드를 넣는 중입니다…');
      const p = await api(cfg, 'POST', EP.script, { title: '최소성취수준 이수관리', parentId: s.spreadsheetId });
      s.scriptId = p.scriptId; writeConn(c);
    }
    progress('script', 'ok', '프로그램 코드를 넣었습니다.');

    progress('deploy', 'run', '웹앱으로 배포하는 중입니다…');
    await pushAndDeploy(cfg, s); writeConn(c);
    progress('deploy', 'ok', '웹앱으로 배포했습니다.');

    if (!(await webappReady(s.webappUrl))) {
      progress('consent', 'run', '인터넷 창에서 학교 웹앱의 권한을 [허용]해 주세요…');
      openExternal(s.webappUrl);
      const until = Date.now() + 15 * 60 * 1000;
      consentSkip = false;
      while (!(await webappReady(s.webappUrl))) {
        if (consentSkip) break;
        if (Date.now() > until) throw new SetupError('CONSENT_TIMEOUT', '웹앱 권한 허용이 확인되지 않았습니다. 인터넷 창에서 허용을 마친 뒤 [다시 시도]를 눌러 주세요.');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    progress('consent', 'ok', '웹앱 권한을 허용했습니다.');
    c.mode = 'web'; c.webappUrl = s.webappUrl; writeConn(c);
    progress('done', 'ok', '설정을 마쳤습니다. 학교 웹앱을 엽니다.');
    return { webappUrl: s.webappUrl, email: s.email, spreadsheetId: s.spreadsheetId };
  } finally { running = false; }
}
let consentSkip = false;
function skipConsent() { consentSkip = true; }

/* 프로그램이 업데이트되면 학교 서버 코드도 바꿈 (설정했던 PC에서만, 조용히) */
async function autoUpdateServer(cfg) {
  const c = readConn(), s = c.setup;
  if (!s || !s.scriptId || !s.deploymentId || c.mode !== 'web' || c.webappUrl !== s.webappUrl) return { skipped: 'not-owner' };
  if (!readToken() || !hasServerFiles()) return { skipped: 'no-token' };
  const { hash } = serverFiles();
  if (s.codeHash === hash) return { skipped: 'same' };
  try {
    const before = s.webappUrl;
    await pushAndDeploy(cfg, s);
    s.webappUrl = before; s.lastUpdateError = ''; writeConn(c);   // 주소는 그대로 유지
    return { updated: true, version: s.codeVersion };
  } catch (e) {
    s.lastUpdateError = (e.code || '') + ' ' + (e.message || ''); writeConn(c);
    return { error: e.code || 'ERR', message: e.message };
  }
}

module.exports = { readConn, writeConn, runSetup, cancelLogin, skipConsent, autoUpdateServer, forgetGoogle, hasServerFiles, readToken, SetupError, EP, SCOPES };
