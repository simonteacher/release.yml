const { app, BrowserWindow, Menu, shell, dialog, ipcMain, net, protocol, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_TITLE = '최소 성취수준 보장지도 시스템';

// 학교 웹앱(구글 시트) 주소. config.json의 webappUrl에 Apps Script 웹앱 주소(…/exec)를 넣으면
// 프로그램이 그 웹앱을 열고, 비어 있으면 이 PC에 저장하는 방식으로 동작합니다.
// 다른 학교용 프로그램은 config.generic.json을 쓰고, 처음 실행할 때 학교 연결 방법을 고릅니다.
let CFG = {};
for (const f of ['config.generic.json', 'config.json']) {
  try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')) || {}; break; } catch (e) { /* 다음 파일 */ }
}
const GENERIC = CFG.edition === 'generic';
const URL_RE = /https:\/\/script\.google\.com\/(?:a\/macros\/[^/\s]+|macros)\/s\/[A-Za-z0-9_-]+\/exec/;
let WEBAPP_URL = '';
if (!GENERIC && URL_RE.test(String(CFG.webappUrl || '').trim())) WEBAPP_URL = CFG.webappUrl.trim();
const gs = GENERIC ? require('./gsetup') : null;
const LOCAL_PAGE = fs.existsSync(path.join(__dirname, 'app.html')) ? 'app.html' : 'index.html';
const isGoogle = (u) => /^https:\/\/([a-z0-9-]+\.)*(script\.google\.com|googleusercontent\.com|accounts\.google\.com|docs\.google\.com)(\/|$)/i.test(u);
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 켜 둔 상태에서도 4시간마다 확인

let win = null;
let quitting = false;        // 업데이트 설치를 위한 종료일 때 종료 확인창 생략
let manualCheck = false;     // 메뉴에서 직접 확인했을 때만 "최신 버전입니다" 안내
let updateReady = false;
let downloading = false;
let readyInfo = null;

// ── PC 저장소 (내 문서가 아닌 앱 전용 폴더에 JSON으로 저장) ─────────
// 위치: %APPDATA%\최소성취수준보장지도\data
const dataDir = () => path.join(app.getPath('userData'), 'data');
const dataFile = () => path.join(dataDir(), 'isu-data.json');
const backupDir = () => path.join(app.getPath('userData'), 'backups');
const KEEP_BACKUPS = 30;

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);           // 저장 도중 꺼져도 기존 파일이 깨지지 않음
}
function dailyBackup() {
  try {
    if (!fs.existsSync(dataFile())) return;
    fs.mkdirSync(backupDir(), { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const target = path.join(backupDir(), `isu-${stamp}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(dataFile(), target);
    const old = fs.readdirSync(backupDir()).filter(f => /^isu-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)).forEach(f => fs.unlinkSync(path.join(backupDir(), f)));
  } catch (e) { /* 백업 실패는 프로그램 사용을 막지 않음 */ }
}
ipcMain.handle('store:load', () => {
  try { return fs.readFileSync(dataFile(), 'utf8'); } catch (e) { return null; }
});
ipcMain.handle('store:save', (e, text) => { writeAtomic(dataFile(), text); return true; });
ipcMain.on('store:saveSync', (e, text) => {
  try { writeAtomic(dataFile(), text); e.returnValue = true; } catch (err) { e.returnValue = false; }
});
ipcMain.handle('store:openFolder', () => { fs.mkdirSync(dataDir(), { recursive: true }); return shell.openPath(app.getPath('userData')); });

// 인쇄 미리보기: 인쇄할 화면을 PDF로 만들어 미리보기 창에 띄움 (창 오른쪽 위 🖨 버튼으로 인쇄)
let printBusy = false;
ipcMain.on('print:preview', async (e, html) => {
  if (typeof html !== 'string' || !html || html.length > 60e6 || printBusy) return;
  printBusy = true;
  const dir = path.join(app.getPath('temp'), 'isu-print');
  const id = Date.now(), htmlPath = path.join(dir, id + '.html'), pdfPath = path.join(dir, '인쇄미리보기_' + id + '.pdf');
  let r;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(htmlPath, html, 'utf8');
    r = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
    await r.loadFile(htmlPath);
    await new Promise((ok) => setTimeout(ok, 600));   // 글꼴 적용 대기
    const pdf = await r.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(pdfPath, pdf);
  } catch (err) {
    dialog.showErrorBox('인쇄 미리보기', '미리보기를 만들지 못했습니다.\n' + (err && err.message || err));
    return;
  } finally {
    printBusy = false;
    if (r && !r.isDestroyed()) r.destroy();
    fs.rm(htmlPath, { force: true }, () => {});
  }
  const pv = new BrowserWindow({
    width: 1100, height: 900, title: '인쇄 미리보기 — 오른쪽 위 🖨 버튼으로 인쇄합니다', autoHideMenuBar: true,
    webPreferences: { plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  pv.on('page-title-updated', (ev) => ev.preventDefault());
  pv.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pv.on('closed', () => fs.rm(pdfPath, { force: true }, () => {}));
  pv.loadFile(pdfPath);
});

// ── 처음 설정 화면 (다른 학교용) ───────────────────────────
const fromSetup = (e) => /\/setup\.html$/.test(new URL(e.senderFrame.url).pathname);
function setupIpc() {
  const googleReady = () => !!(CFG.googleClientId && gs.hasServerFiles());
  ipcMain.handle('setup:info', (e) => {
    if (!fromSetup(e)) return {};
    const c = gs.readConn(), s = c.setup || {};
    return { googleReady: googleReady(), previousUrl: (c.webappUrl && URL_RE.test(c.webappUrl)) ? c.webappUrl : (s.webappUrl || ''), email: s.email || '' };
  });
  ipcMain.handle('setup:google', async (e, o) => {
    if (!fromSetup(e) || !googleReady()) return { ok: false, message: '이 프로그램에서는 구글 설정을 쓸 수 없습니다.' };
    if (o && o.relogin) gs.forgetGoogle();
    try {
      const r = await gs.runSetup(CFG, { hint: String(o && o.hint || '').slice(0, 200), relogin: !!(o && o.relogin) },
        (step, state, msg) => { if (!e.sender.isDestroyed()) e.sender.send('setup:progress', { step, state, msg }); });
      setTimeout(() => loadWeb(r.webappUrl), 900);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code || 'ERR', message: err.message || String(err), detail: err.code && /^HTTP_|NETWORK|DEPLOY|CLOUD/.test(err.code) ? String(err.detail || '').slice(0, 400) : '' };
    }
  });
  ipcMain.on('setup:cancelLogin', (e) => { if (fromSetup(e)) gs.cancelLogin(); });
  ipcMain.on('setup:skipConsent', (e) => { if (fromSetup(e)) gs.skipConsent(); });
  ipcMain.on('setup:openApiSettings', (e) => { if (fromSetup(e)) shell.openExternal(gs.EP.userSettings); });
  ipcMain.on('setup:openWebapp', (e) => { const s = gs.readConn().setup || {}; if (fromSetup(e) && s.webappUrl) shell.openExternal(s.webappUrl); });
  ipcMain.handle('setup:connectUrl', (e, text) => {
    if (!fromSetup(e)) return { ok: false };
    const m = String(text).match(URL_RE);
    if (!m) return { ok: false, message: '학교 주소를 찾지 못했습니다. https://script.google.com/ 으로 시작하고 /exec 로 끝나는 주소를 붙여넣어 주세요.' };
    const c = gs.readConn(); c.mode = 'web'; c.webappUrl = m[0]; gs.writeConn(c);
    loadWeb(m[0]);
    return { ok: true };
  });
  // 복사해 둔 안내문에서 학교 주소와 학교 이름만 찾아 돌려줌 (설정 화면에서만, 다른 내용은 쓰지 않음)
  ipcMain.handle('setup:clipboard', (e) => {
    if (!fromSetup(e)) return null;
    const t = String(clipboard.readText() || '').slice(0, 20000), m = t.match(URL_RE);
    if (!m) return null;
    const n = t.match(/\[([^\]\n]{2,40}?)\s*최소 성취수준 보장지도/);
    return { url: m[0], school: n ? n[1].trim() : '' };
  });
  ipcMain.on('setup:useLocal', (e) => { if (!fromSetup(e)) return; const c = gs.readConn(); c.mode = 'local'; gs.writeConn(c); loadLocal(); });
  ipcMain.on('setup:usePrevious', (e) => {
    if (!fromSetup(e)) return;
    const c = gs.readConn(), u = (c.webappUrl && URL_RE.test(c.webappUrl)) ? c.webappUrl : (c.setup && c.setup.webappUrl);
    if (!u) return; c.mode = 'web'; c.webappUrl = u; gs.writeConn(c); loadWeb(u);
  });
}
function openSetup() {
  if (!win) return;
  const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['설정 화면 열기', '취소'], defaultId: 0, cancelId: 1, noLink: true,
    title: '학교 연결 설정', message: '학교 연결 설정 화면을 열까요?',
    detail: '구글 계정으로 학교 설정, 학교 주소 연결, 이 PC에서만 쓰기 중에서 다시 고를 수 있습니다.' + (WEBAPP_URL ? '\n입력한 내용은 이미 학교 구글 시트에 저장되어 있습니다.' : '') });
  if (r === 0) loadSetup();
}
// 관리자 PC: 프로그램이 업데이트되면 학교 서버 코드도 바꿈
async function updateServerCode() {
  try {
    const r = await gs.autoUpdateServer(CFG);
    if (r && r.updated && win && !win.isDestroyed()) win.setTitle(`${APP_TITLE} — 학교 서버를 ${r.version} 버전으로 업데이트했습니다`);
    if (r && r.updated) setTimeout(() => { if (win && !win.isDestroyed()) win.setTitle(APP_TITLE); }, 8000);
  } catch (e) { /* 다음 실행 때 다시 시도 */ }
}

// ── 중복 실행 방지 ─────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// ── 자동 업데이트 ─────────────────────────────────────────
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return; // 개발 실행 중에는 사용 안 함
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) { return; }

  if (CFG.updateChannel) autoUpdater.channel = CFG.updateChannel;   // 다른 학교용은 별도 업데이트 채널
  autoUpdater.autoDownload = false;          // 다운로드 전에 먼저 물어봄
  autoUpdater.autoInstallOnAppQuit = true;   // 받아 두면 다음 종료 때 자동 설치

  autoUpdater.on('update-available', async (info) => {
    if (downloading || updateReady) return;
    const notes = releaseNotesText(info.releaseNotes);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: '업데이트 알림',
      message: `새 버전(${info.version})이 있습니다.`,
      detail: `현재 버전: ${app.getVersion()}\n\n` + (notes ? `변경 내용:\n${notes}\n\n` : '') +
              '지금 내려받을까요? 작업 중인 내용은 그대로 두고 백그라운드에서 받습니다.',
      buttons: ['지금 받기', '나중에'],
      defaultId: 0, cancelId: 1, noLink: true
    });
    if (response === 0) {
      downloading = true;
      autoUpdater.downloadUpdate().catch(onUpdateError);
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      dialog.showMessageBox(win, { type: 'info', title: '업데이트 확인',
        message: '최신 버전을 사용 중입니다.', detail: `현재 버전: ${app.getVersion()}` });
    }
    manualCheck = false;
  });

  autoUpdater.on('download-progress', (p) => {
    if (win && !win.isDestroyed()) {
      win.setProgressBar(p.percent / 100);
      win.setTitle(`${APP_TITLE} — 업데이트 받는 중 ${Math.round(p.percent)}%`);
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloading = false;
    updateReady = true;
    readyInfo = info;
    if (win && !win.isDestroyed()) { win.setProgressBar(-1); win.setTitle(APP_TITLE); }
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: '업데이트 준비 완료',
      message: `새 버전(${info.version}) 설치 준비가 끝났습니다.`,
      detail: '지금 다시 시작하면 바로 적용됩니다.\n\n' +
              '※ 이수 관리와 선정 명단은 자동 저장되어 그대로 남습니다. 가정통신문에서 직접 고친 문구는 저장되지 않습니다.\n' +
              '"나중에"를 누르면 프로그램을 종료할 때 자동으로 설치됩니다.',
      buttons: ['지금 다시 시작', '나중에'],
      defaultId: 1, cancelId: 1, noLink: true
    });
    if (response === 0) {
      quitting = true;
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
  });

  autoUpdater.on('error', onUpdateError);

  const check = () => autoUpdater.checkForUpdates().catch(onUpdateError);
  setTimeout(check, 3000);
  setInterval(() => { if (!downloading && !updateReady) check(); }, CHECK_INTERVAL_MS);
}

function onUpdateError(err) {
  downloading = false;
  if (win && !win.isDestroyed()) { win.setProgressBar(-1); win.setTitle(APP_TITLE); }
  // 인터넷이 끊겨 있을 때 등 자동 확인 실패는 조용히 넘어감. 직접 확인했을 때만 알림.
  if (manualCheck) {
    dialog.showMessageBox(win, { type: 'warning', title: '업데이트 확인 실패',
      message: '업데이트 서버에 연결하지 못했습니다.',
      detail: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.\n\n' + String(err && err.message || err).slice(0, 300) });
  }
  manualCheck = false;
}

function releaseNotesText(n) {
  if (!n) return '';
  if (Array.isArray(n)) n = n.map(x => x.note || '').join('\n');
  return String(n).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim().slice(0, 800);
}

function manualUpdateCheck() {
  if (!autoUpdater) {
    dialog.showMessageBox(win, { type: 'info', title: '업데이트 확인',
      message: '개발 모드에서는 업데이트 확인을 사용할 수 없습니다.' });
    return;
  }
  if (updateReady) { autoUpdater.emit('update-downloaded', readyInfo); return; }
  if (downloading) {
    dialog.showMessageBox(win, { type: 'info', title: '업데이트', message: '업데이트를 받는 중입니다. 잠시만 기다려 주세요.' });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(onUpdateError);
}

// ── 창 ───────────────────────────────────────────────────
function create() {
  win = new BrowserWindow({
    width: 1400, height: 900, show: false, title: APP_TITLE,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // 인터넷이 끊겼을 때 안내 화면
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !WEBAPP_URL || !isGoogle(url)) return;
    const html = '<meta charset="utf-8"><body style="font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;background:#f4f5f7;color:#1c2433">' +
      '<div style="text-align:center;line-height:1.8"><div style="font-size:20px;font-weight:700">학교 서버에 연결하지 못했습니다</div>' +
      '<div style="color:#667085">인터넷 연결을 확인한 뒤 다시 시도해 주세요.' + (GENERIC ? '<br>주소를 바꾸려면 위쪽 메뉴 [파일] → [학교 연결 설정]을 누르세요.' : '') + '</div>' +
      '<button onclick="location.href=\'' + WEBAPP_URL + '\'" style="margin-top:14px;padding:10px 20px;border:0;border-radius:8px;background:#5b3d99;color:#fff;font-size:15px;cursor:pointer">다시 시도</button></div></body>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
  if (GENERIC) {
    const c = gs.readConn();
    if (c.mode === 'web' && URL_RE.test(c.webappUrl || '')) loadWeb(c.webappUrl);
    else if (c.mode === 'local') loadLocal();
    else loadSetup();
  } else if (WEBAPP_URL) loadWeb(WEBAPP_URL);
  else loadLocal();
  win.on('page-title-updated', (e) => e.preventDefault());
  wireWindow();
}

function loadSetup() { WEBAPP_URL = ''; win.loadFile(path.join(__dirname, 'setup.html')); }
function loadLocal() { WEBAPP_URL = ''; win.loadFile(path.join(__dirname, LOCAL_PAGE)); }
function loadWeb(url) {
  WEBAPP_URL = url;
  {
    // 웹앱이 뜨기 전까지 빈 창 대신 안내 화면을 보여 주고, 곧바로 웹앱으로 넘어감
    const splash = '<meta charset="utf-8"><style>@keyframes s{to{transform:rotate(360deg)}}</style>' +
      '<body style="margin:0;font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f4f5f7;color:#1c2433">' +
      '<div style="text-align:center"><div style="width:34px;height:34px;margin:0 auto 16px;border:3px solid #d9cff0;border-top-color:#5b3d99;border-radius:50%;animation:s .8s linear infinite"></div>' +
      '<div style="font-size:17px;font-weight:700">학교 서버에 연결하는 중입니다…</div>' +
      '<div style="color:#667085;margin-top:6px;font-size:13px">처음 열 때는 몇 초 걸릴 수 있습니다.</div></div>' +
      '<script>setTimeout(function(){ location.replace(' + JSON.stringify(WEBAPP_URL) + '); }, 50)</script></body>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splash));
  }
}

function wireWindow() {
  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || url.startsWith('data:') || (WEBAPP_URL && isGoogle(url))) return;
    e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 엑셀 다운로드: 저장 위치를 묻는 창 표시
  win.webContents.session.on('will-download', (e, item) => {
    item.setSaveDialogOptions({ title: '파일 저장', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });

  win.on('close', (e) => {
    if (quitting) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['종료', '취소'], defaultId: 1, cancelId: 1, noLink: true,
      title: '종료 확인', message: '프로그램을 종료할까요?',
      detail: (WEBAPP_URL ? '입력한 내용은 학교 구글 시트에 자동 저장됩니다.' : '이수 관리와 선정 명단은 자동 저장됩니다.') +
              '\n가정통신문에서 직접 고친 문구는 저장되지 않으니 필요하면 먼저 인쇄해 두세요.' +
              (updateReady ? '\n\n종료하면 받아 둔 새 버전이 자동으로 설치됩니다.' : '')
    });
    if (r === 1) e.preventDefault(); else quitting = true;
  });
  win.on('closed', () => { win = null; });
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: '파일', submenu: [
    ...(GENERIC ? [{ label: '학교 연결 설정…', click: openSetup }, { type: 'separator' }] : []),
    { label: '데이터 폴더 열기', click: () => { fs.mkdirSync(dataDir(), { recursive: true }); shell.openPath(app.getPath('userData')); } },
    { role: 'reload', label: '새로고침' },
    { type: 'separator' },
    { role: 'quit', label: '종료' }
  ] },
  { label: '보기', submenu: [
    { role: 'zoomIn', label: '확대', accelerator: 'CmdOrCtrl+=' },
    { role: 'zoomOut', label: '축소' },
    { role: 'resetZoom', label: '원래 크기' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: '전체 화면' }
  ] },
  { label: '도움말', submenu: [
    { label: '업데이트 확인', click: manualUpdateCheck },
    { label: '버전 정보', click: () => dialog.showMessageBox(win, {
        type: 'info', title: '버전 정보', message: APP_TITLE, detail: `버전 ${app.getVersion()}` }) }
  ] }
]));

// 시험용: 모의 구글 서버로 보내기 (개발 실행 + 환경변수가 있을 때만)
const MOCK = !app.isPackaged && process.env.ISU_GOOGLE_MOCK ? process.env.ISU_GOOGLE_MOCK.replace(/\/$/, '') : '';
app.whenReady().then(() => {
  if (MOCK) protocol.handle('https', async (rq) => {
    const u = new URL(rq.url);
    if (u.hostname !== 'script.google.com') return net.fetch(rq, { bypassCustomProtocolHandlers: true });
    const r = await net.fetch(MOCK + '/webapp' + u.pathname + u.search, { bypassCustomProtocolHandlers: true });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/html' } });
  });
  if (GENERIC) setupIpc();
  dailyBackup(); create(); setupUpdater();
  if (GENERIC) setTimeout(updateServerCode, 5000);
});
app.on('window-all-closed', () => app.quit());
