# WoogzMadeit Client Finder Agent

An AI sales-prospecting agent for **WoogzMadeit** (Pontiac, MI). It finds real businesses that could buy custom manufacturing (silicone molds, 3D printing, prototyping, promo products, signage/LED, branded merch), researches them from public sources, scores them 0–100 with cited reasoning, drafts personalized outreach for your approval, and runs a sales pipeline. Scheduled sweeps run on the server, so the browser doesn't need to stay open.

There's no demo data. Every lead comes from a real search, and the app tells you when an integration isn't connected.

---

## Architecture

```
Browser (vanilla JS SPA, mobile-responsive)
   │  REST + Server-Sent Events (live research activity)
   ▼
Node.js / Express server ──────────────────────────────────────────────┐
   ├─ auth.js          owner login (scrypt), httpOnly session cookies,  │
   │                   CSRF header, login rate limit                    │
   ├─ agent/runner.js  Claude tool-calling loop (streaming, adaptive    │
   │                   thinking, prompt caching, refusal fallbacks),    │
   │                   persisted runs + events, concurrency queue       │
   ├─ agent/tools.js   tools the agent can call ─────────────┐          │
   │     search_businesses ─► Google Places API (New)        │          │
   │     analyze_website   ─► business's own site (robots.txt, SSRF-safe)
   │     web_search        ─► Claude server-side web search (citations) │
   │     search_procurement─► SAM.gov Opportunities API     │          │
   │     save_lead / find_leads / get_lead / update_lead    │          │
   │     draft_outreach / schedule_follow_up / pipeline_summary / follow_up_queue
   ├─ leads/scoring.js evidence-gated scoring (server computes score)   │
   ├─ leads/dedupe.js  place-id / domain / phone / name+city matching   │
   ├─ leads/repo.js    leads, history, drafts, follow-ups, quotes       │
   ├─ jobs/scheduler.js DB-backed scheduler (survives restarts)         │
   ├─ jobs/daily-report.js daily intelligence + optional SMTP email     │
   └─ secrets.js       env vars or AES-256-GCM encrypted key store      │
                                                                        │
SQLite (node:sqlite, WAL) ── data/clientfinder.db ◄─────────────────────┘
```

### How a research run works
1. You type a command, click a manual control, or the scheduler fires.
2. A run is queued (at most 2 run at once) and executes in the background. Every step is written to `run_events` and streamed to the UI.
3. Claude decides which tools to call: Google Places for real listings, the business's website, web search for events and vendor calls, SAM.gov for public bids.
4. For each prospect, Claude calls `save_lead` with 0–10 ratings and a reason for each factor. **The server computes the score itself:**

   | Factor | Weight | Rule |
   |---|---|---|
   | Service match | 25 | Fit with WoogzMadeit products |
   | Evidence of purchasing need | 20 | **Forced to 0 unless backed by a cited source URL the agent actually saw** |
   | Size / order value | 15 | |
   | Distance | 10 | Computed server-side from coordinates (Pontiac home base) |
   | Upcoming events/projects | 10 | **Forced to 0 without cited `upcoming_event` evidence** |
   | Likelihood to buy | 20 | Capped at 6/10 when no evidence is cited |

   Hot ≥ 70 · Warm 45–69 · Cold < 45. The full breakdown and each reason are stored and shown on the lead.
5. **Anti-fabrication checks:** emails, phones and decision-maker names are kept only if they appear in what the tools returned during that run (Places results, fetched pages, cited web-search text). Otherwise they're discarded with a warning. Evidence URLs the agent never saw are dropped too.
6. **Dedupe:** a matching Google place id, website domain, phone number, or name + city merges into the existing lead. Its stage and history are kept and missing fields are filled in.
7. Outreach drafts are saved as **pending**. Nothing is ever sent automatically. You edit, approve, then either send an approved email yourself with **Send email…** (SMTP, with a confirmation step) or copy a DM or phone script and use it from your own accounts.

### Pipeline
New Lead → Researched → Qualified → Contacted → Interested → Quote Sent → Negotiating → Won / Lost
- Change stages with drag-and-drop or the stage menu (works on mobile).
- Moving a lead to Contacted schedules a follow-up 4 days out.
- Each lead keeps notes and logged calls, emails and DMs, plus quotes. Marking a quote accepted marks the lead Won and records the revenue.

### Scheduled jobs (server-side, America/Detroit)
| Job | Default | What it does |
|---|---|---|
| Daily prospecting sweep | 07:10 | Works through your priority industries and target cities in rotation, finds up to N new leads, scores them, drafts outreach for leads at or above the minimum score |
| Follow-up preparation | 07:50 | Drafts follow-ups for due and stale leads (skipped when nothing is due) |
| Daily client intelligence report | 08:20 | Report built from database facts, with optional email |
| Weekly procurement scan | weekly | SAM.gov and web search for signage, promo, 3D-printing and award bids |

You can change times, toggle jobs, or click **Run now** in Agent Settings. You can also run jobs from external cron:
```bash
npm run job -- prospect
npm run job -- report --email
```

### Security
- Single owner login with scrypt-hashed passwords. Sessions are random tokens stored hashed, in httpOnly, SameSite=Lax, Secure cookies.
- State-changing requests require an `X-Requested-With` header (CSRF), and the app sends a strict CSP and security headers.
- Rate limits: login 10 per 15 min, API 600 per min, agent 20 per min. Outbound calls are throttled per provider with retry and backoff on 429 and 5xx.
- API keys come from environment variables, or are entered in Settings and stored encrypted with AES-256-GCM (key derived from `APP_SECRET`). Keys are never returned to the browser.
- The website fetcher respects robots.txt, refuses private and internal IPs (SSRF), caps response size and limits itself to 1 request per second per host.

---

## Run locally

Requires **Node.js 22.13 or newer** (it uses the built-in `node:sqlite`).

```bash
cd client-finder
cp .env.example .env      # fill APP_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY
npm install
npm test
npm start                 # http://localhost:3000
```
For plain-http local testing, set `COOKIE_SECURE=false`. To reset the password, run `npm run set-password -- you@example.com 'new-long-password'`.

## What you must connect

| Service | Required? | Where to get it | Cost notes |
|---|---|---|---|
| **Anthropic API** (`ANTHROPIC_API_KEY`) | Yes | console.anthropic.com → API Keys. Also **enable Web Search** for your org in Console settings. | Pay per token. A 10-lead sweep is typically tens of thousands of tokens plus about $10 per 1,000 web searches. Usage per run shows in Live Activity. |
| **Google Places API (New)** (`GOOGLE_PLACES_API_KEY`) | Yes | Google Cloud Console → new project → enable **Places API (New)** → create an API key → restrict it to Places API → set a billing account and budget alert | Text Search with website and phone fields is billed per request (Google gives a monthly free usage tier). Google's terms limit caching of Places content: this app stores the place ID and re-verifies leads, and you should re-research stale leads. |
| **SAM.gov** (`SAM_GOV_API_KEY`) | Optional | sam.gov → sign in → Account Details → Public API Key | Free |
| **SMTP** (`SMTP_*`) | Optional | Google Workspace or Gmail app password, Microsoft 365, or a transactional provider (Postmark, SES, Resend SMTP) | Used for the daily report and for approved emails you send yourself |

If a key is missing, the agent says so in chat and in Live Activity, and the search shows as an **error** in Search History. Nothing is faked.

## Deploy (recommended: Render or Railway with a persistent disk)

The app is one always-on process: the web server and scheduler run together, with SQLite on disk.

**Render**
1. Push this repo to GitHub.
2. Render → New → **Blueprint** → select the repo and point it at `client-finder/render.yaml`, or create a Web Service manually: Docker, root dir `client-finder`, and a 1 GB disk mounted at `/data`.
3. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY` and `GOOGLE_PLACES_API_KEY` (and the optional keys). `APP_SECRET` is generated for you.
4. Use a **paid always-on instance**. Free instances sleep, which stops the scheduler.
5. Open the URL, sign in, check **Agent Settings**, and press **Run now** on the prospecting sweep.

**Any VPS or Docker host**
```bash
docker build -t woogz-client-finder ./client-finder
```
```bash
docker run -d --name woogz -p 3000:3000 --env-file client-finder/.env -v woogz-data:/data woogz-client-finder
```
Put it behind HTTPS (Caddy, NGINX or Cloudflare) and set `TRUST_PROXY=true`. Back up the `/data` volume, which holds the SQLite database.

**Scaling note:** SQLite plus the in-process scheduler is for one instance. Before running several instances, move to Postgres and a queue (for example pg-boss or BullMQ).

## Roadmap (next increments)
- Gmail and Microsoft 365 OAuth connectors for sending approved emails and detecting replies (moves leads to Interested automatically)
- More permitted sources: Yelp Fusion API, state and municipal bid portals with RSS feeds, Eventbrite API for event organizers
- Meta Graph API for business Instagram and Facebook inboxes (send from inside the app after approval, within Meta's messaging policies)
- Multi-user roles, CSV export and import, Postgres option
- Lead re-verification job (refresh Places data older than 30 days)

## Compliance notes
- Only public business information is collected, from official APIs or the businesses' own public websites, and robots.txt is respected. No logins are bypassed and no social sites are scraped.
- Outreach is drafted for human review. Before sending cold email, follow CAN-SPAM: a truthful subject line, your physical business address, and a way to opt out.
