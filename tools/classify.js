// Builds objclass.json: object ID -> gameplay class + hitbox, from gdrweb's sprite table
// plus hand-specified gameplay IDs. Run: node classify.js
const fs = require('fs');
const tab = JSON.parse(fs.readFileSync('objtable.json'));

// Gameplay objects specified by ID (authoritative, override sprite-name rules)
const SPECIAL = {
  // portals: [kind, value]
  10: ['grav', 0], 11: ['grav', 1], 2926: ['grav', 2],
  12: ['mode', 0], 13: ['mode', 1], 47: ['mode', 2], 111: ['mode', 3],
  660: ['mode', 4], 745: ['mode', 5], 1331: ['mode', 6], 1933: ['mode', 7],
  45: ['mirror', 1], 46: ['mirror', 0],
  99: ['size', 0], 101: ['size', 1],
  286: ['dual', 1], 287: ['dual', 0],
  747: ['tele', 0],
  200: ['speed', 0], 201: ['speed', 1], 202: ['speed', 2], 203: ['speed', 3], 1334: ['speed', 4],
  // orbs
  36: ['orb', 'yellow'], 141: ['orb', 'pink'], 1333: ['orb', 'red'], 84: ['orb', 'blue'],
  1022: ['orb', 'green'], 1330: ['orb', 'black'], 1704: ['orb', 'dashg'], 1751: ['orb', 'dashp'],
  1594: ['orb', 'toggle'], 3004: ['orb', 'spider'],
  // pads
  35: ['pad', 'yellow'], 140: ['pad', 'pink'], 1332: ['pad', 'red'], 67: ['pad', 'blue'], 3005: ['pad', 'spider'],
  // triggers handled by the engine
  899: ['trig', 'color'], 901: ['trig', 'move'], 1007: ['trig', 'alpha'], 1049: ['trig', 'toggle'],
  1268: ['trig', 'spawn'], 1616: ['trig', 'stop'], 1346: ['trig', 'rotate'], 1006: ['trig', 'pulse'],
  29: ['trig', 'bg'], 30: ['trig', 'ground'], 105: ['trig', 'obj'], 744: ['trig', 'l3'],
  31: ['start', 0], 1931: ['trig', 'end'], 3600: ['trig', 'end'],
};
// IDs that are never gameplay even though their sprite name looks like it
const DECO_IDS = new Set([191, 198, 1889, 1890, 1891, 1892, 1591, 1593, 990, 992, 719]);

// Hitbox conventions (units; 1 block = 30). Rect: [w, h, ox, oy]; circle: ['c', r]
const SPIKE_BOX = [6, 12, 0, 0];
const SPIKE_SMALL = [6, 5.6, 0, -4.4];
const SPIKE_MED = [4, 7.6, 0, -2.4];
const PIT_BOX = [18, 5, 0, -5];

function classify(id, t) {
  if (SPECIAL[id]) return SPECIAL[id];
  if (DECO_IDS.has(+id)) return null;
  const tex = (t && t.texture) || '';
  if (/^(d_|edit_|emptyFrame|lighting|gradient|fakeSpike|lightsquare|lighttriangle|blockOutline|persp_outline|smallOutline|invisibleOutline|gj_|Fire_|GJBeast|explosion|starAnim|waterfall|chain|rod|fireball|dA_|gridLine|lava_top)/.test(tex)) return null;
  if (/_(light|edge|edge_c|detail|part|piece|shine)/.test(tex) && !/^pit/.test(tex)) return null;
  if (/^(blade|blade_b|darkblade|sawblade|bladeTrap|lightBlade|spinBlade|blackCogwheel)/.test(tex)) return ['saw', 0];
  if (/^(spike|colorSpike|iceSpike|invis_spike)/.test(tex)) {
    if (+id === 39 || /_02_/.test(tex)) return ['hazard', SPIKE_SMALL];
    if (+id === 103 || /_03_/.test(tex)) return ['hazard', SPIKE_MED];
    return ['hazard', SPIKE_BOX];
  }
  if (/^pit/.test(tex)) return ['hazard', PIT_BOX];
  if (/slope|^triangle|^invis_triangle/.test(tex)) return ['slope', /_02|square_02|slope_02/.test(tex) ? 2 : 1];
  if (/^(square|block|blockDesign|plank|colorPlank|invis_square|invis_plank|brick|colorSquare)/.test(tex)) {
    if (/plank|small/.test(tex)) return ['solid', [30, 15, 0, 7.5]];
    return ['solid', [30, 30, 0, 0]];
  }
  return null;
}

const out = {};
for (const [id, t] of Object.entries(tab)) { const c = classify(id, t); if (c) out[id] = c; }
for (const id of Object.keys(SPECIAL)) out[id] = SPECIAL[id];
fs.writeFileSync('objclass.json', JSON.stringify(out));
const counts = {};
for (const c of Object.values(out)) counts[c[0]] = (counts[c[0]] || 0) + 1;
console.log(counts);
