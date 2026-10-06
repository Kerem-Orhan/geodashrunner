// Builds the single-file player: src/page.html + data tables + src/core.js + src/app.js -> docs/index.html
// Usage: node build.js
const fs = require('fs');
const path = require('path');
const here = (...p) => path.join(__dirname, ...p);
let h = fs.readFileSync(here('src', 'page.html'), 'utf8');
const rep = (k, v) => { if (!h.includes(k)) throw new Error('placeholder missing: ' + k); h = h.split(k).join(v); };
rep('/*CLASS_TAB*/', fs.readFileSync(here('data', 'objclass.json'), 'utf8'));
rep('/*RENDER_TAB*/', fs.readFileSync(here('data', 'rendertab.json'), 'utf8'));
rep('/*CORE*/', fs.readFileSync(here('src', 'core.js'), 'utf8').replace(/if \(typeof module[^\n]*\n?$/m, ''));
rep('/*APP*/', fs.readFileSync(here('src', 'app.js'), 'utf8'));
fs.mkdirSync(here('docs'), { recursive: true });
fs.writeFileSync(here('docs', 'index.html'), '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' + h + '\n</body>\n</html>\n');
for (const [k, s] of [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m, k) => [k, m[1]])) {
  try { new Function(s); } catch (e) { console.error('script', k, 'has a syntax error:', e.message); process.exit(1); }
}
console.log('built docs/index.html (' + (fs.statSync(here('docs', 'index.html')).size / 1024).toFixed(0) + ' KB)');
