const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shelf', {
  load: () => ipcRenderer.invoke('lib:load'),
  pick: () => ipcRenderer.invoke('lib:pick'),
  removeRoot: r => ipcRenderer.invoke('lib:removeRoot', r),
  scan: full => ipcRenderer.invoke('lib:scan', !!full),
  forget: () => ipcRenderer.invoke('lib:forget'),
  cacheCover: (id, url) => ipcRenderer.invoke('cover:cache', id, url),
  cacheSpine: (id, url, kind) => ipcRenderer.invoke('spine:cache', id, url, kind),
  customArt: (id, kind) => ipcRenderer.invoke('art:custom', id, kind),
  resetArt: (id, kind) => ipcRenderer.invoke('art:reset', id, kind),
  jfConnect: (server, user, pw) => ipcRenderer.invoke('jf:connect', server, user, pw),
  jfSync: () => ipcRenderer.invoke('jf:sync'),
  jfDisconnect: () => ipcRenderer.invoke('jf:disconnect'),
  spotify: q => ipcRenderer.invoke('open:spotify', q),
  openWeb: (svc, q) => ipcRenderer.invoke('open:web', svc, q),
  lyrics: p => ipcRenderer.invoke('lyrics:get', p),
  lyricsOnline: m => ipcRenderer.invoke('lyrics:online', m),
  clearLyrics: () => ipcRenderer.invoke('lyrics:clear'),
  saveSettings: s => ipcRenderer.send('settings:save', s),
  patchMeta: p => ipcRenderer.send('meta:patch', p),
  on: (ch, fn) => ipcRenderer.on(ch, (_, d) => fn(d))
});
