// Regenerates data/rendertab.json (object ID -> sprite frame, layer, colors, sub-pieces) from gdrweb (MIT).
// Usage: npm pack gdrweb && tar xzf gdrweb-*.tgz && node tools/extract-objtable.js package/dist/gdrweb.mjs
// Then: cd data && node ../tools/classify.js   (rebuilds data/objclass.json from objtable.json)
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
let i = src.indexOf('const Lt = {') + 11, d = 0, j = i;
for (; j < src.length; j++) { const c = src[j]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
const tab = (new Function('return ' + src.slice(i, j + 1).replace(/!0/g, 'true').replace(/!1/g, 'false')))();
fs.writeFileSync('data/objtable.json', JSON.stringify(tab));
const ct = { Base: 0, Detail: 1, Black: 2 }, out = {};
for (const [id, t] of Object.entries(tab)) {
  if (/^edit_/.test(t.texture || '')) continue;
  const ch = (t.children || []).map(c => [c.texture, c.x || 0, c.y || 0, c.rot || 0, c.scale_x ?? 1, c.scale_y ?? 1, c.flip_x ? 1 : 0, c.flip_y ? 1 : 0, c.z || 0, ct[c.color_type] ?? 0, c.anchor_x ?? 0.5, c.anchor_y ?? 0.5]);
  out[id] = [t.texture || '', t.default_z_layer || 0, t.default_z_order || 0, t.default_base_color_channel ?? 1004, t.default_detail_color_channel ?? 0, ct[t.color_type] ?? 0, t.swap_base_detail ? 1 : 0].concat(ch.length ? [ch] : []);
}
fs.writeFileSync('data/rendertab.json', JSON.stringify(out));
console.log('wrote data/objtable.json and data/rendertab.json:', Object.keys(out).length, 'objects');
