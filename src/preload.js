const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eriiApi', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  getPeers: () => ipcRenderer.invoke('get-peers'),
  getAppData: () => ipcRenderer.invoke('get-app-data'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  saveMeta: (patch) => ipcRenderer.invoke('save-meta', patch),
  connectRdp: (ip, hostname) => ipcRenderer.invoke('connect-rdp', { ip, hostname }),
  connectMoonlight: (ip) => ipcRenderer.invoke('connect-moonlight', ip),
  openSmb: (ip) => ipcRenderer.invoke('open-smb', ip),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openTerminal: (ip) => ipcRenderer.invoke('open-terminal', ip),
  pingDevice: (ip) => ipcRenderer.invoke('ping-device', ip),
  remotePower: (ip, action) => ipcRenderer.invoke('remote-power', { ip, action }),
  wakeDevice: (mac, onlinePeerIps) => ipcRenderer.invoke('wake-device', { mac, onlinePeerIps }),
  restartEngine: () => ipcRenderer.invoke('restart-engine'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  openShareDir: () => ipcRenderer.invoke('open-share-dir'),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
  listRemoteFiles: (ip) => ipcRenderer.invoke('list-remote-files', ip),
  uploadFilesToPeer: (ip, filePaths) => ipcRenderer.invoke('upload-files-to-peer', { ip, filePaths }),
  downloadFileFromPeer: (ip, name) => ipcRenderer.invoke('download-file-from-peer', { ip, name }),
  deleteRemoteFile: (ip, name) => ipcRenderer.invoke('delete-remote-file', { ip, name }),
  onFileTransferProgress: (cb) => ipcRenderer.on('file-transfer-progress', (_e, s) => cb(s))
});
