// Exports the Kestrel 5 model from index.html:
//   out/kestrel5.glb              whole drone, one named node per part
//   out/kestrel5-exploded.glb     same, in exploded layout
//   out/components/<id>.glb       each component on its own (drone coordinates)
//   out/bom.csv                   bill of materials
//   out/assembled.png, out/exploded.png   renders
// Usage: npm install && npm run export
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const out = path.join(dir, 'out');
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.180.0/';

(async () => {
  fs.mkdirSync(path.join(out, 'components'), { recursive: true });
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const page_html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>' + html + '</body></html>';

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.error('page error:', e.message));
  // Serve three.js from node_modules instead of the CDN; skip web fonts.
  await page.route(CDN + '**', route => {
    const rel = route.request().url().slice(CDN.length);
    route.fulfill({ path: path.join(dir, 'node_modules/three', rel), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.setContent(page_html, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__drone && window.__drone.ready, null, { timeout: 60000 });

  const save = async (file, compId) => {
    const b64 = await page.evaluate(id => window.__drone.exportGLB(id), compId || null);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(path.relative(dir, file), (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
  };

  await page.evaluate(() => { window.__drone.setSpin(false); window.__drone.setMode(false); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'assembled.png') });
  await save(path.join(out, 'kestrel5.glb'));

  const ids = await page.evaluate(() => window.__drone.COMPONENTS.map(c => c.id));
  for (const id of ids) await save(path.join(out, 'components', id + '.glb'), id);

  await page.evaluate(() => window.__drone.setMode(true));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'exploded.png') });
  await save(path.join(out, 'kestrel5-exploded.glb'));

  const rows = await page.evaluate(() => window.__drone.COMPONENTS.map(c => [c.group, c.name, c.sub, c.qty, c.mass, +(c.mass * c.qty).toFixed(1), c.specs.map(s => s.join(': ')).join('; ')]));
  const csv = [['Subsystem', 'Component', 'Spec', 'Qty', 'Unit mass (g)', 'Line mass (g)', 'Details'], ...rows]
    .map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n');
  fs.writeFileSync(path.join(out, 'bom.csv'), csv + '\n');
  console.log('out/bom.csv');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
