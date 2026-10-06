/* ============================================================
   Savefile Runner: browser front end (loader, WebGL renderer, audio clock, input, practice tools).
   Nothing from any level, song, or game art ships with this page; everything is read
   from files the player picks on their own computer, in this tab only.
   ============================================================ */
'use strict';
(function () {
const C = Core;
const $ = s => document.querySelector(s);
const CLASS_TAB = window.__CLASS_TAB, RENDER_TAB = window.__RENDER_TAB;

/* ---------------- state ---------------- */
const S = {
  xml: null, levels: [], level: null, L: null, sim: null,
  songFiles: new Map(), songBuffer: null, songName: '',
  sheets: [], frames: new Map(), fntFiles: new Map(), fontPngs: new Map(), font: null,  // frame name -> {tex, u0,v0,u1,v1, w,h, ox,oy, rot}
  practice: false, noclip: false, hitboxes: false, showDeco: true, ldm: false, safe: false,
  startIndex: -1, attempts: 0, checkpoints: [], running: false,
  deathAt: 0, best: 0, flash: 0, noclipHits: 0,
};

/* ---------------- gunzip via the browser ---------------- */
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

/* ---------------- file intake ---------------- */
const status = (msg, kind) => { const el = $('#status'); el.textContent = msg; el.dataset.kind = kind || ''; };

// Accepts loose files or whole folders (the GeometryDash save folder and the game's Resources folder).
// Only the files the player needs are read; everything else is ignored by name.
const WANT_ART = /^(GJ_GameSheet(0[234]|Glow)?|FireSheet_01|bigFont|gjFont\d\d)(-u?hd)?$/i;
async function takeFiles(list) {
  const files = [...list];
  const plists = new Map(), pngs = new Map(), levelFiles = [];
  let songs = 0;
  const names = new Set(files.map(f => f.name.toLowerCase()));
  for (const f of files) {
    const n = f.name.toLowerCase(), base = f.name.replace(/\.[^.]+$/, '');
    if (/\.(mp3|ogg|wav|m4a)$/.test(n)) { S.songFiles.set(base, f); songs++; }
    else if (n.endsWith('.plist') && WANT_ART.test(base)) plists.set(base, f);
    else if (n.endsWith('.png') && WANT_ART.test(base)) pngs.set(base, f);
    else if (n.endsWith('.fnt') && WANT_ART.test(base)) S.fntFiles.set(base.toLowerCase(), f);
    else if (n.endsWith('.gmd')) levelFiles.push(f);
    else if (/^cc(gamemanager|locallevels)(2)?\.dat$/.test(n)) {
      // the "2" files are the game's backups: only use one when the main file is missing
      if (/2\.dat$/.test(n) && names.has(n.replace('2.dat', '.dat'))) continue;
      levelFiles.push(f);
    } else if (files.length < 6 && /\.(dat|txt|xml)$/.test(n)) levelFiles.push(f);   // a hand-picked level file
  }
  for (const f of levelFiles) await loadLevelFile(f);
  for (const [k, f] of pngs) S.fontPngs.set(k.toLowerCase(), f);
  if (plists.size) await loadSheets(plists, pngs);
  if (S.L) await loadFont(S.L.font);
  updateSongState();
  if (files.length > 20) {
    const bits = [];
    if (levelFiles.length) bits.push(`${S.levels.length} saved level${S.levels.length === 1 ? '' : 's'}`);
    if (songs) bits.push(`${songs} songs`);
    if (plists.size) bits.push(`${S.sheets.length} sprite sheets`);
    status(bits.length ? 'From the folder: ' + bits.join(', ') + '.'
      : "Nothing usable found in that folder. Add the GeometryDash folder and the game's Resources folder.", bits.length ? 'ok' : 'warn');
  }
}

// Walk folders dropped onto the page (skips Geode mod folders and other deep trees)
async function filesFromDrop(dt) {
  const out = [];
  const entries = [...(dt.items || [])].map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const SKIP = /^(geode|mods|unzipped|logs|crashlogs|temp|songs|sfx|icons|mapimages|levels)$/i;
  const walk = async (entry, depth) => {
    if (entry.isFile) { out.push(await new Promise((res, rej) => entry.file(res, rej))); return; }
    if (depth > 2 || (depth > 0 && SKIP.test(entry.name))) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, depth + 1);
    }
  };
  for (const e of entries) await walk(e, 0);
  return out;
}

function mergeLevels(list) {
  const seen = new Set(S.levels.map(l => l.id + '|' + l.name));
  for (const l of list) { const k = l.id + '|' + l.name; if (!seen.has(k)) { seen.add(k); S.levels.push(l); } }
  renderLevelList($('#search').value);
}

async function loadLevelFile(f) {
  status('Reading ' + f.name + '…', 'busy');
  const t0 = performance.now();
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const res = await C.decodeSaveFile(bytes, gunzip);
    if (res && res.rawLevel) {
      mergeLevels([{ id: 'file-' + f.name, name: f.name.replace(/\.[^.]+$/, ''), creator: '', songId: null, k4: res.rawLevel }]);
    } else {
      S.xml = res;
      mergeLevels(C.listLevels(res));
    }
    renderLevelList();
    status(`Read ${f.name} (${Math.round(performance.now() - t0)} ms). ${S.levels.length} level${S.levels.length === 1 ? '' : 's'} available.`, 'ok');
  } catch (e) {
    console.error(e);
    status(`Couldn't read ${f.name}. Pick CCGameManager.dat from %LOCALAPPDATA%\\GeometryDash, or a .gmd export.`, 'err');
  }
}

function renderLevelList(filter = '') {
  const ul = $('#levels'); ul.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const items = S.levels.filter(l => !q || l.name.toLowerCase().includes(q) || l.creator.toLowerCase().includes(q) || String(l.id).includes(q));
  for (const l of items) {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'lvl';
    b.innerHTML = `<span class="lvl-name"></span><span class="lvl-meta"></span>`;
    b.querySelector('.lvl-name').textContent = l.name;
    b.querySelector('.lvl-meta').textContent = [l.creator && 'by ' + l.creator, /^\d+$/.test(l.id) ? 'ID ' + l.id : ''].filter(Boolean).join(' · ');
    if (S.level && S.level === l) b.setAttribute('aria-pressed', 'true');
    b.onclick = () => selectLevel(l);
    li.appendChild(b); ul.appendChild(li);
  }
  $('#levelCount').textContent = S.levels.length ? `${items.length} of ${S.levels.length}` : '';
  $('#levelPanel').hidden = !S.levels.length;
  $('#noLevels').hidden = !!S.levels.length;
}

async function selectLevel(l) {
  status('Building ' + l.name + '…', 'busy');
  await new Promise(r => setTimeout(r, 20));
  const t0 = performance.now();
  try {
    const ls = await C.decodeLevelData(l.k4, gunzip);
    S.level = l; S.L = C.buildLevel(ls, CLASS_TAB, RENDER_TAB, { maxScale: 2.5 });
    precomputeRank(S.L); precomputeTimes(S.L);
    await loadFont(S.L.font);
    S.startIndex = -1; S.checkpoints = []; S.attempts = 0; S.best = 0;
    renderLevelList($('#search').value);
    renderStartPositions();
    updateSongState();
    $('#selName').textContent = l.name;
    $('#selMeta').textContent = `${S.L.n.toLocaleString()} objects · ${S.L.triggers.length.toLocaleString()} triggers · ${S.L.startPositions.length} start positions`;
    $('#selPanel').hidden = false;
    status(`Ready: ${l.name} (${Math.round(performance.now() - t0)} ms to build).`, 'ok');
  } catch (e) {
    console.error(e); status(`Couldn't build ${l.name}: ${e.message}`, 'err');
  }
}

function renderStartPositions() {
  const sel = $('#startPos'); sel.innerHTML = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add(-1, 'Level start (0%)');
  S.L.startPositions.forEach((i, k) => {
    const e = S.L.extra[i] || {};
    const mode = C.MODES[+e.kA2 || 0] || 'cube';
    add(k, `${Math.round(100 * S.L.x[i] / S.L.length)}% · ${mode}${e.kA3 === '1' ? ' (mini)' : ''}`);
  });
}

function updateSongState() {
  const el = $('#songState');
  if (!S.level) { el.textContent = 'Pick a level first.'; return; }
  const id = S.level.songId;
  const f = (id && S.songFiles.get(id)) || (S.songFiles.size === 1 ? [...S.songFiles.values()][0] : null);
  if (f) {
    if (S.songName !== f.name) loadSong(f);
    el.textContent = `Song: ${f.name}`; el.dataset.kind = 'ok';
  } else if (id && id !== '0') {
    el.textContent = `Add ${id}.mp3 from your GeometryDash folder for music. You can play without it.`; el.dataset.kind = 'warn';
  } else {
    el.textContent = 'This level uses a built-in song. Add the audio file if you have it, or play silent.'; el.dataset.kind = 'warn';
  }
}

async function loadSong(f) {
  S.songName = f.name;
  try {
    ensureAudio();
    S.songBuffer = await audio.ctx.decodeAudioData(await f.arrayBuffer());
  } catch (e) { console.error(e); S.songBuffer = null; $('#songState').textContent = `Couldn't decode ${f.name}.`; }
}

/* ---------------- sprite sheets (optional, from the player's own install) ---------------- */
async function loadSheets(plists, pngs) {
  status('Loading sprite sheets…', 'busy');
  // One quality per sheet: the sharpest pair (uhd > hd > normal) that this GPU can hold.
  // Loading every quality would overflow the renderer's texture slots and mix up sprites.
  const SHEETS = ['GJ_GameSheet', 'GJ_GameSheet02', 'GJ_GameSheet03', 'GJ_GameSheet04', 'GJ_GameSheetGlow', 'FireSheet_01'];
  const lower = m => new Map([...m].map(([k, v]) => [k.toLowerCase(), v]));
  const pl = lower(plists), pn = lower(pngs);
  const picks = [];
  for (const sheet of SHEETS) {
    for (const [suf, k] of [['-uhd', 4], ['-hd', 2], ['', 1]]) {
      const key = (sheet + suf).toLowerCase();
      if (!pl.has(key) || !pn.has(key)) continue;
      const bmp = await createImageBitmap(pn.get(key));
      if (bmp.width > R.maxTex || bmp.height > R.maxTex) { bmp.close && bmp.close(); continue; }
      picks.push({ name: sheet + suf, k, bmp, plist: pl.get(key) });
      break;
    }
  }
  if (!picks.length) {
    status('No GJ_GameSheet .png + .plist pairs found. Add both files of each pair.', 'warn');
    return;
  }
  R.resetTextures(); S.frames.clear();
  let count = 0;
  for (const p of picks) {
    const texIndex = R.addTexture(p.bmp);
    if (/Glow/i.test(p.name)) R.setGlowTex(texIndex);
    const xml = new DOMParser().parseFromString(await p.plist.text(), 'text/xml');
    const framesDict = dictGet(xml.querySelector('plist > dict'), 'frames');
    if (!framesDict) continue;
    const kids = [...framesDict.children];
    for (let i = 0; i < kids.length; i += 2) {
      const name = kids[i].textContent; const d = kids[i + 1];
      const rect = nums(dictText(d, 'textureRect') || dictText(d, 'frame'));
      const off = nums(dictText(d, 'spriteOffset') || dictText(d, 'offset') || '{0,0}');
      const rotEl = dictGet(d, 'textureRotated') || dictGet(d, 'rotated');
      const rot = !!rotEl && rotEl.tagName === 'true';
      if (!rect) continue;
      const [x, y, w, h] = rect;
      const tw = rot ? h : w, th = rot ? w : h;   // region in the sheet is h×w when stored rotated
      S.frames.set(name, { tex: texIndex, u0: x / p.bmp.width, v0: y / p.bmp.height, u1: (x + tw) / p.bmp.width, v1: (y + th) / p.bmp.height,
        w: w / p.k, h: h / p.k, ox: off[0] / p.k, oy: off[1] / p.k, rot });
      count++;
    }
  }
  S.anim = new Map();
  for (const name of S.frames.keys()) {
    const m = /^(.*_looped)_(\d{3})\.png$/.exec(name);
    if (m) S.anim.set(m[1], Math.max(S.anim.get(m[1]) || 0, +m[2]));
  }
  S.sheets = picks.map(p => p.name);
  status(`Loaded ${count.toLocaleString()} sprites from ${picks.map(p => p.name).join(', ')}.`, 'ok');
  $('#artState').textContent = `${count.toLocaleString()} sprites loaded`;
}
async function loadFont(fontId) {
  const base = fontId ? 'gjfont' + String(fontId).padStart(2, '0') : 'bigfont';
  if (S.font && S.font.base === base && S.font.tex >= 0 && S.font.live === R.texGen()) return;
  for (const [suf, k] of [['-uhd', 4], ['-hd', 2], ['', 1]]) {
    const fnt = S.fntFiles.get(base + suf), png = S.fontPngs.get(base + suf);
    if (!fnt || !png) continue;
    const bmp = await createImageBitmap(png);
    if (bmp.width > R.maxTex || bmp.height > R.maxTex) continue;
    const txt = await fnt.text();
    const num = (line, key) => { const m = new RegExp('\\b' + key + '=(-?\\d+)').exec(line); return m ? +m[1] : 0; };
    const common = txt.split('\n').find(l => l.startsWith('common')) || '';
    const glyphs = new Map();
    const tex = R.addTexture(bmp);
    for (const line of txt.split('\n')) {
      if (!line.startsWith('char ')) continue;
      const g = { id: num(line, 'id'), x: num(line, 'x'), y: num(line, 'y'), w: num(line, 'width'), h: num(line, 'height'),
        xo: num(line, 'xoffset'), yo: num(line, 'yoffset'), adv: num(line, 'xadvance') };
      g.frame = { tex, u0: g.x / bmp.width, v0: g.y / bmp.height, u1: (g.x + g.w) / bmp.width, v1: (g.y + g.h) / bmp.height, rot: false };
      glyphs.set(g.id, g);
    }
    S.font = { base, k, tex, glyphs, lineHeight: num(common, 'lineHeight'), live: R.texGen() };
    $('#artState').textContent = $('#artState').textContent.replace(/ · .*$/, '') + ' · font ' + (fontId || 'default');
    return;
  }
}
function dictGet(dict, key) {
  if (!dict) return null; const k = [...dict.children];
  for (let i = 0; i < k.length; i += 2) if (k[i].tagName === 'key' && k[i].textContent === key) return k[i + 1];
  return null;
}
function dictText(dict, key) { const e = dictGet(dict, key); return e ? e.textContent : null; }
function nums(s) { if (!s) return null; const m = s.match(/-?\d+(\.\d+)?/g); return m ? m.map(Number) : null; }

/* ---------------- precomputation ---------------- */
function precomputeRank(L) {
  const idx = new Int32Array(L.n); for (let i = 0; i < L.n; i++) idx[i] = i;
  idx.sort((a, b) => (L.zl[a] - L.zl[b]) || (L.zo[a] - L.zo[b]) || (a - b));
  L.rank = new Int32Array(L.n); for (let r = 0; r < L.n; r++) L.rank[idx[r]] = r;
}
// time (s) to reach x, from static speed portals, so songs start at the right point for start positions
function precomputeTimes(L) {
  const sp = [];
  for (let i = 0; i < L.n; i++) if (L.cls[i] === 7 && L.sub[i][0] === 'speed' && !L.isDynamic[i]) sp.push([L.x[i], L.sub[i][1]]);
  sp.sort((a, b) => a[0] - b[0]);
  L.speedMarks = sp;
  L.timeAtX = x => {
    let t = 0, cx = 0, si = [1, 0, 2, 3, 4][+L.header.kA4 || 0] ?? 1;
    for (const [px, s] of sp) { if (px >= x) break; t += (px - cx) / C.SPEEDS[si]; cx = px; si = s; }
    return t + (x - cx) / C.SPEEDS[si];
  };
}

/* ---------------- audio clock ---------------- */
const audio = { ctx: null, src: null, startCtx: 0, gain: null };
function ensureAudio() {
  if (!audio.ctx) {
    audio.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    audio.gain = audio.ctx.createGain(); audio.gain.gain.value = +$('#vol').value; audio.gain.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
}
function outLatency() { return audio.ctx ? (audio.ctx.outputLatency || audio.ctx.baseLatency || 0) : 0; }
// Level clock: seconds since the run began, as heard/seen by the player
function levelNow() {
  if (audio.ctx && S.clockAudio) return audio.ctx.currentTime - outLatency() - audio.startCtx;
  return (performance.now() - S.perfStart) / 1000;
}
// Convert an input event's timestamp to level time
function levelTimeOfEvent(ev) {
  const pe = ev.timeStamp || performance.now();
  if (audio.ctx && S.clockAudio && audio.ctx.getOutputTimestamp) {
    const ts = audio.ctx.getOutputTimestamp();
    if (ts.performanceTime) {
      const ctxAtEvent = ts.contextTime + (pe - ts.performanceTime) / 1000;
      return ctxAtEvent - audio.startCtx;   // contextTime is already the output (heard) time
    }
  }
  if (audio.ctx && S.clockAudio) return levelNow() - (performance.now() - pe) / 1000;
  return (pe - S.perfStart) / 1000;
}
function startClock(levelTimeAtStart, songTime) {
  stopSong();
  S.clockAudio = false;
  if (S.songBuffer && audio.ctx) {
    ensureAudio();
    const src = audio.ctx.createBufferSource(); src.buffer = S.songBuffer; src.connect(audio.gain);
    const when = audio.ctx.currentTime + 0.05;
    const off = Math.max(0, songTime);
    if (off < S.songBuffer.duration) src.start(when, off);
    audio.src = src;
    // level time t is heard at ctx time startCtx + t + latency
    audio.startCtx = when - levelTimeAtStart;
    S.clockAudio = true;
  }
  S.perfStart = performance.now() + 50 - levelTimeAtStart * 1000;
}
function stopSong() { if (audio.src) { try { audio.src.stop(); } catch (_) {} audio.src.disconnect(); audio.src = null; } }

/* ---------------- run control ---------------- */
function begin(practice) {
  S.deaths = 0; S.clicks = 0; S.clickTimes = [];
  if (!S.L) return;
  ensureAudio();
  S.practice = practice; S.noclip = practice && S.noclip;
  S.checkpoints = [];
  S.attempts = 0;
  $('#menu').hidden = true; $('#hud').hidden = false; $('#practiceBar').hidden = !practice;
  syncToggles();
  S.running = true;
  restart();
  canvas.focus();
}
function restart(fromCheckpoint) {
  const L = S.L;
  S.attempts++;
  const sim = new C.Sim(L, { startIndex: S.startIndex, noclip: S.noclip, safe: S.safe, onNoclipHit: () => { S.deaths++; } });
  if (fromCheckpoint) sim.restore(fromCheckpoint.state);
  S.sim = sim; S.deathAt = 0; S.noclipHits = 0; S.lastHeldDown = false;
  const tStart = sim.time;
  const x0 = sim.players[0].x;
  const songT = (+L.header.kA13 || 0) + L.timeAtX(x0);
  startClock(tStart, songT);
  $('#attempt').textContent = S.safe ? `Safe run · attempt ${S.attempts}` : `Attempt ${S.attempts}`;
}
function toMenu() {
  S.running = false; stopSong();
  $('#menu').hidden = false; $('#hud').hidden = true; $('#practiceBar').hidden = true; $('#result').hidden = true;
}

/* ---------------- input: act on the press itself, at its own timestamp ---------------- */
const canvas = $('#game');
const JUMP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW', 'Enter']);
let keyDowns = 0;
function press(down, ev) {
  if (down && S.running) { S.clicks++; S.clickTimes.push(performance.now()); }
  if (!S.running || !S.sim) return;
  const t = levelTimeOfEvent(ev);
  const tick = Math.max(0, Math.round(t * C.TPS));
  S.sim.input(down, tick);
}
window.addEventListener('keydown', e => {
  if (!S.running) return;
  if (JUMP_KEYS.has(e.code)) { e.preventDefault(); if (e.repeat) return; if (keyDowns++ === 0) press(true, e); return; }
  if (e.code === 'Escape') { toMenu(); return; }
  if (e.code === 'KeyR') { restart(); return; }
  if (!S.practice) return;
  if (e.code === 'KeyZ') placeCheckpoint();
  else if (e.code === 'KeyX') removeCheckpoint();
  else if (e.code === 'KeyN') toggleNoclip();

  else if (e.code === 'KeyH') { S.hitboxes = !S.hitboxes; syncToggles(); }
});
window.addEventListener('keyup', e => {
  if (!S.running || !JUMP_KEYS.has(e.code)) return;
  keyDowns = Math.max(0, keyDowns - 1);
  if (keyDowns === 0) press(false, e);
});
canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); press(true, e); });
canvas.addEventListener('pointerup', e => { e.preventDefault(); press(false, e); });
canvas.addEventListener('pointercancel', e => press(false, e));
canvas.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('blur', () => { if (keyDowns) { keyDowns = 0; press(false, { timeStamp: performance.now() }); } });

/* ---------------- practice tools ---------------- */
function placeCheckpoint() {
  const sim = S.sim; if (!sim || sim.dead) return;
  const p = sim.players[0]; if (!p.grounded && p.mode !== 'ship' && p.mode !== 'wave' && p.mode !== 'ufo' && p.mode !== 'swing') return;
  S.checkpoints.push({ state: sim.snapshot(), x: p.x });
  flashBadge('Checkpoint ' + S.checkpoints.length);
}
function removeCheckpoint() { if (S.checkpoints.pop()) flashBadge(S.checkpoints.length ? 'Checkpoint ' + S.checkpoints.length : 'No checkpoints'); }
function toggleSafe() {
  S.safe = !S.safe;
  if (S.sim) S.sim.opts.safe = S.safe;
  syncToggles(); flashBadge(S.safe ? 'Safe mode on' : 'Safe mode off');
}
function toggleNoclip() {
  S.noclip = !S.noclip;
  if (S.sim) S.sim.opts.noclip = S.noclip;
  syncToggles(); flashBadge(S.noclip ? 'Noclip on' : 'Noclip off');
}
function flashBadge(t) { const b = $('#badge'); b.textContent = t; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); }
function syncToggles() {
  $('#tNoclip').setAttribute('aria-pressed', S.noclip); $('#tHit').setAttribute('aria-pressed', S.hitboxes);
}

/* ---------------- main loop ---------------- */
function frame() {
  requestAnimationFrame(frame);
  updateHudStats();
  if (!S.running || !S.sim) { R.drawIdle(); return; }
  const sim = S.sim;
  const now = levelNow();
  // advance physics to "now" in fixed ticks
  let guard = 0;
  while ((sim.tick + 1) * C.DT <= now && guard++ < C.TPS) {
    sim.step();
    if (sim.dead && !S.deathAt) { S.deathAt = performance.now(); onDeath(); }
    if (sim.won) break;
  }
  if (sim.won && !S.wonShown) { S.wonShown = true; onWin(); }
  // death -> auto restart
  if (S.deathAt && performance.now() - S.deathAt > (S.practice ? 450 : 700)) {
    const cp = S.practice && S.checkpoints[S.checkpoints.length - 1];
    restart(cp || null);
  }
  const pct = Math.max(0, Math.min(100, 100 * sim.players[0].x / S.L.length));
  $('#bar').style.width = pct.toFixed(2) + '%';
  $('#pct').textContent = Math.floor(pct) + '%';
  R.draw(sim, now);
}
const fpsState = { last: 0, frames: 0, fps: 0, shown: 0 };
function updateHudStats() {
  const now = performance.now();
  fpsState.frames++;
  if (!fpsState.last) fpsState.last = now;
  if (now - fpsState.last >= 500) { fpsState.fps = Math.round(fpsState.frames * 1000 / (now - fpsState.last)); fpsState.frames = 0; fpsState.last = now; }
  if (now - fpsState.shown < 100 || !S.running) return;
  fpsState.shown = now;
  const t = S.clickTimes || [];
  while (t.length && now - t[0] > 1000) t.shift();
  $('#deaths').textContent = `Deaths ${S.deaths || 0}`;
  $('#clicks').textContent = `Clicks ${S.clicks || 0}`;
  $('#cps').textContent = `${t.length} CPS`;
  $('#fps').textContent = `${fpsState.fps} FPS`;
}
function onDeath() {
  S.deaths++;
  const pct = Math.floor(100 * S.sim.players[0].x / S.L.length);
  if (!S.practice && !S.safe && pct > S.best) { S.best = pct; $('#best').textContent = `Best ${pct}%`; }
  stopSong();
}
function onWin() {
  stopSong(); S.running = true;
  const r = $('#result'); r.hidden = false;
  $('#resultText').textContent = S.practice ? 'Practice run complete' : `Level complete in ${S.attempts} attempt${S.attempts === 1 ? '' : 's'}`;
}

/* ============================================================
   WebGL2 instanced sprite renderer
   ============================================================ */
const R = (() => {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, desynchronized: true, powerPreference: 'high-performance' });
  if (!gl) { status('This browser has no WebGL2, which the player needs.', 'err'); return { draw() {}, drawIdle() {}, addTexture() { return 0; }, resetTextures() {}, setGlowTex() {}, texGen: () => 0, maxTex: 0 }; }
  const VS = `#version 300 es
  layout(location=0) in vec2 corner;
  layout(location=1) in vec4 posSize;   // x, y, halfW, halfH
  layout(location=2) in vec4 uv;        // u0 v0 u1 v1
  layout(location=3) in vec4 color;
  layout(location=4) in vec4 mat;       // 2x2 linear map: x axis (a,b), y axis (c,d) — rotation, flips, scale, warp
  layout(location=5) in vec3 texInfo;   // texture index, uv-rotated flag, additive flag
  uniform vec4 cam; // x, y, unitsToClipX, unitsToClipY
  uniform float mirror;
  out vec2 vUv; out vec4 vColor; flat out int vTex; flat out float vAdd;
  void main() {
    vec2 local = corner * posSize.zw * 2.0;
    vec2 w = mat.xy * local.x + mat.zw * local.y + posSize.xy;
    vec2 clip = (w - cam.xy) * cam.zw - 1.0;
    clip.x *= mirror;
    gl_Position = vec4(clip, 0.0, 1.0);
    vec2 t = corner + 0.5; // 0..1, y up
    if (texInfo.y > 0.5) t = vec2(t.y, t.x);       // sprite stored rotated in the sheet
    else t.y = 1.0 - t.y;
    vUv = mix(uv.xy, uv.zw, t);
    vColor = color; vTex = int(texInfo.x); vAdd = texInfo.z;
  }`;
  const FS = `#version 300 es
  precision mediump float;
  in vec2 vUv; in vec4 vColor; flat in int vTex; flat in float vAdd;
  uniform sampler2D t0, t1, t2, t3, t4, t5, t6, t7, t8;
  out vec4 o;
  void main() {
    vec4 s;
    if (vTex == 0) s = texture(t0, vUv); else if (vTex == 1) s = texture(t1, vUv); else if (vTex == 2) s = texture(t2, vUv);
    else if (vTex == 3) s = texture(t3, vUv); else if (vTex == 4) s = texture(t4, vUv); else if (vTex == 5) s = texture(t5, vUv);
    else if (vTex == 6) s = texture(t6, vUv); else if (vTex == 7) s = texture(t7, vUv); else s = texture(t8, vUv);
    vec4 c = s * vColor;
    if (c.a < 0.004) discard;
    // premultiplied output; additive sprites keep alpha 0 so they only brighten
    o = vec4(c.rgb * c.a, vAdd > 0.5 ? 0.0 : c.a);
  }`;
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  gl.useProgram(prog);
  const uCam = gl.getUniformLocation(prog, 'cam'), uMirror = gl.getUniformLocation(prog, 'mirror');
  for (let k = 0; k < 9; k++) gl.uniform1i(gl.getUniformLocation(prog, 't' + k), k);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5, -.5, .5, -.5, -.5, .5, .5, .5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const STRIDE = 19; // floats per instance
  let cap = 65536; let data = new Float32Array(cap * STRIDE);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const attr = (loc, size, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4); gl.vertexAttribDivisor(loc, 1); };
  attr(1, 4, 0); attr(2, 4, 4); attr(3, 4, 8); attr(4, 4, 12); attr(5, 3, 16);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const textures = [];
  function addTexture(src) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.push(t);
    if (textures.length > 9) console.warn('More textures than shader slots; sprites past slot 8 will draw wrong.');
    return textures.length - 1;
  }

  /* ---- built-in shape atlas (original simple shapes, drawn here) ---- */
  const A = 64, COLS = 8;
  const shapes = ['square', 'slope', 'spike', 'saw', 'ring', 'pad', 'portal', 'box', 'tri', 'circle', 'white',
    'cube', 'ship', 'ball', 'ufo', 'wave', 'robot', 'spider', 'swing', 'glow', 'pit'];
  const atlas = document.createElement('canvas'); atlas.width = A * COLS; atlas.height = A * Math.ceil(shapes.length / COLS);
  const g = atlas.getContext('2d');
  const SH = {};
  shapes.forEach((name, k) => {
    const x = (k % COLS) * A, y = Math.floor(k / COLS) * A;
    SH[name] = { tex: 0, u0: (x + 1) / atlas.width, v0: (y + 1) / atlas.height, u1: (x + A - 1) / atlas.width, v1: (y + A - 1) / atlas.height };
    g.save(); g.translate(x, y); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
    const P = 2, W = A - 2 * P;
    switch (name) {
      case 'square': g.globalAlpha = 0.55; g.fillRect(P, P, W, W); g.globalAlpha = 1; g.lineWidth = 4; g.strokeRect(P + 2, P + 2, W - 4, W - 4); break;
      case 'slope': g.globalAlpha = 0.55; g.beginPath(); g.moveTo(P, A - P); g.lineTo(A - P, A - P); g.lineTo(A - P, P); g.closePath(); g.fill(); g.globalAlpha = 1; g.lineWidth = 3; g.stroke(); break;
      case 'spike': g.beginPath(); g.moveTo(P, A - P); g.lineTo(A / 2, P); g.lineTo(A - P, A - P); g.closePath(); g.fill(); break;
      case 'pit': for (let s = 0; s < 4; s++) { const sx = P + s * W / 4; g.beginPath(); g.moveTo(sx, A - P); g.lineTo(sx + W / 8, A / 2); g.lineTo(sx + W / 4, A - P); g.closePath(); g.fill(); } break;
      case 'saw': g.beginPath(); for (let s = 0; s < 24; s++) { const a = s / 24 * Math.PI * 2, r = s % 2 ? W / 2 : W / 2 - 7; g.lineTo(A / 2 + Math.cos(a) * r, A / 2 + Math.sin(a) * r); } g.closePath(); g.fill(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(A / 2, A / 2, 7, 0, 7); g.fill(); break;
      case 'ring': g.lineWidth = 7; g.beginPath(); g.arc(A / 2, A / 2, W / 2 - 5, 0, 7); g.stroke(); g.beginPath(); g.arc(A / 2, A / 2, W / 5, 0, 7); g.fill(); break;
      case 'pad': g.beginPath(); g.ellipse(A / 2, A - P, W / 2, W / 3, 0, Math.PI, 0); g.fill(); break;
      case 'portal': g.lineWidth = 7; g.beginPath(); g.ellipse(A / 2, A / 2, W / 2 - 4, W / 2 - 4, 0, 0, 7); g.stroke(); break;
      case 'box': g.lineWidth = 3; g.strokeRect(P, P, W, W); break;
      case 'tri': g.lineWidth = 3; g.beginPath(); g.moveTo(P, A - P); g.lineTo(A - P, A - P); g.lineTo(A - P, P); g.closePath(); g.stroke(); break;
      case 'circle': g.lineWidth = 3; g.beginPath(); g.arc(A / 2, A / 2, W / 2 - 2, 0, 7); g.stroke(); break;
      case 'white': g.fillRect(0, 0, A, A); break;
      case 'glow': { const gr = g.createRadialGradient(A / 2, A / 2, 0, A / 2, A / 2, A / 2); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, A, A); break; }
      // Player bodies: original shapes for this player (a notched tile and simple vehicles)
      case 'cube': g.fillRect(P, P, W, W); g.globalCompositeOperation = 'destination-out'; g.fillRect(P + 12, P + 12, W - 24, W - 24); g.globalCompositeOperation = 'source-over'; g.fillRect(P + 20, P + 20, W - 40, W - 40); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.moveTo(A - P, P); g.lineTo(A - P - 14, P); g.lineTo(A - P, P + 14); g.fill(); break;
      case 'ship': g.beginPath(); g.moveTo(P, A * 0.7); g.lineTo(A - P, A * 0.55); g.lineTo(P + 10, A * 0.3); g.closePath(); g.fill(); g.fillRect(P + 8, A * 0.32, 18, 18); break;
      case 'ball': g.beginPath(); g.arc(A / 2, A / 2, W / 2, 0, 7); g.fill(); g.globalCompositeOperation = 'destination-out'; g.fillRect(A / 2 - 4, P, 8, W); g.fillRect(P, A / 2 - 4, W, 8); break;
      case 'ufo': g.beginPath(); g.ellipse(A / 2, A * 0.62, W / 2, W / 5, 0, 0, 7); g.fill(); g.beginPath(); g.arc(A / 2, A * 0.55, W / 4, Math.PI, 0); g.fill(); break;
      case 'wave': g.beginPath(); g.moveTo(P, P + 6); g.lineTo(A - P, A / 2); g.lineTo(P, A - P - 6); g.lineTo(P + 14, A / 2); g.closePath(); g.fill(); break;
      case 'robot': g.fillRect(P + 6, P, W - 12, W * 0.6); g.fillRect(P + 10, P + W * 0.6, 10, W * 0.4); g.fillRect(A - P - 20, P + W * 0.6, 10, W * 0.4); break;
      case 'spider': g.beginPath(); g.ellipse(A / 2, A * 0.42, W / 2.6, W / 3.4, 0, 0, 7); g.fill(); g.lineWidth = 5; for (const s of [-1, 1]) { g.beginPath(); g.moveTo(A / 2 + s * 8, A * 0.5); g.lineTo(A / 2 + s * 22, A - P); g.stroke(); } break;
      case 'swing': g.beginPath(); g.arc(A / 2, A / 2, W / 3, 0, 7); g.fill(); g.beginPath(); g.moveTo(P, A / 2); g.lineTo(A / 2 - 6, A / 2 - 14); g.lineTo(A / 2 - 6, A / 2 + 14); g.closePath(); g.fill(); break;
    }
    g.restore();
  });
  addTexture(atlas);

  let buf = data, n = 0, curAdd = false, glowTex = -1;
  function pushM(x, y, hw, hh, m, f, r, gc, b, a) {
    if (n >= cap) { cap *= 2; const nd = new Float32Array(cap * STRIDE); nd.set(buf); buf = data = nd; gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW); }
    const o = n++ * STRIDE;
    buf[o] = x; buf[o + 1] = y; buf[o + 2] = hw; buf[o + 3] = hh;
    buf[o + 4] = f.u0; buf[o + 5] = f.v0; buf[o + 6] = f.u1; buf[o + 7] = f.v1;
    buf[o + 8] = r; buf[o + 9] = gc; buf[o + 10] = b; buf[o + 11] = a;
    buf[o + 12] = m[0]; buf[o + 13] = m[1]; buf[o + 14] = m[2]; buf[o + 15] = m[3];
    buf[o + 16] = f.tex; buf[o + 17] = f.rot ? 1 : 0; buf[o + 18] = (curAdd || f.tex === glowTex) ? 1 : 0;
  }
  // angle form (ccw radians, y up); signed half sizes give flips
  function push(x, y, hw, hh, rot, f, r, gc, b, a) {
    const c = Math.cos(rot), s = Math.sin(rot);
    pushM(x, y, Math.abs(hw), Math.abs(hh), [c * Math.sign(hw || 1), s * Math.sign(hw || 1), -s * Math.sign(hh || 1), c * Math.sign(hh || 1)], f, r, gc, b, a);
  }
  // 2x2 helpers: matrices are [ax, ay, bx, by] = columns (x axis, y axis)
  const mm = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3]];
  const mv = (A, x, y) => [A[0] * x + A[2] * y, A[1] * x + A[3] * y];
  // object's linear map: warp axes (GD angles are clockwise) times signed scale
  function objLinear(L, i, extraDeg) {
    const rx = -((L.rx[i] + extraDeg) * Math.PI / 180), ry = -((L.ry[i] + extraDeg) * Math.PI / 180);
    const sx = L.sx[i] * (L.fx[i] ? -1 : 1), sy = L.sy[i] * (L.fy[i] ? -1 : 1);
    return [Math.cos(rx) * sx, Math.sin(rx) * sx, -Math.sin(ry) * sy, Math.cos(ry) * sy];
  }

  const ORB_COL = { yellow: [1, .86, .2], pink: [1, .45, .85], red: [1, .3, .3], blue: [.3, .75, 1], green: [.35, 1, .45], black: [.15, .15, .2], dashg: [.35, 1, .45], dashp: [1, .45, .85], spider: [.75, .45, 1], toggle: [1, 1, 1] };
  const PORTAL_COL = { grav: [.3, .75, 1], mode: [.45, 1, .5], size: [1, .55, .9], speed: [1, .8, .3], mirror: [1, .6, .2], dual: [1, .55, .2], tele: [.3, 1, .9] };
  const vis = [];
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (w !== W || h !== H) { W = canvas.width = w; H = canvas.height = h; }
  }
  const cam = { x: 0, y: 0, ty: 0 };
  const VIEW_H = 320; // units visible vertically

  function colorOf(sim, ch) { return C.channelColor(sim, ch); }
  // object's color for base (detail=false) or detail channel, with its HSV shift
  function objColor(sim, L, i, detail) {
    const ch = detail ? (L.ch2[i] || 1005) : L.ch1[i];
    return C.applyHSV(colorOf(sim, ch), detail ? L.hsv2.get(i) : L.hsv1.get(i));
  }
  function alphaOf(sim, L, i) {
    let a = 1; const gs = L.groups[i];
    if (gs && sim.groupAlpha.size) for (const gid of gs) { const v = sim.groupAlpha.get(gid); if (v !== undefined) a *= v; }
    return a;
  }

  function drawIdle() {
    resize(); gl.viewport(0, 0, W, H); gl.clearColor(0.043, 0.047, 0.11, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function draw(sim, now) {
    resize();
    const L = sim.L; const p0 = sim.players[0];
    const viewW = VIEW_H * W / H;
    // camera
    cam.x = p0.x - viewW * 0.3;
    if (p0.bounded) cam.ty = (p0.lo + p0.hi) / 2 - VIEW_H / 2;
    else {
      const lo = cam.ty + 90, hi = cam.ty + VIEW_H - 110;
      if (p0.y < lo) cam.ty = p0.y - 90; else if (p0.y > hi) cam.ty = p0.y - (VIEW_H - 110);
      cam.ty = Math.max(cam.ty, -90);
    }
    cam.y += (cam.ty - cam.y) * 0.12;
    const bg = colorOf(sim, 1000);
    const sheet = S.frames.size > 0;
    const dim = sheet ? 1 : 0.35;
    gl.viewport(0, 0, W, H);
    gl.clearColor(bg[0] / 255 * dim, bg[1] / 255 * dim, bg[2] / 255 * dim + (sheet ? 0 : 0.04), 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    n = 0;
    const x0 = cam.x - 60, x1 = cam.x + viewW + 60, y0 = cam.y - 60, y1 = cam.y + VIEW_H + 60;

    // visible objects: static chunks + moved buckets
    vis.length = 0;
    const st = (L.stampN = ((L.stampN || 0) + 1) >>> 0 || 1);
    const c0 = Math.max(0, Math.floor((x0 - 150) / C.CHUNK)), c1 = Math.min(L.chunks.length - 1, Math.floor((x1 + 150) / C.CHUNK));
    const wantDeco = sheet ? S.showDeco : false;
    for (let c = c0; c <= c1; c++) {
      const a = L.chunks[c];
      for (let k = 0; k < a.length; k++) {
        const i = a[k];
        if (L.cls[i] === 0 && !wantDeco) continue;
        if (L.isDynamic[i] && sim.objMatrix(i)) continue;
        const y = L.y[i]; if (y < y0 - 200 || y > y1 + 200) continue;
        L.stamp[i] = st; vis.push(i);
      }
    }
    for (const b of L.buckets) {
      const m = sim.bucketMatrix(b); if (!m) continue;
      const list = wantDeco ? b.all : b.play; if (!list.length) continue;
      if (!C.boxHitsX(m, wantDeco ? b.abox : b.pbox, x0 - 150, x1 + 150)) continue;
      for (let k = 0; k < list.length; k++) {
        const i = list[k]; if (L.stamp[i] === st) continue;
        const px = m[0] * L.x[i] + m[2] * L.y[i] + m[4];
        if (px < x0 - 150 || px > x1 + 150) continue;
        L.stamp[i] = st; vis.push(i);
      }
    }
    vis.sort((a, b) => L.rank[a] - L.rank[b]);

    for (const i of vis) {
      if (S.ldm && L.hd[i]) continue;
      if (!sim.objActive(i)) continue;
      const q = sim.objPos(i);
      const alpha = alphaOf(sim, L, i); if (alpha <= 0.01) continue;
      const rot = -((L.rot[i] + q[2]) * Math.PI / 180);
      const fx = L.fx[i] ? -1 : 1, fy = L.fy[i] ? -1 : 1;
      if (sheet) drawSprite(sim, L, i, q[0], q[1], objLinear(L, i, q[2]), alpha, rot, fx, fy);
      else drawShape(sim, L, i, q[0], q[1], rot, fx, fy, alpha);
    }

    // ground / bounds
    const gcol = colorOf(sim, 1001), lcol = colorOf(sim, 1002);
    const gd = sheet ? 1 : 0.5;
    if (p0.bounded) {
      push(cam.x + viewW / 2, p0.lo - 200, viewW, 200, 0, SH.white, gcol[0] / 255 * gd, gcol[1] / 255 * gd, gcol[2] / 255 * gd, 1);
      push(cam.x + viewW / 2, p0.hi + 200, viewW, 200, 0, SH.white, gcol[0] / 255 * gd, gcol[1] / 255 * gd, gcol[2] / 255 * gd, 1);
      push(cam.x + viewW / 2, p0.lo, viewW, 0.8, 0, SH.white, lcol[0] / 255, lcol[1] / 255, lcol[2] / 255, 0.9);
      push(cam.x + viewW / 2, p0.hi, viewW, 0.8, 0, SH.white, lcol[0] / 255, lcol[1] / 255, lcol[2] / 255, 0.9);
    } else {
      push(cam.x + viewW / 2, -200, viewW, 200, 0, SH.white, gcol[0] / 255 * gd, gcol[1] / 255 * gd, gcol[2] / 255 * gd, 1);
      push(cam.x + viewW / 2, 0, viewW, 0.8, 0, SH.white, lcol[0] / 255, lcol[1] / 255, lcol[2] / 255, 0.9);
    }

    // players
    for (const p of sim.players) {
      const size = p.mode === 'wave' ? (p.mini ? 10 : 16) : (p.mini ? 18 : 30);
      const c1c = colorOf(sim, 1005), c2c = colorOf(sim, 1006);
      const flipY = p.g < 0 ? -1 : 1;
      const body = SH[p.mode] || SH.cube;
      const r = p.rot * Math.PI / 180 * -1;
      push(p.x, p.y, size * 0.9, size * 0.9 * flipY, 0, SH.glow, c2c[0] / 255, c2c[1] / 255, c2c[2] / 255, 0.35);
      push(p.x, p.y, size / 2, size / 2 * flipY, r, body, c1c[0] / 255, c1c[1] / 255, c1c[2] / 255, 1);
    }
    if (S.hitboxes) drawHitboxes(sim, L, vis);
    if (sim.dead) {
      const p = sim.deathPlayer || p0; const t = Math.min(1, (performance.now() - S.deathAt) / 400);
      push(p.x, p.y, 40 + 60 * t, 40 + 60 * t, 0, SH.glow, 1, 1, 1, 1 - t);
    }

    gl.uniform4f(uCam, cam.x, cam.y, 2 / viewW, 2 / VIEW_H);
    gl.uniform1f(uMirror, sim.mirror ? -1 : 1);
    for (let k = 0; k < textures.length; k++) { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, textures[k]); }
    gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, n * STRIDE);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }

  function drawShape(sim, L, i, x, y, rot, fx, fy, alpha) {
    const cl = L.cls[i]; const sx = L.sx[i], sy = L.sy[i];
    const oc = objColor(sim, L, i, false); const ocA = (oc[3] ?? 1);
    let col = [oc[0] / 255, oc[1] / 255, oc[2] / 255];
    let f = null, w = 15 * sx, h = 15 * sy, ox = 0, oy = 0, outline = false;
    if (cl === 1) { f = SH.square; const hb = L.hb[i]; w = hb[0] / 2 * sx; h = hb[1] / 2 * sy; ox = hb[2] * sx; oy = hb[3] * sy; outline = true; }
    else if (cl === 2) { const tex = (RENDER_TAB[L.id[i]] || [''])[0]; f = /^pit/.test(tex) ? SH.pit : SH.spike; if (L.hb[i][1] < 10) { h = 15 * sy * 0.5; oy = -7.5 * sy; } }
    else if (cl === 3) { f = SH.saw; }
    else if (cl === 4) { f = SH.slope; if (L.sub[i] === 2) w = 30 * sx; outline = true; }
    else if (cl === 5) { f = SH.ring; col = ORB_COL[L.sub[i]] || [1, 1, 1]; w = 17 * sx; h = 17 * sy; }
    else if (cl === 6) { f = SH.pad; col = ORB_COL[L.sub[i]] || [1, 1, 1]; h = 8 * sy; oy = -7 * sy; }
    else if (cl === 7) { f = SH.portal; col = PORTAL_COL[L.sub[i][0]] || [1, 1, 1]; const sp = L.sub[i][0] === 'speed'; w = 17 * sx; h = (sp ? 22 : 43) * sy; }
    else return;
    if (ox || oy) { const c = Math.cos(rot), s = Math.sin(rot); const ax = ox * fx, ay = oy * fy; x += ax * c - ay * s; y += ax * s + ay * c; }
    const a = alpha * (cl >= 5 ? 1 : ocA);
    push(x, y, w * fx, h * fy, rot, f, col[0], col[1], col[2], a);
    // light edge so black blocks stay readable on dark backgrounds
    if (outline) { const e = c => 0.45 + 0.55 * c; push(x, y, w * fx, h * fy, rot, cl === 4 ? SH.tri : SH.box, e(col[0]), e(col[1]), e(col[2]), a * 0.8); }
  }

  function drawText(sim, L, i, x, y, M, alpha) {
    const str = L.text.get(i); const F = S.font; if (!str || !F) return;
    const c = C.applyHSV(colorOf(sim, L.ch1[i]), L.hsv1.get(i));
    curAdd = sim.blend.has(L.ch1[i]);
    const k = F.k; const lines = str.split('\n'); const lh = F.lineHeight / k;
    lines.forEach((line, li) => {
      let wsum = 0; for (const ch of line) { const g = F.glyphs.get(ch.codePointAt(0)); if (g) wsum += g.adv / k; }
      let cur = -wsum / 2; const top = (lines.length * lh) / 2 - li * lh;
      for (const ch of line) {
        const g = F.glyphs.get(ch.codePointAt(0)); if (!g) continue;
        const p = mv(M, cur + g.xo / k + g.w / k / 2, top - g.yo / k - g.h / k / 2);
        pushM(x + p[0], y + p[1], g.w / k / 2, g.h / k / 2, M, g.frame, c[0] / 255, c[1] / 255, c[2] / 255, (c[3] ?? 1) * alpha);
        cur += g.adv / k;
      }
    });
    curAdd = false;
  }

  // M = object's linear map (warp × scale × flips). Each sub-piece: M × R(piece rotation) × S(piece scale/flip),
  // placed at M × (piece position + R·S·(spriteOffset − anchor·size)); anchor 0 = centered (gdrweb convention).
  function frameOf(name, t) {
    const m = S.anim && /^(.*_looped)_001\.png$/.exec(name);
    if (m) { const n = S.anim.get(m[1]); if (n > 1) { const k = 1 + (Math.floor(t * 20) % n); return S.frames.get(m[1] + '_' + String(k).padStart(3, '0') + '.png'); } }
    return S.frames.get(name);
  }
  function drawSprite(sim, L, i, x, y, M, alpha, rot, fx, fy) {
    if (L.id[i] === 914) return drawText(sim, L, i, x, y, M, alpha);
    const rt = RENDER_TAB[L.id[i]];
    if (!rt || !rt[0]) { if (L.cls[i] && L.cls[i] < 8) drawShape(sim, L, i, x, y, rot, fx, fy, alpha); return; }
    const swap = rt[6] === 1;
    const chBase = L.ch1[i], chDet = L.ch2[i] || (swap ? 1004 : 1005);
    const colFor = t => {
      if (t === 2) return [0, 0, 0, 1];
      const det = (t === 1) !== swap;
      return C.applyHSV(colorOf(sim, det ? chDet : chBase), det ? L.hsv2.get(i) : L.hsv1.get(i));
    };
    const chOf = t => t === 2 ? 0 : ((t === 1) !== swap ? chDet : chBase);
    const main = frameOf(rt[0], sim.time);
    if (rt[7]) for (const ch of rt[7]) if (ch[8] < 0) child(ch);
    if (main) {
      const c = colFor(rt[5]); curAdd = sim.blend.has(chOf(rt[5]));
      const p = mv(M, main.ox, main.oy);
      pushM(x + p[0], y + p[1], main.w / 2, main.h / 2, M, main, c[0] / 255, c[1] / 255, c[2] / 255, (c[3] ?? 1) * alpha);
    } else if (L.cls[i] && L.cls[i] < 8) { curAdd = false; drawShape(sim, L, i, x, y, rot, fx, fy, alpha); }
    if (rt[7]) for (const ch of rt[7]) if (ch[8] >= 0) child(ch);
    curAdd = false;
    function child(ch) {
      const f = frameOf(ch[0], sim.time); if (!f) return;
      curAdd = sim.blend.has(chOf(ch[9]));
      const c = colFor(ch[9]);
      const cr = ch[3] * Math.PI / 180;   // table sub-piece angles are counter-clockwise (gdrweb rotates them by +angle)
      const RS = mm([Math.cos(cr), Math.sin(cr), -Math.sin(cr), Math.cos(cr)], [ch[4] * (ch[6] ? -1 : 1), 0, 0, ch[5] * (ch[7] ? -1 : 1)]);
      const v = mv(RS, f.ox - ch[10] * f.w, f.oy - ch[11] * f.h);
      const p = mv(M, ch[1] + v[0], ch[2] + v[1]);
      pushM(x + p[0], y + p[1], f.w / 2, f.h / 2, mm(M, RS), f, c[0] / 255, c[1] / 255, c[2] / 255, (c[3] ?? 1) * alpha);
    }
  }

  function drawHitboxes(sim, L, list) {
    for (const i of list) {
      const cl = L.cls[i]; if (!cl || cl >= 8 || !sim.objActive(i)) continue;
      if (cl === 1 || cl === 2) {
        const r = sim.rectOf(i); if (!r) continue;
        const c = cl === 1 ? [.35, .6, 1] : [1, .25, .25];
        push((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[2] - r[0]) / 2, (r[3] - r[1]) / 2, 0, SH.box, c[0], c[1], c[2], 1);
      } else if (cl === 3) {
        const q = sim.objPos(i); const rad = 12 * Math.max(L.sx[i], L.sy[i]);
        push(q[0], q[1], rad, rad, 0, SH.circle, 1, .25, .25, 1);
      } else if (cl === 4) {
        const t = sim.slopeOf(i);
        // draw the triangle's bounding box outline in slope color (exact edges are shown by the shape itself)
        const mnx = Math.min(t[0], t[2], t[4]), mxx = Math.max(t[0], t[2], t[4]), mny = Math.min(t[1], t[3], t[5]), mxy = Math.max(t[1], t[3], t[5]);
        push((mnx + mxx) / 2, (mny + mxy) / 2, (mxx - mnx) / 2, (mxy - mny) / 2, 0, SH.box, .35, .6, 1, .45);
      } else {
        const q = sim.objPos(i); push(q[0], q[1], 18 * Math.abs(L.sx[i]), 18 * Math.abs(L.sy[i]), 0, SH.box, .4, 1, .5, 1);
      }
    }
    for (const p of sim.players) {
      const size = p.mode === 'wave' ? (p.mini ? 6 : 10) : (p.mini ? 18 : 30);
      const inner = p.mode === 'wave' ? size : (p.mini ? 5.4 : 9);
      push(p.x, p.y, size / 2, size / 2, 0, SH.box, 1, 1, .3, 1);
      push(p.x, p.y, inner / 2, inner / 2, 0, SH.box, 1, .5, 0, 1);
    }
  }

  let gen = 0;
  function resetTextures() { while (textures.length > 1) gl.deleteTexture(textures.pop()); glowTex = -1; gen++; }
  function setGlowTex(k) { glowTex = k; }
  return { draw, drawIdle, addTexture, resetTextures, setGlowTex, texGen: () => gen, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
})();

/* ---------------- menu wiring ---------------- */
const fileInput = $('#files');
fileInput.addEventListener('change', () => { takeFiles(fileInput.files); fileInput.value = ''; });
const folderInput = $('#folder');
folderInput.addEventListener('change', () => { status('Scanning folder…', 'busy'); takeFiles(folderInput.files); folderInput.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async e => { status('Scanning…', 'busy'); takeFiles(await filesFromDrop(e.dataTransfer)); });
$('#search').addEventListener('input', e => renderLevelList(e.target.value));
$('#startPos').addEventListener('change', e => { S.startIndex = +e.target.value; });
$('#play').addEventListener('click', () => begin(false));
$('#practiceBtn').addEventListener('click', () => begin(true));
$('#vol').addEventListener('input', e => { if (audio.gain) audio.gain.gain.value = +e.target.value; });
$('#tNoclip').addEventListener('click', () => { toggleNoclip(); canvas.focus(); });
$('#tHit').addEventListener('click', () => { S.hitboxes = !S.hitboxes; syncToggles(); canvas.focus(); });
$('#tCp').addEventListener('click', () => { placeCheckpoint(); canvas.focus(); });
$('#tRm').addEventListener('click', () => { removeCheckpoint(); canvas.focus(); });
$('#tMenu').addEventListener('click', toMenu);
$('#deco').addEventListener('change', e => { S.showDeco = e.target.checked; });
$('#ldm').addEventListener('change', e => { S.ldm = e.target.checked; });


$('#again').addEventListener('click', () => { $('#result').hidden = true; S.wonShown = false; restart(); });
$('#resultMenu').addEventListener('click', toMenu);
document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
  const t = b.dataset.copy;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; }
  catch (_) { const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = 'Selected'; }
  setTimeout(() => (b.textContent = 'Copy'), 1400);
}));
// Sim noclip hook: flash where the player would have died
const _die = C.Sim.prototype.die;
C.Sim.prototype.die = function (p, i) {
  if (this.opts.noclip) { if (this.opts.onNoclipHit && this.tick - (this._lastHit || -99) > 6) this.opts.onNoclipHit(); this._lastHit = this.tick; return; }
  return _die.call(this, p, i);
};
requestAnimationFrame(frame);
})();
