const { app, BrowserWindow, dialog, ipcMain, protocol, net, nativeImage, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const path = require('path'), fs = require('fs'), fsp = fs.promises, { pathToFileURL } = require('url'), { Readable } = require('stream');
const S = require('./scanner');

// shelf:// serves covers and local artwork with CORS enabled, so WebGL can use them as textures from a file:// page
protocol.registerSchemesAsPrivileged([{ scheme: 'shelf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
// the app was renamed: keep using the old data folder (library, covers, settings) if it exists, so nothing has to be rebuilt
try { const old = path.join(app.getPath('appData'), 'Album Shelf'); if (fs.existsSync(old)) app.setPath('userData', old); } catch {}

let win = null, userDir, coversDir, bigDir, lyricsDir, spinesDir, discsDir;
let JC, JL, jfBusy = false;   // Jellyfin: connection (server, user, token) and the cached album list
const reader = S.makeReader();

// ---- small JSON stores in the user data folder (survive restarts, updates and the portable exe) ----
function store(file, def, delay = 900) {
  let data = null, t = null;
  const p = () => path.join(userDir, file);
  const write = () => { try { fs.mkdirSync(userDir, { recursive: true }); const tmp = p() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, p()); } catch (e) { console.error('save failed', file, e.message); } };
  return {
    load() { try { data = JSON.parse(fs.readFileSync(p(), 'utf8')); } catch { data = JSON.parse(JSON.stringify(def)); } return data; },
    get data() { return data; }, set data(v) { data = v; },
    save(now) { clearTimeout(t); if (now) write(); else t = setTimeout(write, delay); }
  };
}
let L, M, ST;   // library, per-album meta (colours, online art), settings

const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
let ALB = [], ALBMAP = new Map(), coverSet = new Set(), spineSet = new Set();

async function refreshCoverSet() { try { coverSet = new Set(await fsp.readdir(coversDir)); } catch { coverSet = new Set(); } }
async function refreshSpineSet() { try { spineSet = new Set(await fsp.readdir(spinesDir)); } catch { spineSet = new Set(); } }
function rebuild() { ALB = S.buildAlbums(L.data).concat((JL && JL.data.albums) || []); ALBMAP = new Map(ALB.map(a => [a.id, a])); }
const sigOf = () => S.fnv(ALB.map(a => a.id + ':' + a.tracks.length).join(','));
function payload() {
  return { sig: sigOf(), roots: L.data.roots, albums: ALB.map(a => ({ ...a, thumb: coverSet.has(a.id + '.jpg'), spc: spineSet.has(a.id + '.o.jpg') ? 'o' : spineSet.has(a.id + '.b.jpg') ? 'b' : null, m: M.data.albums[a.id] || null })) };
}

// ---- audio over shelf://a/ : same bytes as file://, but with CORS + Range, so the Web Audio equalizer may process it and seeking still works ----
const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };
async function audioResponse(req, p) {
  let st; try { st = await fsp.stat(p); } catch { return new Response('', { status: 404 }); }
  const size = st.size, h = { 'Content-Type': MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  if (!size) return new Response('', { status: 200, headers: { ...h, 'Content-Length': '0' } });
  let start = 0, end = size - 1, code = 200;
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (rg && (rg[1] || rg[2])) {
    if (rg[1] === '') start = Math.max(0, size - +rg[2]); else { start = +rg[1]; if (rg[2]) end = Math.min(size - 1, +rg[2]); }
    if (start > end || start >= size) return new Response('', { status: 416, headers: { ...h, 'Content-Range': `bytes */${size}` } });
    code = 206; h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  h['Content-Length'] = String(end - start + 1);
  return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), { status: code, headers: h });
}

// ---- online lyrics: LRCLIB (synced, falls back to its plain text) then lyrics.ovh (plain). Hits are cached on disk; misses are retried after a few days ----
const UA = () => `OpenCD/${app.getVersion()} (desktop music library)`;
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const simplify = s => s.replace(/\s*[\[(][^\])]*\b(feat|ft|with|remaster(ed)?|live|mono|stereo|version|edit|mix)\b[^\])]*[\])]/ig, '').replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|mono|stereo|single|radio edit).*$/i, '').trim();
async function getJson(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': UA() }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
async function lrclib(title, artist, album, dur) {
  const qs = o => new URLSearchParams(o).toString(), nt = norm(title), na = norm(artist);
  const text = r => r && !r.instrumental ? (r.syncedLyrics || r.plainLyrics || null) : null;
  // timings only fit one recording: pass the real length so a live / remastered / single edit with different timing is not picked
  if (artist && dur) { const r = await getJson('https://lrclib.net/api/get?' + qs({ track_name: title, artist_name: artist, ...(album ? { album_name: album } : {}), duration: Math.round(dur) })); if (r && r.syncedLyrics && !r.instrumental) return r.syncedLyrics; }
  if (artist && !dur) { const t = text(await getJson('https://lrclib.net/api/get?' + qs({ track_name: title, artist_name: artist, ...(album ? { album_name: album } : {}) }))); if (t) return t; }
  const list = await getJson('https://lrclib.net/api/search?' + qs(artist ? { track_name: title, artist_name: artist } : { track_name: title }));
  if (!Array.isArray(list)) return null;
  const ok = list.filter(r => norm(r.trackName) === nt && (!na || (norm(r.artistName) && (norm(r.artistName).includes(na) || na.includes(norm(r.artistName))))) && text(r));
  const gap = r => dur && r.duration ? Math.abs(r.duration - dur) : 0;
  const synced = ok.filter(r => r.syncedLyrics && gap(r) <= 4).sort((a, b) => gap(a) - gap(b))[0];   // closest in length wins
  if (synced) return synced.syncedLyrics;
  const plain = ok.find(r => r.plainLyrics);                                                           // a badly timed sync is worse than plain text
  return plain ? plain.plainLyrics : (!dur ? (ok[0] ? text(ok[0]) : null) : null);
}
async function ovh(title, artist) {
  if (!artist) return null;
  const j = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  const t = j && typeof j.lyrics === 'string' ? j.lyrics.replace(/^Paroles de la chanson[^\n]*\n/i, '').trim() : '';
  return t.length > 20 ? t : null;
}
async function onlineLyrics(m) {          // string = found, null = nobody has it, false = couldn't reach the sources
  const clip = s => typeof s === 'string' ? s.trim().slice(0, 200) : '';
  const title = clip(m && m.title), album = clip(m && m.album), dur = Number(m && m.duration) > 0 && Number(m.duration) < 7200 ? Number(m.duration) : 0; let artist = clip(m && m.artist);
  if (!title) return null;
  if (/^(various artists|unknown artist)$/i.test(artist)) artist = '';
  const only = m && (m.src === 'lrclib' || m.src === 'ovh') ? m.src : '';   // the person picked one online source
  const file = path.join(lyricsDir, S.fnv([title, artist, album, dur ? Math.round(dur) : ''].concat(only ? [only] : []).map(norm).join('|')) + '.json');
  try { const c = JSON.parse(await fsp.readFile(file, 'utf8')); if (c.t) return c.t; if (Date.now() - c.ts < 3 * 864e5) return null; } catch {}
  let found = null, tries = 0, failed = 0;
  outer: for (const ti of [...new Set([title, simplify(title)])].filter(Boolean)) {
    for (const f of only === 'lrclib' ? [lrclib] : only === 'ovh' ? [ovh] : [lrclib, ovh]) { tries++; try { found = await f(ti, artist, album, dur); } catch { failed++; } if (found) break outer; }
  }
  if (!found) { if (failed === tries) return false; if (failed) return null; }
  await fsp.mkdir(lyricsDir, { recursive: true }); await fsp.writeFile(file, JSON.stringify({ t: found, ts: Date.now() }));
  return found;
}

// ---- covers: embedded art or folder art -> small square jpgs, cached on disk ----
function toSquare(buf, size, q = 86) {
  const img = nativeImage.createFromBuffer(buf); if (img.isEmpty()) return null;
  const { width: w, height: h } = img.getSize(), s = Math.min(w, h);
  let im = w !== h ? img.crop({ x: Math.round((w - s) / 2), y: Math.round((h - s) / 2), width: s, height: s }) : img;
  if (s > size) im = im.resize({ width: size, height: size, quality: 'best' });
  return im.toJPEG(q);
}
async function makeCover(a, size) {
  if (a.jf) { const b = await jfImage(a); const j = b && toSquare(b, size); return j || null; }   // Jellyfin albums have no files here: the cover comes from the server
  for (const t of a.tracks.slice(0, 3)) { const b = await reader.picture(t.p); if (b) { const j = toSquare(b, size); if (j) return j; } }
  if (a.local.front) try { const j = toSquare(await fsp.readFile(a.local.front), size); if (j) return j; } catch {}
  return null;
}
let readyBatch = [], readyT = null;
const coverReady = id => { readyBatch.push(id); clearTimeout(readyT); readyT = setTimeout(() => { send('cover:ready', readyBatch); readyBatch = []; }, 400); };
async function thumbsPhase() {
  await refreshCoverSet();
  const need = ALB.filter(a => !coverSet.has(a.id + '.jpg') && !(M.data.albums[a.id] || {}).nt);
  if (!need.length) return;
  await fsp.mkdir(coversDir, { recursive: true });
  let n = 0, lastP = 0;
  await S.pool(need, 3, async a => {
    const j = await makeCover(a, 256);
    if (j) { await fsp.writeFile(path.join(coversDir, a.id + '.jpg'), j); coverSet.add(a.id + '.jpg'); coverReady(a.id); }
    else (M.data.albums[a.id] ||= {}).nt = 1;
    n++; const now = Date.now(); if (now - lastP > 200) { lastP = now; send('scan:progress', { text: `Preparing covers ${n} of ${need.length}`, pct: n / need.length * 100 }); }
  });
  M.save();
}
async function bigCover(id) {
  const out = path.join(bigDir, id + '.jpg'); if (fs.existsSync(out)) return out;
  const a = ALBMAP.get(id), thumb = path.join(coversDir, id + '.jpg');
  if (a) { const j = await makeCover(a, 720); if (j) { await fsp.mkdir(bigDir, { recursive: true }); await fsp.writeFile(out, j); return out; } }
  return fs.existsSync(thumb) ? thumb : null;
}


// ---- Jellyfin: albums from a Jellyfin server sit on the shelf next to your folders. The app talks to the server itself (the page never sees the token),
// songs are streamed through shelf://a/ so seeking and the equalizer keep working, and covers are cached on disk like any other ----
const hashStr = s => { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return x.toString(36); };
const jfNorm = s => { s = String(s || '').trim(); if (!s) return ''; if (!/^https?:\/\//i.test(s)) s = 'http://' + s; try { const u = new URL(s); return (u.protocol + '//' + u.host + u.pathname).replace(/\/+$/, ''); } catch { return ''; } };
const jfEnc = t => { try { if (safeStorage.isEncryptionAvailable()) return { token: safeStorage.encryptString(t).toString('base64'), enc: 1 }; } catch {} return { token: t, enc: 0 }; };
const jfTok = () => { try { const t = JC.data.token; if (!t) return ''; return JC.data.enc ? safeStorage.decryptString(Buffer.from(t, 'base64')) : t; } catch { return ''; } };
const jfHeaders = tok => ({
  'X-Emby-Authorization': `MediaBrowser Client="Open CD", Device="Desktop", DeviceId="${JC.data.deviceId}", Version="${app.getVersion()}"` + (tok ? `, Token="${tok}"` : ''),
  ...(tok ? { 'X-Emby-Token': tok } : {}), 'User-Agent': UA(), Accept: 'application/json'
});
const jfStatus = () => ({
  connected: !!(JC && JC.data.token), server: (JC && JC.data.server) || '', user: (JC && JC.data.user) || '',
  albums: JL ? JL.data.albums.length : 0, tracks: JL ? JL.data.albums.reduce((n, a) => n + a.tracks.length, 0) : 0, at: JL ? JL.data.at || 0 : 0, syncing: jfBusy
});
const jfState = () => send('jf:state', jfStatus());
async function jfImage(a) {
  if (!JC || !JC.data.token) return null;
  const ids = [a.jfi, a.tracks[0] && String(a.tracks[0].p).slice(3)].filter(x => /^[0-9a-f]{32}$/i.test(x || ''));
  for (const id of ids) {
    try { const r = await net.fetch(`${JC.data.server}/Items/${id}/Images/Primary?maxWidth=1000&quality=90`, { headers: jfHeaders(jfTok()), signal: AbortSignal.timeout(15000) }); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {}
  }
  return null;
}
async function jfAudio(req, id) {
  if (!/^[0-9a-f]{32}$/i.test(id) || !JC.data.token) return new Response('', { status: 404 });
  const h = jfHeaders(jfTok()), rg = req.headers.get('range'); if (rg) h.Range = rg;
  const r = await net.fetch(`${JC.data.server}/Audio/${id}/stream?static=true`, { headers: h });
  const o = new Headers({ 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' });
  for (const k of ['content-type', 'content-length', 'content-range']) { const v = r.headers.get(k); if (v) o.set(k, v); }
  return new Response(r.body, { status: r.status, headers: o });
}
async function jfLyrics(id) {     // the server's own lyrics (synced when it has timings), turned into the same text a .lrc file would hold
  try {
    const r = await net.fetch(`${JC.data.server}/Audio/${id}/Lyrics`, { headers: jfHeaders(jfTok()), signal: AbortSignal.timeout(8000) }); if (!r.ok) return null;
    const ls = ((await r.json()).Lyrics || []).filter(l => l && typeof l.Text === 'string'); if (!ls.length) return null;
    if (ls.some(l => l.Start != null)) return ls.map(l => { const t = (l.Start || 0) / 1e7, m = Math.floor(t / 60); return `[${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}]${l.Text}`; }).join('\n');
    return ls.map(l => l.Text).join('\n');
  } catch { return null; }
}
async function jfSync() {
  if (jfBusy || !JC.data.token) return;
  jfBusy = true; jfState(); send('scan:state', { on: true });
  try {
    const base = JC.data.server, hdr = jfHeaders(jfTok()), by = new Map(); let start = 0, total = Infinity;
    while (start < total) {
      send('scan:progress', { text: 'Reading Jellyfin library' + (isFinite(total) ? ` ${start.toLocaleString()} of ${total.toLocaleString()}` : '\u2026'), pct: isFinite(total) && total ? start / total * 100 : 0 });
      const r = await net.fetch(`${base}/Items?userId=${encodeURIComponent(JC.data.userId)}&IncludeItemTypes=Audio&Recursive=true&SortBy=SortName&SortOrder=Ascending&EnableTotalRecordCount=true&StartIndex=${start}&Limit=2000`, { headers: hdr, signal: AbortSignal.timeout(90000) });
      if (r.status === 401) { JC.data.token = ''; JC.save(true); send('scan:progress', { text: 'The Jellyfin session ended. Sign in again in Settings.' }); return; }
      if (!r.ok) throw new Error('Jellyfin answered ' + r.status);
      const j = await r.json(), items = j.Items || []; total = j.TotalRecordCount || 0; if (!items.length) break;
      for (const it of items) {
        const iid = String(it.Id || '').replace(/-/g, '').toLowerCase(); if (!/^[0-9a-f]{32}$/.test(iid)) continue;
        const artist = it.AlbumArtist || (it.AlbumArtists && it.AlbumArtists[0] && it.AlbumArtists[0].Name) || (it.Artists || [])[0] || 'Unknown Artist', album = it.Album || 'Unknown Album';
        const aid = String(it.AlbumId || '').replace(/-/g, '').toLowerCase(), key = /^[0-9a-f]{32}$/.test(aid) ? aid : 'x' + hashStr(album + '|' + artist);
        const id = 'jf' + key; let g = by.get(id);
        if (!g) by.set(id, g = { title: album, artist, year: it.ProductionYear || 0, jfi: /^[0-9a-f]{32}$/.test(aid) ? aid : iid, tracks: [] });
        g.tracks.push({ p: 'jf:' + iid, t: it.Name || 'Track', n: it.IndexNumber || 0, d: it.ParentIndexNumber || 1 });
      }
      start += items.length;
    }
    const albums = [];
    for (const [id, g] of by) {
      g.tracks.sort((x, y) => x.d - y.d || x.n - y.n || x.t.localeCompare(y.t));
      const multi = g.tracks.some(t => t.d > 1); let i = 0;
      albums.push({ id, title: g.title, artist: g.artist, year: g.year, tracks: g.tracks.map(t => ({ p: t.p, t: t.t, n: multi ? ++i : t.n })), local: {}, jf: 1, jfi: g.jfi });
    }
    JL.data = { albums, at: Date.now() }; JL.save(true); rebuild(); await refreshCoverSet(); send('lib:data', payload());
    await thumbsPhase();
  } catch (e) { console.error(e); send('scan:progress', { text: 'Could not reach Jellyfin right now. Your cached albums are still here.' }); }
  finally { jfBusy = false; send('scan:state', { on: false }); jfState(); }
}

// ---- scanning ----
let scanning = false, again = null;
async function runScan(full) {
  if (scanning) { again = again || full; return; }
  scanning = true; send('scan:state', { on: true });
  try {
    if (full) for (const k in M.data.albums) delete M.data.albums[k].nt;
    const before = sigOf();
    L.data.save = () => L.save(true);
    await S.scan(L.data, { full, onProgress: p => send('scan:progress', p) });
    L.save(true); rebuild(); await refreshCoverSet();
    if (full || sigOf() !== before) send('lib:data', payload());
    await thumbsPhase();
  } catch (e) { console.error(e); send('scan:progress', { text: 'Scan problem: ' + e.message }); }
  scanning = false; send('scan:state', { on: false });
  if (again !== null) { const f = again; again = null; runScan(f); }
}

// ---- window ----
function createWindow() {
  const b = ST.data.win || {};
  win = new BrowserWindow({
    width: b.w || 1280, height: b.h || 800, x: b.x, y: b.y, backgroundColor: '#14110f', autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  if (b.max) win.maximize();
  win.loadFile('index.html');
  // links the page asks to open go to the real browser (only our own three destinations), never into a new app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(github\.com\/txkex\/Open-CD|music\.youtube\.com\/search\?|open\.spotify\.com\/search\/|musicbrainz\.org\/search\?)/.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  const keep = () => { if (win.isDestroyed()) return; const n = win.getNormalBounds(); ST.data.win = { w: n.width, h: n.height, x: n.x, y: n.y, max: win.isMaximized() }; ST.save(); };
  win.on('resize', keep); win.on('move', keep); win.on('close', () => { keep(); ST.save(true); M.save(true); L.save(true); });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  userDir = app.getPath('userData'); coversDir = path.join(userDir, 'covers'); bigDir = path.join(userDir, 'covers-big'); lyricsDir = path.join(userDir, 'lyrics'); spinesDir = path.join(userDir, 'spines'); discsDir = path.join(userDir, 'discs');
  L = store('library.json', { v: 2, roots: [], files: {}, imgs: {} }); L.load();
  if (L.data.v !== 2) L.data = { v: 2, roots: L.data.roots || [], files: {}, imgs: {} };
  M = store('meta.json', { albums: {}, photos: {} }); M.load(); M.data.albums ||= {}; M.data.photos ||= {};
  ST = store('settings.json', {}); ST.load();
  JC = store('jellyfin.json', {}); JC.load(); JC.data.deviceId ||= crypto.randomUUID();
  JL = store('jellyfin-library.json', { albums: [], at: 0 }); JL.load(); if (!Array.isArray(JL.data.albums)) JL.data = { albums: [], at: 0 };

  const inside = (root, p) => { const r = path.relative(root, path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
  protocol.handle('shelf', async req => {
    try {
      const u = new URL(req.url), kind = u.hostname, id = path.basename(u.pathname, '.jpg');
      if (kind === 'a') {
        const p = u.searchParams.get('p');
        if (p && p.startsWith('jf:')) return await jfAudio(req, p.slice(3));
        if (!p || !S.AUD.test(p) || !L.data.roots.some(r => inside(r, p))) return new Response('', { status: 404 });
        return await audioResponse(req, p);
      }
      let file = null;
      if (kind === 'f') { const p = u.searchParams.get('p'); if (p && S.IMGX.test(p) && L.data.roots.some(r => inside(r, p))) file = p; }
      else if (kind === 'c' && /^[a-z0-9]+$/.test(id)) file = path.join(coversDir, id + '.jpg');
      else if (kind === 'b' && /^[a-z0-9]+$/.test(id)) file = await bigCover(id);
      else if (kind === 's' && /^[a-z0-9]+\.[ob]$/.test(id)) file = path.join(spinesDir, id + '.jpg');
      else if (kind === 'd' && /^[a-z0-9]+$/.test(id)) file = path.join(discsDir, id + '.jpg');   // the user's own disc print
      else if (kind === 'u' && /^[a-z0-9]+\.(back|tray|booklet)$/.test(id)) file = path.join(discsDir, id + '.jpg');   // the user's own back / inside pages
      if (!file || !fs.existsSync(file)) return new Response('', { status: 404 });
      const r = await net.fetch(pathToFileURL(file).toString()), h = new Headers(r.headers);
      h.set('Access-Control-Allow-Origin', '*');
      return new Response(r.body, { status: r.status, headers: h });
    } catch { return new Response('', { status: 500 }); }
  });

  ipcMain.handle('lib:load', async () => { rebuild(); await refreshCoverSet(); await refreshSpineSet(); return { ...payload(), settings: ST.data, photos: M.data.photos, jf: jfStatus() }; });
  ipcMain.handle('lib:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose music folders', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return false;
    for (const d of r.filePaths) if (!L.data.roots.includes(d)) L.data.roots.push(d);
    L.save(true); runScan(false); return true;
  });
  ipcMain.handle('lib:removeRoot', (_, r) => { L.data.roots = L.data.roots.filter(x => x !== r); L.save(true); runScan(false); return true; });
  ipcMain.handle('lib:scan', (_, full) => { runScan(!!full); jfSync(); return true; });
  ipcMain.handle('lib:forget', async () => {
    L.data = { v: 2, roots: [], files: {}, imgs: {} }; L.save(true); M.data = { albums: {}, photos: {} }; M.save(true);
    await fsp.rm(coversDir, { recursive: true, force: true }); await fsp.rm(bigDir, { recursive: true, force: true }); await fsp.rm(lyricsDir, { recursive: true, force: true }); await fsp.rm(spinesDir, { recursive: true, force: true }); await fsp.rm(discsDir, { recursive: true, force: true });
    JL.data = { albums: [], at: 0 }; JL.save(true); JC.data = { deviceId: JC.data.deviceId }; JC.save(true); jfState();
    rebuild(); coverSet = new Set(); spineSet = new Set(); return payload();
  });
  ipcMain.handle('cover:cache', async (_, id, url) => {          // online front cover -> same on-disk cache as embedded art
    try {
      if (!ALBMAP.has(id) || !/^https:\/\//.test(url)) return false;
      const r = await net.fetch(url); if (!r.ok) return false;
      const buf = Buffer.from(await r.arrayBuffer()), t = toSquare(buf, 256), big = toSquare(buf, 720);
      if (!t) return false;
      await fsp.mkdir(coversDir, { recursive: true }); await fsp.mkdir(bigDir, { recursive: true });
      await fsp.writeFile(path.join(coversDir, id + '.jpg'), t); if (big) await fsp.writeFile(path.join(bigDir, id + '.jpg'), big);
      coverSet.add(id + '.jpg'); return true;
    } catch { return false; }
  });
  // ---- the user's own artwork: front cover, back, inside pages and the printed disc ----
  const ART_KEY = { front: 'cu', disc: 'cd', back: 'cb', tray: 'ct', booklet: 'cl' };
  const artFile = (id, kind) => path.join(discsDir, kind === 'disc' ? id + '.jpg' : id + '.' + kind + '.jpg');
  const fitEdge = (buf, max, q = 90) => {
    const img = nativeImage.createFromBuffer(buf); if (img.isEmpty()) return null;
    const { width: w, height: h } = img.getSize(), k = Math.min(1, max / Math.max(w, h));
    return (k < 1 ? img.resize({ width: Math.round(w * k), height: Math.round(h * k), quality: 'best' }) : img).toJPEG(q);
  };
  const ART_TITLE = { front: 'front cover', disc: 'the disc', back: 'the back', tray: 'the inside tray', booklet: 'the inside page' };
  ipcMain.handle('art:custom', async (_, id, kind) => {
    try {
      if (!ALBMAP.has(id) || !ART_KEY[kind]) return null;
      const r = await dialog.showOpenDialog(win, { title: 'Choose artwork for ' + ART_TITLE[kind], properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      const st = await fsp.stat(r.filePaths[0]); if (st.size > 60e6) return { err: 'That image is too large.' };
      const buf = await fsp.readFile(r.filePaths[0]), now = Date.now(), m = (M.data.albums[id] ||= {});
      if (kind === 'front') {
        const t = toSquare(buf, 256), big = toSquare(buf, 720); if (!t || !big) return { err: 'That image could not be read.' };
        await fsp.mkdir(coversDir, { recursive: true }); await fsp.mkdir(bigDir, { recursive: true });
        await fsp.writeFile(path.join(coversDir, id + '.jpg'), t); await fsp.writeFile(path.join(bigDir, id + '.jpg'), big);
        coverSet.add(id + '.jpg'); delete m.nt; delete m.col;
      } else {
        const d = kind === 'disc' ? toSquare(buf, 1024, 92) : fitEdge(buf, 1400); if (!d) return { err: 'That image could not be read.' };
        await fsp.mkdir(discsDir, { recursive: true }); await fsp.writeFile(artFile(id, kind), d);
      }
      m[ART_KEY[kind]] = now; M.save(); return { ok: true, t: now };
    } catch { return { err: 'Could not save that artwork.' }; }
  });
  ipcMain.handle('art:reset', async (_, id, kind) => {    // back to the embedded / online artwork
    try {
      if (!ALBMAP.has(id) || !ART_KEY[kind]) return null;
      const m = (M.data.albums[id] ||= {}); let thumb = true;
      if (kind === 'front') {
        await fsp.rm(path.join(coversDir, id + '.jpg'), { force: true }); await fsp.rm(path.join(bigDir, id + '.jpg'), { force: true }); coverSet.delete(id + '.jpg'); delete m.col;
        const j = await makeCover(ALBMAP.get(id), 256);
        if (j) { await fsp.mkdir(coversDir, { recursive: true }); await fsp.writeFile(path.join(coversDir, id + '.jpg'), j); coverSet.add(id + '.jpg'); } else { thumb = false; m.nt = 1; }
      } else await fsp.rm(artFile(id, kind), { force: true });
      delete m[ART_KEY[kind]]; M.save(); return { ok: true, thumb };
    } catch { return null; }
  });
  ipcMain.handle('jf:connect', async (_, server, user, pw) => {
    try {
      server = jfNorm(server); user = typeof user === 'string' ? user.trim() : '';
      if (!server || !user) return { err: 'Enter the server address and your username.' };
      const r = await net.fetch(server + '/Users/AuthenticateByName', { method: 'POST', headers: { ...jfHeaders(''), 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: user, Pw: String(pw || '') }), signal: AbortSignal.timeout(15000) });
      if (r.status === 401 || r.status === 400) return { err: 'Wrong username or password.' };
      if (!r.ok) return { err: `The server answered ${r.status}. Is that address a Jellyfin server?` };
      const j = await r.json(); if (!j.AccessToken || !j.User) return { err: 'That does not look like a Jellyfin server.' };
      JC.data = { deviceId: JC.data.deviceId, server, user: j.User.Name || user, userId: j.User.Id, ...jfEnc(j.AccessToken) }; JC.save(true);
      jfSync(); return { ok: true, st: jfStatus() };
    } catch { return { err: 'Could not reach that server. Check the address and port (Jellyfin is usually on :8096).' }; }
  });
  ipcMain.handle('jf:sync', () => { jfSync(); return true; });
  ipcMain.handle('jf:disconnect', async () => {
    try { if (JC.data.token) await net.fetch(JC.data.server + '/Sessions/Logout', { method: 'POST', headers: jfHeaders(jfTok()), signal: AbortSignal.timeout(5000) }).catch(() => {}); } catch {}
    JC.data = { deviceId: JC.data.deviceId }; JC.save(true); JL.data = { albums: [], at: 0 }; JL.save(true); jfState();
    rebuild(); return payload();
  });
  ipcMain.handle('spine:cache', async (_, id, dataUrl, kind) => {   // finished shelf spine (official scan or built from the back insert) -> small jpg on disk
    try {
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
      if (!m || !ALBMAP.has(id) || (kind !== 'o' && kind !== 'b') || m[1].length > 2e6) return false;
      await fsp.mkdir(spinesDir, { recursive: true });
      await fsp.writeFile(path.join(spinesDir, id + '.' + kind + '.jpg'), Buffer.from(m[1], 'base64')); spineSet.add(id + '.' + kind + '.jpg');
      if (kind === 'o') { await fsp.rm(path.join(spinesDir, id + '.b.jpg'), { force: true }); spineSet.delete(id + '.b.jpg'); }
      return true;
    } catch { return false; }
  });
  ipcMain.handle('open:spotify', async (_, q) => {   // the Spotify app if it is installed, otherwise the web player, both on a search for the song
    q = typeof q === 'string' ? q.trim().slice(0, 200) : ''; if (!q) return false;
    try {
      if (app.getApplicationNameForProtocol('spotify://')) await shell.openExternal('spotify:search:' + encodeURIComponent(q));
      else await shell.openExternal('https://open.spotify.com/search/' + encodeURIComponent(q));
      return true;
    } catch { return false; }
  });
  ipcMain.handle('open:web', async (_, svc, q) => {   // GitHub link, or "open this song in ..." from the song menu. Apps are used when installed, the browser otherwise
    q = typeof q === 'string' ? q.trim().slice(0, 200) : '';
    const web = u => shell.openExternal(u);
    try {
      if (svc === 'github') { await web('https://github.com/txkex/Open-CD'); return true; }
      if (!q) return false;
      if (svc === 'musicbrainz') { await web('https://musicbrainz.org/search?query=' + encodeURIComponent(q) + '&type=recording&method=indexed'); return true; }
      if (svc === 'youtube') { await web('https://music.youtube.com/search?q=' + encodeURIComponent(q)); return true; }   // YouTube Music has no app link of its own: the browser (or its installed web app) handles it
      if (svc === 'spotify') {
        let app_ = false;
        try { if (app.getApplicationNameForProtocol('spotify://')) { await web('spotify:search:' + encodeURIComponent(q)); app_ = true; } } catch {}
        if (!app_) await web('https://open.spotify.com/search/' + encodeURIComponent(q));
        return true;
      }
    } catch {}
    return false;
  });
  ipcMain.handle('lyrics:get', async (_, p) => {              // sidecar .lrc next to the song (same name, any letter case); Jellyfin songs ask the server
    if (typeof p === 'string' && p.startsWith('jf:')) return /^[0-9a-f]{32}$/i.test(p.slice(3)) && JC.data.token ? await jfLyrics(p.slice(3)) : null;
    try {
      if (!S.AUD.test(p) || !L.data.roots.some(r => inside(r, p))) return null;
      const dir = path.dirname(p), want = path.basename(p).replace(/\.[^.]+$/, '').toLowerCase() + '.lrc';
      const hit = (await fsp.readdir(dir)).find(f => f.toLowerCase() === want); if (!hit) return null;
      const buf = await fsp.readFile(path.join(dir, hit)); if (buf.length > 512 * 1024) return null;
      let t = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
      if (t.includes('\ufffd')) t = buf.toString('latin1');
      return t.replace(/^\ufeff/, '');
    } catch { return null; }
  });
  ipcMain.handle('lyrics:online', async (_, m) => { try { return await onlineLyrics(m); } catch { return false; } });
  ipcMain.handle('lyrics:clear', async () => { await fsp.rm(lyricsDir, { recursive: true, force: true }); return true; });
  ipcMain.on('settings:save', (_, s) => { Object.assign(ST.data, s); ST.save(); });
  ipcMain.on('meta:patch', (_, p) => {
    for (const [id, v] of Object.entries(p.albums || {})) if (ALBMAP.has(id)) Object.assign(M.data.albums[id] ||= {}, v);
    Object.assign(M.data.photos, p.photos || {}); M.save();
  });

  createWindow();
  if (JC.data.token) win.webContents.once('did-finish-load', () => setTimeout(jfSync, 1200));
});
app.on('window-all-closed', () => app.quit());
