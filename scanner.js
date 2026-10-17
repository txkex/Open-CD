// Library scanner: walks folders, reads tags (cached by size+mtime), groups tracks into albums.
// Pure Node (no Electron) so it can be tested on its own.
const fs = require('fs'), fsp = fs.promises, path = require('path');

const AUD = /\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i, IMGX = /\.(jpe?g|png|webp)$/i;
const kindOf = n => /spine/i.test(n) ? 'spine' : /(booklet|inlay|inside|inner|insert|liner)/i.test(n) ? 'booklet' : /tray/i.test(n) ? 'tray'
  : /(^|[^a-z])(cd|disc|disk|medium)[ _-]?\d*\.[a-z]+$/i.test(n) ? 'medium' : /(back|rear)/i.test(n) ? 'back'
  : /(band|artist|group|photo|portrait)/i.test(n) ? 'photo' : /(cover|folder|front|album)/i.test(n) ? 'front' : null;
const stripDisc = s => s.replace(/\s*[\[(]\s*(disc|cd|disk)\s*\d+[^\])]*[\])]/ig, '').replace(/\s*[-–:,]?\s*(disc|cd|disk)\s*\d+\s*$/i, '').trim();
const DISCDIR = /^(?:cd|disc|disk)[\s_-]*\d+/i;
const baseDir = d => DISCDIR.test(path.basename(d)) ? path.dirname(d) : d;   // "Album/CD 2" belongs to "Album"
const natural = (x, y) => x.localeCompare(y, undefined, { numeric: true });

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch {} }
  }));
}

// jsmediatags in Node: reads only the tag bytes it needs, never the whole file
const TAGS = ['title', 'artist', 'album', 'year', 'track', 'TPE2', 'TPOS', 'aART', 'ALBUMARTIST', 'disk', 'DISCNUMBER'];
function makeReader() {
  const jsmt = require('jsmediatags');
  const run = (p, tags) => new Promise(res => {
    let done = false; const fin = t => { if (!done) { done = true; clearTimeout(to); res(t || {}); } };
    const to = setTimeout(() => fin({}), 20000);
    try { const r = new jsmt.Reader(p); if (tags) r.setTagsToRead(tags); r.read({ onSuccess: t => fin(t.tags), onError: () => fin({}) }); } catch { fin({}); }
  });
  return { tags: p => run(p, TAGS), picture: p => run(p, ['picture']).then(t => t.picture ? Buffer.from(t.picture.data) : null) };
}
const val = v => v == null ? '' : typeof v === 'object' ? (v.data != null ? String(v.data) : '') : String(v);

async function walk(root, dirs, tick) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop(); let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const rec = { audio: [], imgs: {} };
    for (const e of ents) {
      if (e.name[0] === '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (AUD.test(e.name)) rec.audio.push(full);
      else if (IMGX.test(e.name)) { const k = kindOf(e.name); if (k) (rec.imgs[k] ||= []).push(full); }
    }
    if (rec.audio.length || Object.keys(rec.imgs).length) dirs.set(dir, rec);
    if (tick) tick(dirs.size);
  }
}

// db = { v, roots:[], files:{path:{m,s,t,ar,al,y,d,n}}, imgs:{dir:{kind:[paths]}} }
async function scan(db, { full = false, onProgress = () => {}, reader } = {}) {
  reader = reader || makeReader();
  const live = [];                                            // roots we can actually reach right now (an unplugged drive must not wipe its albums)
  for (const r of db.roots) { try { await fsp.access(r); live.push(r); } catch {} }
  const dirs = new Map(); let lastTick = 0;
  for (const r of live) await walk(r, dirs, n => { const t = Date.now(); if (t - lastTick > 150) { lastTick = t; onProgress({ text: `Looking for music… ${n} folders` }); } });

  const audio = []; for (const rec of dirs.values()) audio.push(...rec.audio);
  const seen = new Set(audio), todo = [];
  let sd = 0;
  await pool(audio, 64, async p => {
    const st = await fsp.stat(p), old = db.files[p];
    if (!full && old && old.m === Math.round(st.mtimeMs) && old.s === st.size) return;
    todo.push([p, Math.round(st.mtimeMs), st.size]);
    if (++sd % 500 === 0) onProgress({ text: `Checking files… ${sd}` });
  });

  let n = 0, lastSave = 0, lastP = 0;
  await pool(todo, 12, async ([p, m, s]) => {
    const t = await reader.tags(p);
    const album = val(t.album).trim(), title = val(t.title).trim();
    const artist = val(t.TPE2).trim() || val(t.aART).trim() || val(t.ALBUMARTIST).trim() || val(t.artist).trim();
    db.files[p] = { m, s, t: title, ar: artist, al: album, y: val(t.year).trim().slice(0, 4), d: parseInt(val(t.TPOS) || val(t.disk) || val(t.DISCNUMBER)) || 0, n: parseInt(val(t.track)) || 0 };
    n++; const now = Date.now();
    if (now - lastP > 120) { lastP = now; onProgress({ text: `Reading tags ${n} of ${todo.length}`, pct: n / todo.length * 100 }); }
    if (n - lastSave >= 2000 && db.save) { lastSave = n; db.save(); }       // a long first scan survives being closed
  });

  const under = (root, p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
  for (const p of Object.keys(db.files)) {
    if (seen.has(p)) continue;
    if (live.some(r => under(r, p)) || !db.roots.some(r => under(r, p))) delete db.files[p];   // gone from a reachable root, or its root was removed
  }
  const imgs = {};
  for (const [d, rec] of dirs) if (Object.keys(rec.imgs).length) imgs[d] = rec.imgs;
  for (const [d, v] of Object.entries(db.imgs || {})) if (!live.some(r => under(r, d)) && db.roots.some(r => under(r, d))) imgs[d] = v;
  db.imgs = imgs;
  return { changed: todo.length, tracks: Object.keys(db.files).length };
}

const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };

function buildAlbums(db) {
  const by = new Map();
  for (const [p, f] of Object.entries(db.files)) {
    const dir = path.dirname(p), base = baseDir(dir), folder = path.basename(base) || 'Unknown album';
    const raw = f.al || folder, title = stripDisc(raw) || raw;
    const key = title.toLowerCase().replace(/\s+/g, ' ') + '|' + base.toLowerCase();
    let a = by.get(key);
    if (!a) { a = { key, title, dir: base, year: 0, tracks: [], who: {} }; by.set(key, a); }
    const ar = f.ar || 'Unknown Artist';
    a.who[ar] = (a.who[ar] || 0) + 1;
    if (!a.year && f.y) a.year = parseInt(f.y) || 0;
    a.tracks.push({ p, d: f.d, n: f.n, t: f.t || path.basename(p).replace(/\.[^.]+$/, ''), dir });
  }
  const imgDirs = Object.keys(db.imgs || {}), ids = new Set(), out = [];
  for (const a of by.values()) {
    const known = Object.entries(a.who).filter(e => e[0] !== 'Unknown Artist'), all = Object.values(a.who).reduce((x, y) => x + y, 0);
    known.sort((x, y) => y[1] - x[1]);
    a.artist = !known.length ? 'Unknown Artist' : known.length > 1 && known[0][1] < all * 0.5 ? 'Various Artists' : known[0][0];
    a.tracks.sort((x, y) => x.d - y.d || natural(x.dir, y.dir) || x.n - y.n || natural(x.t, y.t));
    const local = {}, pre = a.dir + path.sep;
    for (const d of [a.dir, ...imgDirs.filter(k => k !== a.dir && k.startsWith(pre))]) {
      const m = db.imgs[d]; if (!m) continue;
      for (const k in m) if (!local[k]) { const l = m[k].slice().sort(natural); local[k] = k === 'booklet' ? (l[1] || l[0]) : l[0]; }
    }
    let id = fnv(a.key); while (ids.has(id)) id += 'x'; ids.add(id);
    out.push({ id, title: a.title, artist: a.artist, year: a.year, local, tracks: a.tracks.map((t, i) => ({ p: t.p, n: t.n, t: t.t })) });
  }
  out.sort((x, y) => natural(x.artist, y.artist) || natural(x.title, y.title));
  return out;
}

module.exports = { scan, buildAlbums, makeReader, pool, AUD, IMGX, kindOf, stripDisc, fnv };
