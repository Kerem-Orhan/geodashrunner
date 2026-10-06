/* ============================================================
   Level runner core: save decoding, level parsing, physics, triggers.
   Pure logic: no DOM. Units: 1 block = 30 units, y up, ground top at y = 0.
   Physics values are approximations of GD behaviour, tuned by feel.
   ============================================================ */
'use strict';

const TPS = 240;                 // fixed physics ticks per second
const DT = 1 / TPS;
const F = 60;                    // constants below are "per 60 fps frame"
const SPEEDS = [251.16, 311.58, 387.42, 468.0, 576.0]; // units/s for 0.5x,1x,2x,3x,4x
const HDR_SPEED = [1, 0, 2, 3, 4]; // header kA4 value -> SPEEDS index
const MODES = ['cube', 'ship', 'ball', 'ufo', 'wave', 'robot', 'spider', 'swing'];

// Tunable physics table (per-frame units). Edit here when comparing with the real game.
const PHYS = {
  cube:   { g: 0.958199, jump: 11.180032, maxFall: 15 },
  robot:  { g: 0.958199 * 0.9, jump: 10.0, boostFrames: 15, maxFall: 15 },
  ball:   { g: 0.958199 * 0.6, flipV: 2.0, maxFall: 15 },
  spider: { g: 0.958199 * 0.6, maxFall: 15 },
  ufo:    { g: 0.958199 * 0.5, jump: 7.2, maxFall: 10 },
  ship:   { up: 0.42, down: 0.34, maxUp: 8.0, maxDown: 6.4 },
  swing:  { g: 0.958199 * 0.42, maxV: 8.0 },
  wave:   {},
  miniJump: 0.8,
  miniShip: 1.15,
};
const ORB_V = { yellow: 11.2, pink: 8.0, red: 15.4, black: -15.0 };
const PAD_V = { yellow: 16.0, pink: 10.4, red: 20.0 };
const MODE_ORB_MULT = { cube: 1, robot: 1, ship: 0.7, ufo: 0.7, ball: 0.75, spider: 0.75, swing: 0.7, wave: 0 };
const BOUND_H = { ship: 300, ufo: 300, wave: 300, swing: 300, ball: 240, spider: 240 };

/* ---------------- save / level decoding ---------------- */

function b64ToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  while (s.length % 4) s += '=';
  if (typeof atob === 'function') {
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// gunzip(Uint8Array) -> Promise<string> is injected (browser: DecompressionStream, node: zlib)
async function decodeSaveFile(bytes, gunzip) {
  // Already-plain XML (.gmd export or decoded save)?
  const head = String.fromCharCode(...bytes.subarray(0, 64));
  if (head.includes('<?xml') || head.includes('<plist') || head.includes('<d>')) {
    return new TextDecoder().decode(bytes);
  }
  if (head.startsWith('kS38') || head.startsWith('kA')) return { rawLevel: new TextDecoder().decode(bytes) };
  if (head.startsWith('H4sI')) return { rawLevel: await gunzip(b64ToBytes(new TextDecoder().decode(bytes))) };
  // Windows save: XOR 11 -> base64url -> gzip
  let s = '';
  const CH = 0x8000; const tmp = new Uint8Array(Math.min(CH, bytes.length));
  for (let i = 0; i < bytes.length; i += CH) {
    const n = Math.min(CH, bytes.length - i); let k = 0;
    for (let j = 0; j < n; j++) { const b = bytes[i + j] ^ 11; if (b > 32) tmp[k++] = b; }
    s += String.fromCharCode.apply(null, tmp.subarray(0, k));
  }
  return await gunzip(b64ToBytes(s));
}

function xmlField(blk, key) {
  const m = new RegExp('<k>' + key + '</k><([is])>([^<]*)</\\1>').exec(blk);
  return m ? m[2] : null;
}
function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Returns [{id, name, creator, songId, officialSong, k4}] for every level with data in the XML
function listLevels(xml) {
  const out = []; const seen = new Set();
  const re = /<k>k4<\/k><s>([^<]+)<\/s>/g; let m;
  while ((m = re.exec(xml))) {
    const st = xml.lastIndexOf('<k>kCEK</k>', m.index);
    if (st < 0) continue;
    const en = xml.indexOf('</d>', m.index);
    const blk = xml.slice(st, m.index) + xml.slice(m.index + m[0].length, en < 0 ? undefined : en);
    const id = xmlField(blk, 'k1') || ('local-' + out.length);
    const name = unescapeXml(xmlField(blk, 'k2') || 'Untitled');
    const key = id + '|' + name;
    if (seen.has(key)) continue; seen.add(key);
    out.push({
      id, name,
      creator: unescapeXml(xmlField(blk, 'k5') || ''),
      songId: xmlField(blk, 'k45'),
      officialSong: xmlField(blk, 'k8'),
      k4: m[1],
    });
  }
  return out;
}

async function decodeLevelData(k4, gunzip) {
  if (k4.startsWith('H4sI') || k4.startsWith('H4sIAAAAAAAA')) return await gunzip(b64ToBytes(k4));
  return k4;
}

/* ---------------- level building ---------------- */

const CHUNK = 240; // spatial chunk width in units

function parseKV(str) {
  const a = str.split(','); const o = {};
  for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
}

// classTab: id -> [class, param]; renderTab: id -> [texture, zlayer, zorder, baseCh, detailCh, colorType, swap, children?]
function buildLevel(levelString, classTab, renderTab, opts = {}) {
  const parts = levelString.split(';');
  const header = parseKV(parts[0]);
  const N = parts.length - 1;
  const L = {
    header, n: 0,
    id: new Int32Array(N), x: new Float32Array(N), y: new Float32Array(N),
    rot: new Float32Array(N), rx: new Float32Array(N), ry: new Float32Array(N), fx: new Uint8Array(N), fy: new Uint8Array(N),
    sx: new Float32Array(N), sy: new Float32Array(N),
    hd: new Uint8Array(N), text: new Map(), font: +header.kA18 || 0,
    cls: new Uint8Array(N),      // 0 deco,1 solid,2 hazard,3 saw,4 slope,5 orb,6 pad,7 portal,8 trigger,9 startpos
    ch1: new Int16Array(N), ch2: new Int16Array(N), zl: new Int8Array(N), zo: new Int16Array(N),
    groups: new Array(N),        // Int32Array or null
    hb: new Array(N),            // hitbox params
    sub: new Array(N),           // class param (orb kind, portal [kind,val], slope type)
    extra: new Array(N),         // raw kv for triggers/portals/startpos
    triggers: [], startPositions: [], chunks: [], maxX: 0,
    groupObjs: new Map(),        // group -> object indices
    hsv1: new Map(), hsv2: new Map(), // object -> [h, s, v, sAdd, vAdd]
    chanDef: new Map(),          // channel -> {player, copy, copyHsv}
    initColors: {}, initBlend: new Set(),
  };
  // Starting colors: header kS38 = "1_r_2_g_3_b_6_channel_7_opacity_4_player_9_copy_10_copyHSV|..."
  for (const ent of (header.kS38 || '').split('|')) {
    if (!ent) continue;
    const a = ent.split('_'); const d = {};
    for (let k = 0; k + 1 < a.length; k += 2) d[a[k]] = a[k + 1];
    const ch = +d[6]; if (!ch) continue;
    L.initColors[ch] = [+d[1] || 0, +d[2] || 0, +d[3] || 0, d[7] !== undefined ? +d[7] : 1];
    if (d[5] === '1') L.initBlend.add(ch);
    const def = {};
    if (d[4] === '1' || d[4] === '2') def.player = +d[4];
    if (d[9] && +d[9] > 0) { def.copy = +d[9]; if (d[10]) def.copyHsv = parseHSV(d[10]); }
    if (def.player || def.copy) L.chanDef.set(ch, def);
  }
  const CLS = { solid: 1, hazard: 2, saw: 3, slope: 4, orb: 5, pad: 6, grav: 7, mode: 7, mirror: 7, size: 7, dual: 7, tele: 7, speed: 7, trig: 8, start: 9 };
  let n = 0;
  for (let p = 1; p < parts.length; p++) {
    const s = parts[p]; if (!s) continue;
    const o = parseKV(s);
    const id = +o[1]; if (!id) continue;
    const i = n++;
    L.id[i] = id; L.x[i] = +o[2] || 0; L.y[i] = +o[3] || 0;
    // 2.2 warp: X and Y axes rotate separately (keys 131/132); plain rotation (key 6) turns both
    L.rot[i] = +o[6] || 0;
    // key 132 turns the X axis, key 131 turns the Y axis (verified visually: the other way scatters spike strips)
    L.rx[i] = o[132] !== undefined ? +o[132] : L.rot[i];
    L.ry[i] = o[131] !== undefined ? +o[131] : L.rot[i];
    if (o[6] === undefined && o[132] !== undefined) L.rot[i] = L.rx[i];   // hitboxes use one angle
    L.fx[i] = o[4] === '1' ? 1 : 0; L.fy[i] = o[5] === '1' ? 1 : 0;
    const sc = o[32] ? +o[32] : 1;
    L.sx[i] = sc * (o[128] ? +o[128] : 1); L.sy[i] = sc * (o[129] ? +o[129] : 1);
    const rt = renderTab[id];
    L.ch1[i] = o[21] ? +o[21] : (rt ? rt[3] : 1004);
    L.ch2[i] = o[22] ? +o[22] : (rt ? rt[4] : 0);
    L.zl[i] = o[24] ? +o[24] : (rt ? rt[1] : 0);
    L.zo[i] = o[25] ? +o[25] : (rt ? rt[2] : 0);
    if (o[57]) {
      const g = new Int32Array(o[57].split('.').map(Number));
      L.groups[i] = g;
      for (const gid of g) { let a = L.groupObjs.get(gid); if (!a) L.groupObjs.set(gid, a = []); a.push(i); }
    } else L.groups[i] = null;
    if (id === 914 && o[31]) { try { L.text.set(i, new TextDecoder().decode(b64ToBytes(o[31]))); } catch (_) {} }
    if (o[103] === '1') L.hd[i] = 1;              // "High Detail": hidden when Low Detail Mode is on
    if (o[41] === '1' && o[43]) L.hsv1.set(i, parseHSV(o[43]));
    if (o[42] === '1' && o[44]) L.hsv2.set(i, parseHSV(o[44]));
    const c = classTab[id];
    let noTouch = o[121] === '1' || o[134] === '1';
    if (!noTouch && c && ['solid', 'hazard', 'slope'].includes(c[0])) {
      const big = Math.max(Math.abs(L.sx[i]), Math.abs(L.sy[i]));
      if (opts.maxScale && big > opts.maxScale) noTouch = true;
      if (opts.dropOdd) { const r = ((L.rot[i] % 90) + 90) % 90; if (Math.min(r, 90 - r) > 1) noTouch = true; }
    }
    if (c && !(noTouch && ['solid', 'hazard', 'saw', 'slope'].includes(c[0]))) {
      L.cls[i] = CLS[c[0]] || 0;
      L.sub[i] = c[0] === 'trig' || c[0] === 'orb' || c[0] === 'pad' ? c[1] : (L.cls[i] === 7 ? c : c[1]);
      if (L.cls[i] === 1 || L.cls[i] === 2) L.hb[i] = c[1];
      if (L.cls[i] >= 7 || L.cls[i] === 5 || L.cls[i] === 6) L.extra[i] = o;
      if (L.cls[i] === 8) L.triggers.push(i);
      if (L.cls[i] === 9) L.startPositions.push(i);
    }
    if (L.cls[i] !== 8 && L.x[i] > L.maxX) L.maxX = L.x[i];
  }
  L.n = n;
  // Spatial chunks (by base x). Objects at x < 0 go to chunk 0.
  const nc = Math.ceil((L.maxX + 600) / CHUNK) + 1;
  const lists = Array.from({ length: nc }, () => []);
  for (let i = 0; i < n; i++) {
    if (L.cls[i] === 8 || L.cls[i] === 9) continue;
    const c = Math.max(0, Math.min(nc - 1, Math.floor(L.x[i] / CHUNK)));
    lists[c].push(i);
  }
  // Render order inside a chunk: z layer, then z order
  for (const a of lists) a.sort((u, v) => (L.zl[u] - L.zl[v]) || (L.zo[u] - L.zo[v]));
  L.chunks = lists.map(a => new Int32Array(a));
  L.triggers.sort((a, b) => L.x[a] - L.x[b]);
  L.startPositions.sort((a, b) => L.x[a] - L.x[b]);
  // Groups that triggers move or rotate: their objects are "dynamic"
  L.movedGroups = new Set();
  for (const t of L.triggers) {
    const k = L.sub[t], e = L.extra[t];
    if ((k === 'move' || k === 'rotate') && e[51]) L.movedGroups.add(+e[51]);
  }
  L.isDynamic = new Uint8Array(n);
  L.groupPlay = new Map(); L.groupBox = new Map(); L.groupAllBox = new Map();
  for (const g of L.movedGroups) {
    const play = []; let a = [1e9, 1e9, -1e9, -1e9], b = [1e9, 1e9, -1e9, -1e9];
    for (const i of (L.groupObjs.get(g) || [])) {
      L.isDynamic[i] = 1;
      const r = 60 * Math.max(Math.abs(L.sx[i]), Math.abs(L.sy[i]), 1);
      b[0] = Math.min(b[0], L.x[i] - r); b[1] = Math.min(b[1], L.y[i] - r); b[2] = Math.max(b[2], L.x[i] + r); b[3] = Math.max(b[3], L.y[i] + r);
      const cl = L.cls[i];
      if (cl === 0 || cl >= 8) continue;
      play.push(i);
      a[0] = Math.min(a[0], L.x[i] - r); a[1] = Math.min(a[1], L.y[i] - r); a[2] = Math.max(a[2], L.x[i] + r); a[3] = Math.max(a[3], L.y[i] + r);
    }
    if (play.length) { L.groupPlay.set(g, new Int32Array(play)); L.groupBox.set(g, a); }
    L.groupAllBox.set(g, b);
  }
  // Buckets keyed by an object's ordered list of moved groups, so the full combined movement is exact
  const sig = new Map();
  for (let i = 0; i < n; i++) {
    if (!L.isDynamic[i]) continue;
    const mg = [...L.groups[i]].filter(q => L.movedGroups.has(q));
    const key = mg.join('.');
    let b = sig.get(key);
    if (!b) sig.set(key, b = { groups: new Int32Array(mg), play: [], all: [], pbox: [1e9, 1e9, -1e9, -1e9], abox: [1e9, 1e9, -1e9, -1e9] });
    const r = 60 * Math.max(Math.abs(L.sx[i]), Math.abs(L.sy[i]), 1);
    const grow = bx => { bx[0] = Math.min(bx[0], L.x[i] - r); bx[1] = Math.min(bx[1], L.y[i] - r); bx[2] = Math.max(bx[2], L.x[i] + r); bx[3] = Math.max(bx[3], L.y[i] + r); };
    b.all.push(i); grow(b.abox);
    const cl = L.cls[i];
    if (cl !== 0 && cl < 8) { b.play.push(i); grow(b.pbox); }
  }
  L.buckets = [...sig.values()].map(b => ({ groups: b.groups, play: new Int32Array(b.play), all: new Int32Array(b.all), pbox: b.pbox, abox: b.abox }));
  L.stamp = new Uint32Array(n);
  L.length = L.maxX + 90;
  return L;
}

/* ---------------- easing (GD easing ids) ---------------- */
function ease(type, p, rate) {
  rate = rate || 2;
  const bounceOut = t => { const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t; if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375; return n1 * (t -= 2.625 / d1) * t + 0.984375; };
  const elasticOut = t => t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
  switch (type) {
    case 1: return p < 0.5 ? Math.pow(2 * p, rate) / 2 : 1 - Math.pow(2 * (1 - p), rate) / 2;
    case 2: return Math.pow(p, rate);
    case 3: return 1 - Math.pow(1 - p, rate);
    case 4: return p < 0.5 ? (1 - elasticOut(1 - 2 * p)) / 2 : (1 + elasticOut(2 * p - 1)) / 2;
    case 5: return 1 - elasticOut(1 - p);
    case 6: return elasticOut(p);
    case 7: return p < 0.5 ? (1 - bounceOut(1 - 2 * p)) / 2 : (1 + bounceOut(2 * p - 1)) / 2;
    case 8: return 1 - bounceOut(1 - p);
    case 9: return bounceOut(p);
    case 10: return p === 0 || p === 1 ? p : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2;
    case 11: return p === 0 ? 0 : Math.pow(2, 10 * p - 10);
    case 12: return p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    case 13: return -(Math.cos(Math.PI * p) - 1) / 2;
    case 14: return 1 - Math.cos(p * Math.PI / 2);
    case 15: return Math.sin(p * Math.PI / 2);
    case 16: { const c = 1.70158 * 1.525; return p < 0.5 ? (Math.pow(2 * p, 2) * ((c + 1) * 2 * p - c)) / 2 : (Math.pow(2 * p - 2, 2) * ((c + 1) * (p * 2 - 2) + c) + 2) / 2; }
    case 17: { const c = 1.70158; return (c + 1) * p * p * p - c * p * p; }
    case 18: { const c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }
    default: return p;
  }
}

/* ---------------- group transforms (affine per group) ---------------- */
// Each moved group has [a, b, c, d, tx, ty, angleDeg]; identity when absent.
function applyAffine(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

/* ---------------- simulation ---------------- */

class Sim {
  constructor(L, opts = {}) {
    this.L = L;
    this.opts = opts;
    this.reset(opts.startIndex ?? -1);
  }

  /* ----- state ----- */
  reset(startIndex = -1) {
    const L = this.L, h = L.header;
    this.tick = 0; this.time = 0;
    this.dead = false; this.won = false; this.deathTick = -1;
    this.held = false; this.pressQueue = []; this.buffered = false;
    this.speedIdx = HDR_SPEED[+h.kA4 || 0] ?? 1;
    this.mirror = 0; this.dual = (h.kA8 === '1');
    this.groupM = new Map();     // group -> affine
    this.groupAlpha = new Map(); // group -> opacity
    this.groupOff = new Set();   // toggled-off groups
    this.colors = Object.assign(defaultColors(), JSON.parse(JSON.stringify(L.initColors))); this.colorTweens = [];
    this.blend = new Set(L.initBlend);
    this.tweens = []; this.alphaTweens = []; this.pending = []; // pending spawn: {tick, group}
    this.trigPtr = 0; this.used = new Set(); // used orbs/pads/portals
    this.startX = 0;
    const mode = MODES[+h.kA2 || 0] || 'cube';
    let px = 0, py = 15, mini = h.kA3 === '1', flip = h.kA11 === '1';
    if (startIndex >= 0) {
      const sp = L.startPositions[startIndex]; const e = L.extra[sp] || {};
      px = L.x[sp]; py = L.y[sp];
      this.speedIdx = HDR_SPEED[+e.kA4 || 0] ?? 1;
      this.dual = e.kA8 === '1'; mini = e.kA3 === '1'; flip = e.kA11 === '1';
      this.startX = px;
    }
    const startMode = startIndex >= 0 ? (MODES[+(L.extra[L.startPositions[startIndex]] || {}).kA2 || 0] || 'cube') : mode;
    this.players = [this.makePlayer(px, py, startMode, mini, flip)];
    if (this.dual) this.players.push(this.makePlayer(px, py, startMode, mini, !flip));
    for (const p of this.players) this.setBounds(p, py);
    if (startIndex >= 0 && this.opts.ff !== 'none') this.fastForwardTriggers(px);
  }

  makePlayer(x, y, mode, mini, flip) {
    return { x, y, vy: 0, mode, mini, g: flip ? -1 : 1, grounded: false, rot: 0,
      boost: 0, dash: null, lo: 0, hi: 1e9, bounded: false, prevY: y };
  }

  setBounds(p, refY) {
    const h = BOUND_H[p.mode];
    if (!h) { p.bounded = false; p.lo = 0; p.hi = 1e9; return; }
    const center = Math.round(refY / 30) * 30;
    let lo = Math.max(0, center - h / 2);
    p.lo = lo; p.hi = lo + h; p.bounded = true;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({
      tick: this.tick, time: this.time, speedIdx: this.speedIdx, mirror: this.mirror, dual: this.dual,
      players: this.players, groupM: [...this.groupM], groupAlpha: [...this.groupAlpha], groupOff: [...this.groupOff],
      colors: this.colors, colorTweens: this.colorTweens, tweens: this.tweens, alphaTweens: this.alphaTweens,
      pending: this.pending, trigPtr: this.trigPtr, used: [...this.used], blend: [...this.blend],
    }));
  }
  restore(s) {
    const c = JSON.parse(JSON.stringify(s));
    Object.assign(this, c);
    this.groupM = new Map(c.groupM); this.groupAlpha = new Map(c.groupAlpha); this.groupOff = new Set(c.groupOff);
    this.used = new Set(c.used); this.blend = new Set(c.blend || []);
    this.dead = false; this.won = false; this.held = false; this.buffered = false; this.pressQueue = [];
  }

  /* ----- input: events carry the tick they happened on ----- */
  input(down, tick) { this.pressQueue.push({ down, tick: Math.max(tick, this.tick) }); }

  /* ----- object helpers ----- */
  objActive(i) {
    const g = this.L.groups[i];
    if (!g || this.groupOff.size === 0) return true;
    for (const gid of g) if (this.groupOff.has(gid)) return false;
    return true;
  }
  objMatrix(i) {
    const g = this.L.groups[i];
    if (!g || !this.L.isDynamic[i]) return null;
    let m = null;
    for (const gid of g) {
      const gm = this.groupM.get(gid); if (!gm) continue;
      m = m ? mul(gm, m) : gm;
    }
    return m;
  }
  bucketMatrix(b) {
    let m = null;
    for (const gid of b.groups) { const gm = this.groupM.get(gid); if (!gm) continue; m = m ? mul(gm, m) : gm; }
    return m;
  }
  objPos(i) {
    const m = this.objMatrix(i);
    if (!m) return [this.L.x[i], this.L.y[i], 0];
    const p = applyAffine(m, this.L.x[i], this.L.y[i]);
    return [p[0], p[1], m[6] || 0];
  }

  // Collect gameplay object indices near [x0,x1] (deduplicated)
  nearby(x0, x1, out) {
    const L = this.L; out.length = 0;
    const st = (L.stampN = ((L.stampN || 0) + 1) >>> 0 || 1);
    const c0 = Math.max(0, Math.floor((x0 - 120) / CHUNK)), c1 = Math.min(L.chunks.length - 1, Math.floor((x1 + 120) / CHUNK));
    for (let c = c0; c <= c1; c++) {
      const a = L.chunks[c];
      for (let k = 0; k < a.length; k++) {
        const i = a[k]; const cl = L.cls[i];
        if (cl === 0 || cl >= 8) continue;
        if (L.isDynamic[i] && this.objMatrix(i)) continue; // moved: found via its group below
        if (L.stamp[i] === st) continue; L.stamp[i] = st;
        out.push(i);
      }
    }
    for (const b of L.buckets) {
      if (!b.play.length) continue;
      const m = this.bucketMatrix(b); if (!m) continue;
      if (!boxHitsX(m, b.pbox, x0 - 120, x1 + 120)) continue;
      const objs = b.play;
      for (let k = 0; k < objs.length; k++) {
        const i = objs[k]; if (L.stamp[i] === st) continue;
        const px = m[0] * L.x[i] + m[2] * L.y[i] + m[4];
        if (px > x0 - 120 && px < x1 + 120) { L.stamp[i] = st; out.push(i); }
      }
    }
    return out;
  }

  /* ----- main step ----- */
  step() {
    if (this.dead || this.won) { this.tick++; return; }
    // inputs scheduled for this tick
    while (this.pressQueue.length && this.pressQueue[0].tick <= this.tick) {
      const ev = this.pressQueue.shift();
      if (ev.down && !this.held) { this.held = true; this.buffered = true; this.pressedThisTick = true; }
      else if (!ev.down) { this.held = false; this.buffered = false; for (const p of this.players) p.dash = null; }
    }
    const speed = SPEEDS[this.speedIdx];
    this.processTriggers();
    for (const p of this.players) this.stepPlayer(p, speed);
    if (this.dual && this.players.length === 2) {
      // keep both players on the same x
      this.players[1].x = this.players[0].x;
    }
    this.pressedThisTick = false;
    this.tick++; this.time = this.tick * DT;
    if (this.players[0].x >= this.L.length) this.won = true;
  }

  stepPlayer(p, speed) {
    const L = this.L;
    const mode = p.mode, mini = p.mini;
    const size = mode === 'wave' ? (mini ? 6 : 10) : (mini ? 18 : 30);
    const inner = mode === 'wave' ? size : (mini ? 5.4 : 9);
    let u = p.vy * p.g; // velocity along "up" relative to gravity, units/s

    // ---- mode input & gravity ----
    const hold = this.held;
    const press = this.buffered;
    if (p.dash) {
      u = 0;
    } else if (mode === 'cube') {
      const P = PHYS.cube;
      if (p.grounded && hold) { u = P.jump * F * (mini ? PHYS.miniJump : 1); p.grounded = false; this.buffered = false; }
      else u -= P.g * F * F * DT;
      u = Math.max(u, -P.maxFall * F);
    } else if (mode === 'robot') {
      const P = PHYS.robot;
      if (p.grounded && press) { p.boost = P.boostFrames / 60; u = P.jump * F * (mini ? PHYS.miniJump : 1); p.grounded = false; this.buffered = false; }
      if (p.boost > 0 && hold) { p.boost -= DT; u = Math.max(u, P.jump * F * (mini ? PHYS.miniJump : 1)); }
      else { p.boost = 0; u -= P.g * F * F * DT; }
      u = Math.max(u, -P.maxFall * F);
    } else if (mode === 'ball') {
      const P = PHYS.ball;
      if (p.grounded && press) { p.g = -p.g; u = -P.flipV * F; p.grounded = false; this.buffered = false; }
      else u -= P.g * F * F * DT;
      u = Math.max(u, -P.maxFall * F);
    } else if (mode === 'spider') {
      const P = PHYS.spider;
      if (p.grounded && press) { this.spiderTeleport(p, size); this.buffered = false; u = 0; }
      else u -= P.g * F * F * DT;
      u = Math.max(u, -P.maxFall * F);
    } else if (mode === 'ufo') {
      const P = PHYS.ufo;
      if (this.pressedThisTick && press) { u = P.jump * F * (mini ? PHYS.miniJump : 1); this.buffered = false; p.grounded = false; }
      else u -= P.g * F * F * DT;
      u = Math.max(u, -P.maxFall * F);
    } else if (mode === 'ship') {
      const P = PHYS.ship; const k = mini ? PHYS.miniShip : 1;
      u += (hold ? P.up : -P.down) * k * F * F * DT;
      u = Math.min(P.maxUp * F, Math.max(-P.maxDown * F, u));
    } else if (mode === 'swing') {
      const P = PHYS.swing;
      if (this.pressedThisTick && press) { p.g = -p.g; u = -u * 0.5; this.buffered = false; }
      u -= P.g * F * F * DT;
      u = Math.min(P.maxV * F, Math.max(-P.maxV * F, u));
    } else if (mode === 'wave') {
      u = (hold ? 1 : -1) * speed * (mini ? 2 : 1);
    }

    // ---- integrate ----
    p.prevY = p.y; const prevX = p.x;
    if (p.dash) {
      p.x += Math.cos(p.dash) * speed * DT; p.y += Math.sin(p.dash) * speed * DT;
    } else {
      p.x += speed * DT;
      p.y += u * p.g * DT;
    }
    p.vy = u * p.g;

    // ---- collisions ----
    const half = size / 2, ih = inner / 2;
    const near = this._near || (this._near = []);
    this.nearby(p.x - 60, p.x + 60, near);
    let landed = false;
    // ground / bounds
    const floorY = p.bounded ? p.lo : 0, ceilY = p.bounded ? p.hi : 1e9;
    if (p.y - half < floorY) { p.y = floorY + half; if (p.g > 0) landed = true; if (p.vy < 0) p.vy = 0; }
    if (p.y + half > ceilY) { p.y = ceilY - half; if (p.g < 0) landed = true; if (p.vy > 0) p.vy = 0; }

    // pass 1: solids & slopes resolve vertically (skipped entirely in noclip: pass through everything)
    for (const i of (this.opts.noclip ? [] : near)) {
      const cl = L.cls[i];
      if ((cl !== 1 && cl !== 4) || !this.objActive(i)) continue;
      if (cl === 1) {
        const r = this.rectOf(i); if (!r) continue;
        if (p.x + half <= r[0] || p.x - half >= r[2] || p.y + half <= r[1] || p.y - half >= r[3]) continue;
        // Decide the side from where the player was last tick: from above = land on top,
        // from below = ceiling; otherwise it came in from the side (a wall if the core overlaps).
        const tol = 1.0;
        const wasAbove = p.prevY - half >= r[3] - tol, wasBelow = p.prevY + half <= r[1] + tol;
        let top;
        if (wasAbove) top = true;
        else if (wasBelow) top = false;
        else {
          if (p.x + ih > r[0] && p.x - ih < r[2] && p.y + ih > r[1] && p.y - ih < r[3]) continue; // wall: death pass
          top = (r[3] - (p.y - half)) < ((p.y + half) - r[1]);                               // small step-up/down
        }
        if (top) { p.y = r[3] + half; if (p.g > 0) landed = true; if (p.vy < 0) p.vy = 0; }
        else { p.y = r[1] - half; if (p.g < 0) landed = true; if (p.vy > 0) p.vy = 0; }
      } else {
        const t = this.slopeOf(i); if (!t) continue;
        if (this.resolveSlope(p, t, half, speed)) landed = true;
      }
    }
    p.grounded = landed;
    if (landed && mode === 'ufo') p.vy = 0;

    // pass 2: death checks + interactions
    for (const i of near) {
      const cl = L.cls[i];
      if (!this.objActive(i)) continue;
      if (cl === 1) {
        const r = this.rectOf(i); if (!r) continue;
        if (p.x + ih - 0.01 > r[0] && p.x - ih + 0.01 < r[2] && p.y + ih - 0.01 > r[1] && p.y - ih + 0.01 < r[3]) {
          if (!this.opts.safe) { if (this.hurt(p, i)) return; continue; }   // noclip/normal: never fall into Safe mode code
          // Safe mode: push out to the nearer side (top or bottom) and keep going
          const top = p.y >= (r[1] + r[3]) / 2;
          if (top) { p.y = r[3] + half; if (p.vy < 0) p.vy = 0; if (p.g > 0) p.grounded = true; }
          else { p.y = r[1] - half; if (p.vy > 0) p.vy = 0; if (p.g < 0) p.grounded = true; }
        }
      } else if (cl === 2) {
        const r = this.rectOf(i); if (!r) continue;
        if (this.opts.safe) continue;
        if (p.x + half > r[0] && p.x - half < r[2] && p.y + half > r[1] && p.y - half < r[3]) { if (this.hurt(p, i)) return; }
      } else if (cl === 3) {
        if (this.opts.safe) continue;
        const q = this.objPos(i); const rad = 12 * Math.max(L.sx[i], L.sy[i]) * (L.sub[i] || 1);
        const dx = Math.max(Math.abs(p.x - q[0]) - half, 0), dy = Math.max(Math.abs(p.y - q[1]) - half, 0);
        if (dx * dx + dy * dy < rad * rad) { if (this.hurt(p, i)) return; }
      } else if (cl === 4) {
        const t = this.slopeOf(i);
        if (t && triRectOverlap(t, p.x - ih + 0.5, p.y - ih + 0.5, p.x + ih - 0.5, p.y + ih - 0.5)) {
          if (!this.opts.safe) { if (this.hurt(p, i)) return; continue; }
          p.y = Math.max(t[1], t[3], t[5]) + half; if (p.vy < 0) p.vy = 0; if (p.g > 0) p.grounded = true;   // Safe mode: lift above
        }
      } else if (cl === 5 || cl === 6 || cl === 7) {
        this.interact(p, i, half, speed);
      }
    }
    // pads/orbs may change vy; rotation for cube visuals
    if (mode === 'cube' || mode === 'robot') {
      if (p.grounded) p.rot = Math.round(p.rot / 90) * 90; else p.rot += 410 * DT * p.g;
    } else if (mode === 'ball') p.rot += 600 * DT * p.g;
    else if (mode === 'ship' || mode === 'swing') p.rot = -Math.atan2(p.vy, speed) * 180 / Math.PI * 0.6;
    else if (mode === 'wave') p.rot = -Math.atan2(p.vy, speed) * 180 / Math.PI;
    else p.rot = 0;
    if (p.y < -400 || p.y > 4000) {
      if (!this.opts.safe) { if (this.hurt(p, -1)) return; }
      else { p.y = p.y < 0 ? (p.bounded ? p.lo : 0) + half : (p.bounded ? p.hi - half : 3900); p.vy = 0; }   // Safe mode: back inside
    }
  }

  rectOf(i) {
    const L = this.L, h = L.hb[i]; if (!h) return null;
    const q = this.objPos(i);
    let w = h[0] * Math.abs(L.sx[i]), hh = h[1] * Math.abs(L.sy[i]);
    let ox = h[2] * L.sx[i], oy = h[3] * L.sy[i];
    if (L.fx[i]) ox = -ox; if (L.fy[i]) oy = -oy;
    const rot = (((L.rot[i] + q[2]) % 360) + 360) % 360;
    const r = Math.round(rot / 90) % 4;
    let rx = ox, ry = oy;
    // GD rotation is clockwise; y up
    if (r === 1) { [rx, ry] = [oy, -ox]; [w, hh] = [hh, w]; }
    else if (r === 2) { rx = -ox; ry = -oy; }
    else if (r === 3) { [rx, ry] = [-oy, ox]; [w, hh] = [hh, w]; }
    const cx = q[0] + rx, cy = q[1] + ry;
    return [cx - w / 2, cy - hh / 2, cx + w / 2, cy + hh / 2];
  }

  // Slope triangle in world space: [x1,y1,x2,y2,x3,y3]; default solid half = bottom-right (rises to the right)
  slopeOf(i) {
    const L = this.L; const q = this.objPos(i);
    const wide = L.sub[i] === 2 ? 2 : 1;
    const w = 30 * wide * Math.abs(L.sx[i]), h = 30 * Math.abs(L.sy[i]);
    let pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2]];
    const fx = L.fx[i] ? -1 : 1, fy = L.fy[i] ? -1 : 1;
    const a = -((L.rot[i] + q[2]) * Math.PI / 180);
    const ca = Math.cos(a), sa = Math.sin(a);
    const out = [];
    for (const [px, py] of pts) {
      const x = px * fx, y = py * fy;
      out.push(q[0] + x * ca - y * sa, q[1] + x * sa + y * ca);
    }
    return out;
  }

  resolveSlope(p, t, half, speed) {
    const minX = Math.min(t[0], t[2], t[4]), maxX = Math.max(t[0], t[2], t[4]);
    const minY = Math.min(t[1], t[3], t[5]), maxY = Math.max(t[1], t[3], t[5]);
    if (p.x + half <= minX || p.x - half >= maxX || p.y + half <= minY || p.y - half >= maxY) return false;
    // find hypotenuse (edge not axis aligned)
    let e = null;
    for (let k = 0; k < 3; k++) {
      const x1 = t[k * 2], y1 = t[k * 2 + 1], x2 = t[((k + 1) % 3) * 2], y2 = t[((k + 1) % 3) * 2 + 1];
      if (Math.abs(x1 - x2) > 0.5 && Math.abs(y1 - y2) > 0.5) e = [x1, y1, x2, y2];
    }
    if (!e) return false;
    const [x1, y1, x2, y2] = e;
    const slope = (y2 - y1) / (x2 - x1);
    // is the solid side below the hypotenuse? test third vertex
    let ox, oy; for (let k = 0; k < 3; k++) { const vx = t[k * 2], vy = t[k * 2 + 1]; if (!((vx === x1 && vy === y1) || (vx === x2 && vy === y2))) { ox = vx; oy = vy; } }
    const lineAt = x => y1 + slope * (x - x1);
    const solidBelow = oy < lineAt(ox);
    // sample at the player's leading/trailing corner nearest the surface
    const sx = solidBelow ? (slope > 0 ? p.x + half : p.x - half) : (slope > 0 ? p.x - half : p.x + half);
    const cx = Math.max(minX, Math.min(maxX, sx));
    const surf = lineAt(cx);
    if (solidBelow) {
      const bottom = p.y - half;
      if (bottom < surf && bottom > minY - half) {
        p.y = surf + half;
        if (p.vy < 0 || p.g > 0) p.vy = Math.max(p.vy, 0);
        if (p.mode === 'wave') p.vy = 0;
        return p.g > 0;
      }
    } else {
      const top = p.y + half;
      if (top > surf && top < maxY + half) {
        p.y = surf - half;
        if (p.vy > 0) p.vy = 0;
        return p.g < 0;
      }
    }
    return false;
  }

  interact(p, i, half, speed) {
    const L = this.L; const cl = L.cls[i];
    const q = this.objPos(i);
    const key = i * 4 + this.players.indexOf(p);
    if (cl === 7) {
      // portals: tall hitbox, rotated with object
      const rot = Math.round(((L.rot[i] % 360) + 360) % 360 / 90) % 2;
      const sub = L.sub[i]; const kind = sub[0];
      let w = (kind === 'speed' ? 34 : 34) * Math.abs(L.sx[i]), h = (kind === 'speed' ? 44 : 86) * Math.abs(L.sy[i]);
      if (rot) [w, h] = [h, w];
      if (Math.abs(p.x - q[0]) > w / 2 + half || Math.abs(p.y - q[1]) > h / 2 + half) return;
      if (this.used.has(key)) return; this.used.add(key);
      const v = sub[1];
      if (kind === 'speed') this.speedIdx = v;
      else if (kind === 'grav') {
        const ng = v === 0 ? 1 : v === 1 ? -1 : -p.g;
        if (ng !== p.g) { p.g = ng; p.vy *= 0.5; p.grounded = false; }
      } else if (kind === 'mode') {
        p.mode = MODES[v]; p.dash = null; p.boost = 0;
        this.setBounds(p, q[1]);
        if (p.mode === 'ship' || p.mode === 'ufo' || p.mode === 'swing' || p.mode === 'wave') p.vy *= 0.5;
      } else if (kind === 'size') p.mini = v === 1;
      else if (kind === 'mirror') this.mirror = v;
      else if (kind === 'dual') {
        if (v === 1 && this.players.length === 1) {
          const b = { ...p, g: -p.g, vy: -p.vy }; this.players.push(b); this.dual = true;
        } else if (v === 0 && this.players.length === 2) { this.players.length = 1; this.dual = false; }
      } else if (kind === 'tele') {
        const off = L.extra[i] && L.extra[i][54] ? +L.extra[i][54] : 90;
        p.y += off;
      }
      return;
    }
    // orbs & pads: roughly 36x36 / 30x10 hitboxes
    const ow = cl === 5 ? 36 * Math.abs(L.sx[i]) : 26 * Math.abs(L.sx[i]);
    const oh = cl === 5 ? 36 * Math.abs(L.sy[i]) : 10 * Math.abs(L.sy[i]);
    if (Math.abs(p.x - q[0]) > ow / 2 + half || Math.abs(p.y - q[1]) > oh / 2 + half) return;
    if (this.used.has(key)) return;
    const mult = MODE_ORB_MULT[p.mode] * (p.mini ? 0.8 : 1);
    const kind = L.sub[i];
    if (cl === 6) {
      this.used.add(key);
      if (kind === 'blue') { p.g = -p.g; p.vy = -p.g * 2 * F; p.grounded = false; return; }
      const v = PAD_V[kind]; if (!v) return;
      if (p.mode === 'wave') return;
      p.vy = v * F * (mult || 0.7) * p.g; p.grounded = false;
      return;
    }
    // orb: needs a buffered click
    if (!this.buffered) return;
    this.used.add(key); this.buffered = false;
    if (kind === 'blue') { p.g = -p.g; p.vy = -p.g * 2 * F * (mult ? 1 : 0); p.grounded = false; return; }
    if (kind === 'green') { p.g = -p.g; if (mult) p.vy = ORB_V.yellow * F * mult * p.g; p.grounded = false; return; }
    if (kind === 'dashg' || kind === 'dashp') {
      if (kind === 'dashp') p.g = -p.g;
      p.dash = -(L.rot[i] || 0) * Math.PI / 180; return;
    }
    if (kind === 'spider') { this.spiderTeleport(p, half * 2); return; }
    const v = ORB_V[kind]; if (v === undefined || !mult) return;
    p.vy = v * F * mult * p.g; p.grounded = false;
    if (p.mode === 'robot') p.boost = 0;
  }

  spiderTeleport(p, size) {
    // travel against gravity until a surface is hit (or the bound)
    const half = size / 2; const near = this.nearby(p.x - 30, p.x + 30, []);
    let target = p.bounded ? (p.g > 0 ? p.hi - half : p.lo + half) : (p.g > 0 ? p.y + 600 : half);
    for (const i of near) {
      if (this.L.cls[i] !== 1 || !this.objActive(i)) continue;
      const r = this.rectOf(i); if (!r || p.x + half <= r[0] || p.x - half >= r[2]) continue;
      if (p.g > 0 && r[1] >= p.y + half - 1 && r[1] - half < target) target = r[1] - half;
      if (p.g < 0 && r[3] <= p.y - half + 1 && r[3] + half > target) target = r[3] + half;
    }
    p.y = target; p.g = -p.g; p.vy = 0; p.grounded = true;
  }

  // returns true when the step should stop (a real death); noclip hits only flash
  hurt(p, i) { this.die(p, i); return !this.opts.noclip; }
  die(p, i) { this.killer = i; if (this.opts.deathLog) { const k = i < 0 ? 'out-of-bounds' : this.L.id[i]; this.opts.deathLog[k] = (this.opts.deathLog[k] || 0) + 1; }
    if (this.opts.noclip) return;
    this.dead = true; this.deathTick = this.tick; this.deathPlayer = p;
  }

  /* ----- triggers ----- */
  processTriggers() {
    const L = this.L; const px = this.players[0].x;
    while (this.trigPtr < L.triggers.length && L.x[L.triggers[this.trigPtr]] <= px) {
      const t = L.triggers[this.trigPtr++];
      const e = L.extra[t];
      if (e[62] === '1') continue;   // spawn-triggered only
      if (e[11] === '1') { this.touchTriggers = this.touchTriggers || []; }
      this.fire(t, false);
    }
    // spawn delays
    if (this.pending.length) {
      const due = this.pending.filter(s => s.tick <= this.tick);
      if (due.length) { this.pending = this.pending.filter(s => s.tick > this.tick); for (const s of due) this.spawnGroup(s.group, false); }
    }
    this.updateTweens();
  }

  spawnGroup(g, instant, depth = 0) {
    const objs = this.L.groupObjs.get(g); if (!objs || depth > 32) return;
    for (const i of objs) {
      if (this.L.cls[i] !== 8) continue;
      const e = this.L.extra[i];
      if (e[62] !== '1') continue;                  // only "spawn triggered" triggers respond
      if (e[87] !== '1') {                          // non-multi triggers fire once
        if (this.used.has(-i - 1)) continue;
        this.used.add(-i - 1);
      }
      this.fire(i, instant, depth + 1);
    }
  }

  fire(t, instant, depth = 0) {
    const L = this.L, e = L.extra[t], kind = L.sub[t];
    if (instant && this.opts.ff === 'nomove' && (kind === 'move' || kind === 'rotate')) return;
    const dur = instant ? 0 : (+e[10] || 0);
    const g = +e[51] || 0;
    switch (kind) {
      case 'move': {
        const dx = +e[28] || 0, dy = +e[29] || 0;
        this.tweens.push({ type: 'move', g, dx, dy, t0: this.tick, dur: Math.max(dur, 0), ease: +e[30] || 0, rate: +e[85] || 2, last: 0, lockX: e[58] === '1', lockY: e[59] === '1' });
        break;
      }
      case 'rotate': {
        const deg = (+e[68] || 0) + 360 * (+e[69] || 0);
        this.tweens.push({ type: 'rot', g, deg, center: +e[71] || 0, t0: this.tick, dur, ease: +e[30] || 0, rate: +e[85] || 2, last: 0 });
        break;
      }
      case 'alpha':
        this.alphaTweens.push({ g, from: this.groupAlpha.get(g) ?? 1, to: +(e[35] ?? 1), t0: this.tick, dur });
        break;
      case 'toggle':
        if (e[56] === '1') this.groupOff.delete(g); else this.groupOff.add(g);
        break;
      case 'spawn': {
        const delay = instant ? 0 : (+e[63] || 0);
        if (delay <= 0) this.spawnGroup(g, instant, depth); else if (this.pending.length < 4096) this.pending.push({ tick: this.tick + Math.round(delay * TPS), group: g });
        break;
      }
      case 'stop':
        this.tweens = this.tweens.filter(w => w.g !== g);
        this.pending = this.pending.filter(s => s.group !== g);
        break;
      case 'color': case 'bg': case 'ground': case 'obj': case 'l3': {
        const ch = kind === 'bg' ? 1000 : kind === 'ground' ? 1001 : kind === 'obj' ? 1004 : kind === 'l3' ? 1003 : (+e[23] || 1);
        let to;
        if (e[50] && this.colors[+e[50]]) to = this.colors[+e[50]].slice();
        else to = [+e[7] || 0, +e[8] || 0, +e[9] || 0, e[35] !== undefined ? +e[35] : 1];
        if (kind === 'color') { if (e[17] === '1') this.blend.add(ch); else this.blend.delete(ch); }
        const from = (this.colors[ch] || [255, 255, 255, 1]).slice();
        if (dur <= 0) this.colors[ch] = to; else this.colorTweens.push({ ch, from, to, t0: this.tick, dur });
        break;
      }
      default: break;
    }
  }

  updateTweens() {
    if (this.tweens.length) {
      const keep = [];
      for (const w of this.tweens) {
        const p = w.dur <= 0 ? 1 : Math.min(1, (this.tick - w.t0) / (w.dur * TPS));
        const e = ease(w.ease, p, w.rate);
        const d = e - w.last; w.last = e;
        if (w.type === 'move') {
          let dx = w.dx * d, dy = w.dy * d;
          if (w.lockX) dx += SPEEDS[this.speedIdx] * DT;
          if (dx || dy) this.translateGroup(w.g, dx, dy);
        } else if (d) {
          this.rotateGroup(w.g, w.deg * d, w.center);
        }
        if (p < 1 || w.lockX) keep.push(w); else if (w.lockX && p >= 1) {}
      }
      this.tweens = keep.filter(w => !(w.lockX && (this.tick - w.t0) >= w.dur * TPS));
    }
    if (this.alphaTweens.length) {
      this.alphaTweens = this.alphaTweens.filter(a => {
        const p = a.dur <= 0 ? 1 : Math.min(1, (this.tick - a.t0) / (a.dur * TPS));
        this.groupAlpha.set(a.g, a.from + (a.to - a.from) * p); return p < 1;
      });
    }
    if (this.colorTweens.length) {
      this.colorTweens = this.colorTweens.filter(c => {
        const p = Math.min(1, (this.tick - c.t0) / (c.dur * TPS));
        this.colors[c.ch] = c.from.map((v, k) => v + (c.to[k] - v) * p); return p < 1;
      });
    }
  }

  translateGroup(g, dx, dy) {
    const m = this.groupM.get(g) || [1, 0, 0, 1, 0, 0, 0];
    m[4] += dx; m[5] += dy; this.groupM.set(g, m);
  }
  rotateGroup(g, deg, centerGroup) {
    const m = this.groupM.get(g) || [1, 0, 0, 1, 0, 0, 0];
    // rotation center: current position of the center group's first object (or the group's own first object)
    let cx = 0, cy = 0;
    const cobjs = this.L.groupObjs.get(centerGroup || g);
    if (cobjs && cobjs.length) { const q = this.objPos(cobjs[0]); cx = q[0]; cy = q[1]; }
    const a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    // R about (cx,cy) composed after m
    const R = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy, 0];
    const nm = mul(R, m); nm[6] = (m[6] || 0) + deg;
    this.groupM.set(g, nm);
  }

  fastForwardTriggers(x) {
    const L = this.L;
    while (this.trigPtr < L.triggers.length && L.x[L.triggers[this.trigPtr]] <= x) {
      const t = L.triggers[this.trigPtr++];
      if (L.extra[t][62] === '1') continue;
      this.fire(t, true);
    }
    // finish all tweens instantly
    for (const w of this.tweens) { w.dur = 0; }
    this.updateTweens(); this.tweens = [];
    for (const a of this.alphaTweens) a.dur = 0;
    for (const c of this.colorTweens) this.colors[c.ch] = c.to;
    this.alphaTweens = []; this.colorTweens = [];
    for (const s of this.pending) this.spawnGroup(s.group, true);
    this.pending = [];
  }
}

function boxHitsX(m, b, x0, x1) {
  let mn = 1e9, mx = -1e9;
  for (let k = 0; k < 4; k++) {
    const x = k & 1 ? b[2] : b[0], y = k & 2 ? b[3] : b[1];
    const tx = m[0] * x + m[2] * y + m[4];
    if (tx < mn) mn = tx; if (tx > mx) mx = tx;
  }
  return mx >= x0 && mn <= x1;
}

function mul(A, B) { // A ∘ B (apply B then A)
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
    (A[6] || 0) + (B[6] || 0),
  ];
}

function triRectOverlap(t, x0, y0, x1, y1) {
  // SAT: rect axes + triangle edge normals
  const minX = Math.min(t[0], t[2], t[4]), maxX = Math.max(t[0], t[2], t[4]);
  const minY = Math.min(t[1], t[3], t[5]), maxY = Math.max(t[1], t[3], t[5]);
  if (maxX <= x0 || minX >= x1 || maxY <= y0 || minY >= y1) return false;
  const rc = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let k = 0; k < 3; k++) {
    const ax = t[k * 2], ay = t[k * 2 + 1], bx = t[((k + 1) % 3) * 2], by = t[((k + 1) % 3) * 2 + 1];
    const nx = by - ay, ny = ax - bx;
    let tmin = Infinity, tmax = -Infinity;
    for (let j = 0; j < 3; j++) { const d = t[j * 2] * nx + t[j * 2 + 1] * ny; tmin = Math.min(tmin, d); tmax = Math.max(tmax, d); }
    let rmin = Infinity, rmax = -Infinity;
    for (const [x, y] of rc) { const d = x * nx + y * ny; rmin = Math.min(rmin, d); rmax = Math.max(rmax, d); }
    if (rmax <= tmin || rmin >= tmax) return false;
  }
  return true;
}

function parseHSV(str) {
  const a = String(str).split('a').map(Number);
  return [a[0] || 0, a[1] ?? 1, a[2] ?? 1, a[3] === 1 ? 1 : 0, a[4] === 1 ? 1 : 0];
}
function applyHSV(rgb, h) {
  if (!h) return rgb;
  let [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hue = 0;
  if (d) hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60; let sat = mx ? d / mx : 0, val = mx;
  hue = (hue + h[0]) % 360; if (hue < 0) hue += 360;
  sat = h[3] ? sat + h[1] : sat * h[1]; val = h[4] ? val + h[2] : val * h[2];
  sat = Math.min(1, Math.max(0, sat)); val = Math.min(1, Math.max(0, val));
  const c = val * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = val - c;
  let o = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [(o[0] + m) * 255, (o[1] + m) * 255, (o[2] + m) * 255, rgb[3] ?? 1];
}
// Resolved color of a channel, following player-color and copy-color links
function channelColor(sim, ch, depth = 0) {
  if (ch === 1010) return [0, 0, 0, 1];   // built-in black channel: fixed, whatever the header stores
  const def = sim.L.chanDef.get(ch);
  if (def && depth < 8) {
    if (def.player) return channelColor(sim, def.player === 1 ? 1005 : 1006, depth + 1).slice(0, 3).concat([(sim.colors[ch] || [0, 0, 0, 1])[3] ?? 1]);
    if (def.copy) return applyHSV(channelColor(sim, def.copy, depth + 1), def.copyHsv);
  }
  return sim.colors[ch] || (ch === 1010 ? [0, 0, 0, 1] : [255, 255, 255, 1]);
}

function defaultColors() {
  const c = {};
  c[1000] = [40, 125, 255, 1];   // background
  c[1001] = [0, 102, 255, 1];    // ground
  c[1002] = [255, 255, 255, 1];  // line
  c[1003] = [255, 255, 255, 1];
  c[1004] = [255, 255, 255, 1];  // object
  c[1005] = [125, 255, 0, 1];    // player 1
  c[1006] = [0, 255, 255, 1];    // player 2
  c[1007] = [255, 255, 255, 1];
  c[1009] = [0, 102, 255, 1];
  c[1010] = [0, 0, 0, 1];
  c[1011] = [255, 255, 255, 1];
  return c;
}

const Core = { applyHSV, channelColor, parseHSV, boxHitsX, TPS, DT, SPEEDS, MODES, PHYS, decodeSaveFile, listLevels, decodeLevelData, buildLevel, Sim, CHUNK, ease, mul, applyAffine };
if (typeof module !== 'undefined') module.exports = Core;
