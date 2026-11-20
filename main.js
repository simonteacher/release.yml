const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_TITLE = '최소 성취수준 보장지도 시스템';
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
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('page-title-updated', (e) => e.preventDefault());

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
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
      detail: '이수 관리와 선정 명단은 자동 저장됩니다.\n가정통신문에서 직접 고친 문구는 저장되지 않으니 필요하면 먼저 인쇄해 두세요.' +
              (updateReady ? '\n\n종료하면 받아 둔 새 버전이 자동으로 설치됩니다.' : '')
    });
    if (r === 1) e.preventDefault(); else quitting = true;
  });
  win.on('closed', () => { win = null; });
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: '파일', submenu: [
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

app.whenReady().then(() => { dailyBackup(); create(); setupUpdater(); });
app.on('window-all-closed', () => app.quit());
