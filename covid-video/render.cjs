// Renders index.html frame-by-frame in headless Chromium and encodes a 1080x1920 MP4.
// Usage:
//   node render.cjs                         -> out/covid-vaccines.mp4 (with the voiceover mixed in)
//   node render.cjs --stills 2,10,30        -> out/stills/t02.0.png ...
//   node render.cjs --fps 30 --from 0 --to 10 --out out/test.mp4
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const FPS = Number(opt('fps', 30));
const OUT = path.resolve(ROOT, opt('out', 'out/covid-vaccines.mp4'));
const STILLS = opt('stills', null);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/?render`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  const total = await page.evaluate(() => window.TOTAL);
  console.log(`timeline: ${total.toFixed(2)}s`);

  if (STILLS) {
    const dir = path.join(ROOT, 'out/stills'); fs.mkdirSync(dir, { recursive: true });
    // --beats 1.5,6.6 picks frames by chapter position (chapter index + fraction) instead of seconds
    let times = STILLS.split(',').map(Number);
    if (args.includes('--beats')) {
      const tl = await page.evaluate(() => window.__timeline);
      times = times.map(b => { const c = tl.chapters[Math.floor(b)]; return c ? +(c.start + (b % 1) * c.d).toFixed(1) : tl.OUTRO_START + (b - tl.chapters.length) * 10; });
    }
    for (const t of times) {
      await page.evaluate(t => window.renderAt(t), t);
      const f = path.join(dir, `t${t.toFixed(1).padStart(5, '0')}.png`);
      await page.screenshot({ path: f });
      console.log('wrote', f);
    }
  } else {
    const from = Number(opt('from', 0)), to = Math.min(Number(opt('to', total)), total);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
    const frames = Math.round((to - from) * FPS);
    const t0 = Date.now();
    for (let n = 0; n < frames; n++) {
      const t = from + n / FPS;
      await page.evaluate(t => window.renderAt(t), t);
      const buf = await page.screenshot({ type: 'jpeg', quality: 93 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (n % 60 === 0) { const el = (Date.now() - t0) / 1000; console.log(`frame ${n}/${frames}  ${(n / Math.max(el, 0.01)).toFixed(2)} fps`); }
    }
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
    if (!args.includes('--no-audio')) {
      // place each voiceover clip at its timeline position and mux it in
      const tl = await page.evaluate(() => window.__timeline);
      const silent = OUT.replace(/\.mp4$/, '.silent.mp4');
      fs.renameSync(OUT, silent);
      const ins = [], filt = [];
      tl.audio.forEach((a, k) => {
        ins.push('-i', path.join(ROOT, a.file));
        const ms = Math.max(0, Math.round((a.at - from) * 1000));
        filt.push(`[${k + 1}:a]aresample=48000,adelay=${ms}|${ms}[a${k}]`);
      });
      const mix = tl.audio.map((_, k) => `[a${k}]`).join('') + `amix=inputs=${tl.audio.length}:normalize=0:dropout_transition=0,apad[aout]`;
      await new Promise((res, rej) => {
        const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, ...ins, '-filter_complex', filt.concat(mix).join(';'),
          '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
        p.on('close', c => c ? rej(new Error('audio mux failed')) : res());
      });
      fs.unlinkSync(silent);
    }
    console.log('wrote', OUT);
  }
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
