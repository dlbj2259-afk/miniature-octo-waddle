# COVID-19 vaccines: what really happened (vertical 3D video)

A ~2-minute, 1080×1920 (9:16) 3D explainer rendered with three.js and timed to the ElevenLabs voiceover in `audio/`.

- **Counter**: a rolling date, `DEC 2019 → MAR 2020 → … → 2023 → TODAY`, with a 9-chapter progress bar.
- **Stat chip**: vaccine doses given worldwide, rounded from Our World in Data (0 until Dec 2020, then about 13.6 billion).
- **Captions**: the narration, shown word by word. Word timings come from forced alignment of the script against each clip, in `captions.json`. Key phrases are highlighted.
- **Outro**: two "The science" cards with sources (WHO, FDA, CDC, Our World in Data, NEJM, The Lancet).

| # | Chapter | 3D scene |
|---|---------|----------|
| 1 | The beginning | Globe; pulse rings over Wuhan |
| 2 | Global spread | Travel arcs and case dots spread as the globe turns; restrictions, hospitals under pressure |
| 3 | Vaccine development | Cut to a plaza of people; an mRNA strand assembles on a lab pedestal |
| 4 | Emergency approval | The strand becomes a vial; the FDA EUA appears; doses ship out to the crowd |
| 5 | The campaign | People are vaccinated (blue), each with a protection ring |
| 6 | The controversy | Virus particles still pass between people; the "protection vs infection" meter falls |
| 7 | The pressure | WORK and SCHOOL gates; the unvaccinated are held at the barrier |
| 8 | The science | A study scan and a dome for protection against severe disease; rare side-effect sparks |
| 9 | The aftermath | The plaza splits apart and new variants drift overhead |

## Files

- `index.html`: scene, overlay and timeline. Chapter lengths come from the clip durations in `captions.json`.
- `captions.json`: per clip, the duration and each word's start and end time in seconds.
- `audio/01.mp3` … `audio/10.mp3`: the voiceover clips in order. 01 is the title; 02–10 are chapters 1–9.
- `render.cjs`: renders frames in headless Chromium, encodes H.264, then mixes each clip in at its timeline position (AAC).
- `out/covid-vaccines.mp4`: the rendered video with narration.

## Re-render

```bash
npm install
```

```bash
node render.cjs
```

```bash
node render.cjs --stills 1.5,4.6,6.5 --beats
```

`--beats` picks still frames by chapter position: chapter index from 0, plus a fraction. Add `--no-audio` for a silent render.

If you replace a clip, update its `dur` and word times in `captions.json`, because the timeline is built from them.
