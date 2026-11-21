// 화면(index.html)이 PC 저장소를 쓸 수 있게 최소한의 기능만 열어 줌
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appStore', {
  kind: 'desktop',
  load: () => ipcRenderer.invoke('store:load'),
  save: (text) => ipcRenderer.invoke('store:save', String(text)),
  saveSync: (text) => ipcRenderer.sendSync('store:saveSync', String(text)),
  openFolder: () => ipcRenderer.invoke('store:openFolder'),
  printPreview: (html) => ipcRenderer.send('print:preview', String(html))
});

// 웹앱(구글 서버 화면) 안에서 인쇄를 누르면 PDF 미리보기 창으로 보냄
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.__isuPrint) return;
  if (!/^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/i.test(e.origin)) return;
  if (d.__isuPrint === 'ping' && e.source) e.source.postMessage({ __isuPrint: 'pong' }, e.origin);
  else if (d.__isuPrint === 'job' && typeof d.html === 'string') ipcRenderer.send('print:preview', d.html);
});

// 처음 설정 화면(setup.html)에서만 쓰는 기능 (다른 학교용 프로그램)
if (location.protocol === 'file:' && /\/setup\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('isuSetup', {
    info: () => ipcRenderer.invoke('setup:info'),
    google: (o) => ipcRenderer.invoke('setup:google', o || {}),
    cancelLogin: () => ipcRenderer.send('setup:cancelLogin'),
    skipConsent: () => ipcRenderer.send('setup:skipConsent'),
    openApiSettings: () => ipcRenderer.send('setup:openApiSettings'),
    openWebapp: () => ipcRenderer.send('setup:openWebapp'),
    connectUrl: (u) => ipcRenderer.invoke('setup:connectUrl', String(u || '')),
    useLocal: () => ipcRenderer.send('setup:useLocal'),
    usePrevious: () => ipcRenderer.send('setup:usePrevious'),
    onProgress: (cb) => ipcRenderer.on('setup:progress', (e, p) => cb(p))
  });
}
