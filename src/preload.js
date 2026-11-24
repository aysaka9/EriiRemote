const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eriiApi', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  getPeers: () => ipcRenderer.invoke('get-peers'),
  getAppData: () => ipcRenderer.invoke('get-app-data'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  saveMeta: (patch) => ipcRenderer.invoke('save-meta', patch),
  connectRdp: (ip) => ipcRenderer.invoke('connect-rdp', ip),
  connectMoonlight: (ip) => ipcRenderer.invoke('connect-moonlight', ip),
  openSmb: (ip) => ipcRenderer.invoke('open-smb', ip),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openTerminal: (ip) => ipcRenderer.invoke('open-terminal', ip),
  pingDevice: (ip) => ipcRenderer.invoke('ping-device', ip),
  remotePower: (ip, action) => ipcRenderer.invoke('remote-power', { ip, action }),
  wakeDevice: (mac, onlinePeerIps) => ipcRenderer.invoke('wake-device', { mac, onlinePeerIps }),
  restartEngine: () => ipcRenderer.invoke('restart-engine')
});
