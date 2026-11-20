// 화면(index.html)이 PC 저장소를 쓸 수 있게 최소한의 기능만 열어 줌
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appStore', {
  kind: 'desktop',
  load: () => ipcRenderer.invoke('store:load'),
  save: (text) => ipcRenderer.invoke('store:save', String(text)),
  saveSync: (text) => ipcRenderer.sendSync('store:saveSync', String(text)),
  openFolder: () => ipcRenderer.invoke('store:openFolder')
});
