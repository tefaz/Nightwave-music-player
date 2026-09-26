const { contextBridge, ipcRenderer } = require('electron');
let scanSequence = 0;
function scan(channel, args, onProgress) {
  const requestId = ++scanSequence;
  const listener = (_event, progress) => { if (progress.requestId === requestId) onProgress?.(progress); };
  ipcRenderer.on('music:scan-progress', listener);
  return ipcRenderer.invoke(channel, ...args, requestId).finally(() => ipcRenderer.removeListener('music:scan-progress', listener));
}
contextBridge.exposeInMainWorld('electronAPI', {
  pickMusicFolder: onProgress => scan('music:pick-folder', [], onProgress),
  refreshMusicFolders: (directories, onProgress) => scan('music:refresh-folders', [directories], onProgress),
  readTrack: filePath => ipcRenderer.invoke('music:read-track', filePath),
  showInFolder: filePath => ipcRenderer.invoke('music:show-in-folder', filePath),
  startExternalDrag: filePath => ipcRenderer.send('music:start-external-drag', filePath),
  fileUrl: filePath => ipcRenderer.invoke('music:file-url', filePath),
  findLyrics: track => ipcRenderer.invoke('music:find-lyrics', track),
  writeTags: values => ipcRenderer.invoke('music:write-tags', values),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onPlaybackCommand: callback => { const listener=(_event,command)=>callback(command);ipcRenderer.on('playback:command',listener);return ()=>ipcRenderer.removeListener('playback:command',listener); },
  onWindowMaximized: callback => { const listener=(_event,maximized)=>callback(maximized);ipcRenderer.on('window:maximized',listener);return ()=>ipcRenderer.removeListener('window:maximized',listener); },
  syncToPhone: (request, onProgress) => { const listener=(_event,progress)=>onProgress?.(progress);ipcRenderer.on('music:sync-progress',listener);return ipcRenderer.invoke('music:sync-to-phone',request).finally(()=>ipcRenderer.removeListener('music:sync-progress',listener)); }
});
