# What if America had a small-business boom? (vertical 3D video)

A ~78-second, 1080×1920 (9:16) 3D explainer rendered with three.js.

- **Counter**: a rolling timestamp, `00:00 → 01:00` for the first hour, then `24 HOURS → 7 DAYS → 30 DAYS → 6 MONTHS → 1 YEAR → 5 YEARS`, with a progress bar.
- **Stat chip**: applications filed (a hypothetical count), which switches to *new businesses still open* from month 6 on. It lands on 90% at 6 months, 80% at 1 year and 50% at 5 years, matching BLS survival rates.
- **Captions**: word-by-word captions from the revised script, then a two-card "The science" outro with sources (Census Business Formation Statistics, BLS Business Employment Dynamics).

The 3D story: blueprint tiles and beams for filings, amber pulses to lenders, cyan pulses to suppliers, green payment flows, crates shipped from inventory. Day breaks after 24 hours. Then come scaffolding (waiting on permits), shops opening, market signals (▲ rent / wages / equipment, ▼ prices), expansions, closures, "+ JOBS" towers, and trees by year 5.

## Files

- `index.html`: the scene, overlay and timeline. Open it through any static server to watch a live preview loop.
- `render.cjs`: renders deterministic frames in headless Chromium and pipes them to ffmpeg (H.264, yuv420p, faststart).
- `out/small-business-boom.mp4`: the rendered video.

## Re-render

```bash
npm install
```

```bash
node render.cjs
```

```bash
node render.cjs --stills 5,20,47,62
```

To edit captions, durations, the counter or camera moves, change `BEATS` and `KEYS` in `index.html`.
Each beat's duration is computed from its caption length.

No audio track is included. Add music or a voiceover in your editor.
