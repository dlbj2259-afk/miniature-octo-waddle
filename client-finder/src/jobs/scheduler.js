// Persistent backend scheduler. Schedules live in the database; a tick every
// 30s claims due jobs, so jobs survive restarts and never depend on a browser.
import { all, get, run, getSettings, setSetting } from '../db.js';
import { config } from '../config.js';
import { nextDailyRun } from './time.js';
import { startRun, claudeConfigured } from '../agent/runner.js';
import { generateDailyReport } from './daily-report.js';
import { placesConfigured } from '../integrations/places.js';
import { samConfigured } from '../integrations/sam.js';

const DEFAULT_SCHEDULES = [
  { name: 'Daily prospecting sweep', kind: 'prospect', daily_time: '07:10' },
  { name: 'Follow-up preparation', kind: 'follow_up', daily_time: '07:50' },
  { name: 'Daily client intelligence report', kind: 'daily_report', daily_time: '08:20' },
  { name: 'Weekly public procurement scan', kind: 'procurement', interval_minutes: 7 * 24 * 60 },
];

export function seedSchedules() {
  for (const s of DEFAULT_SCHEDULES) {
    if (!get('SELECT id FROM schedules WHERE kind = ?', s.kind)) {
      const next = s.daily_time ? nextDailyRun(s.daily_time, config.timezone) : new Date(Date.now() + 60 * 60 * 1000);
      run('INSERT INTO schedules(name, kind, daily_time, interval_minutes, next_run_at) VALUES(?,?,?,?,?)', s.name, s.kind, s.daily_time || null, s.interval_minutes || null, next.toISOString());
    }
  }
}

export function computeNext(s, from = new Date()) {
  if (s.daily_time) return nextDailyRun(s.daily_time, config.timezone, from);
  return new Date(from.getTime() + (s.interval_minutes || 1440) * 60000);
}

/** Build the agent prompt for a scheduled prospecting sweep, rotating targets. */
export function buildProspectPrompt() {
  const s = getSettings();
  const cities = s.search_scope === 'nationwide' ? ['the United States'] : s.search_scope === 'michigan' ? [...s.target_cities, 'Grand Rapids', 'Ann Arbor', 'Lansing', 'Flint'] : s.target_cities;
  const idx = s.rotation_index || 0;
  const industry = s.priority_industries[idx % s.priority_industries.length];
  const city = cities[Math.floor(idx / s.priority_industries.length) % cities.length];
  setSetting('rotation_index', idx + 1);
  return {
    title: `Scheduled sweep: ${industry} — ${city}`,
    prompt: `Scheduled prospecting sweep. Find up to ${s.daily_new_lead_target} NEW prospects (not already in the CRM) among ${industry} in and around ${city}, Michigan${s.search_scope === 'nationwide' ? ' (nationwide scope allowed)' : ''}. For each: analyze their website, decide which WoogzMadeit products fit, and save_lead with honest factor ratings and cited evidence. For every lead scoring ${s.min_score_to_draft}+ draft a short initial email (and an Instagram or Facebook DM if they have a public profile). Also do 1–2 web searches for public signals in this area (upcoming events, vendor calls, requests for custom manufacturing) relevant to ${industry}. End with a summary of the best opportunities.`,
  };
}

const FOLLOW_UP_PROMPT =
  'Scheduled follow-up preparation. Use follow_up_queue (days_ahead 1). For each due follow-up or stale contacted lead, review get_lead history and draft a short, specific follow-up message on the channel used before (draft_outreach kind follow_up). Do not change stages. Summarize which follow-ups are ready for approval.';

const PROCUREMENT_PROMPT =
  'Scheduled procurement scan. Use search_procurement for: "signage", "promotional items", "3D printing", "plaques awards", "custom manufacturing", "prototype" (Michigan first, then nationwide for 3D printing/prototype). Also web_search for Michigan city/county/school district bids or RFQs for signage, promotional products or awards posted in the last 60 days. Save genuinely relevant buyers as leads (industry "Public sector") with the opportunity URL as evidence (kind upcoming_event when there is a response deadline). Summarize deadlines.';

export async function runSchedule(s, trigger = 'scheduler') {
  run("UPDATE schedules SET last_run_at = datetime('now'), last_status = 'running' WHERE id = ?", s.id);
  try {
    if (s.kind === 'daily_report') {
      await generateDailyReport();
      run("UPDATE schedules SET last_status = 'succeeded', last_run_id = NULL WHERE id = ?", s.id);
      return { ok: true };
    }
    if (!claudeConfigured()) throw new Error('Claude (Anthropic API) is not connected — add ANTHROPIC_API_KEY.');
    let prompt;
    let title;
    if (s.kind === 'prospect') {
      if (!placesConfigured()) throw new Error('Google Places API is not connected — add GOOGLE_PLACES_API_KEY.');
      ({ prompt, title } = buildProspectPrompt());
    } else if (s.kind === 'follow_up') {
      const due = get("SELECT COUNT(*) AS n FROM follow_ups WHERE status = 'open' AND due_at <= ?", new Date(Date.now() + 864e5).toISOString()).n;
      const stale = get("SELECT COUNT(*) AS n FROM leads WHERE stage = 'contacted' AND updated_at < datetime('now','-4 days')").n;
      if (!due && !stale) {
        run("UPDATE schedules SET last_status = 'skipped (nothing due)' WHERE id = ?", s.id);
        return { ok: true, skipped: true };
      }
      prompt = FOLLOW_UP_PROMPT;
      title = 'Scheduled follow-up preparation';
    } else if (s.kind === 'procurement') {
      prompt = samConfigured() ? PROCUREMENT_PROMPT : PROCUREMENT_PROMPT.replace(/Use search_procurement[^.]*\. /, '') + ' (SAM.gov is not connected; use web_search only and mention that SAM_GOV_API_KEY would add federal opportunities.)';
      title = 'Scheduled procurement scan';
    } else if (s.kind === 'agent') {
      prompt = s.prompt;
      title = s.name;
    } else throw new Error(`Unknown schedule kind ${s.kind}`);

    const { runId, done } = startRun({ prompt, kind: 'scheduled', trigger, title });
    run('UPDATE schedules SET last_run_id = ? WHERE id = ?', runId, s.id);
    const result = await done;
    run('UPDATE schedules SET last_status = ? WHERE id = ?', result.ok ? 'succeeded' : `failed: ${result.error}`.slice(0, 300), s.id);
    return result;
  } catch (e) {
    run('UPDATE schedules SET last_status = ? WHERE id = ?', `failed: ${e.message}`.slice(0, 300), s.id);
    return { ok: false, error: e.message };
  }
}

async function tick() {
  const now = new Date();
  const due = all("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? AND (locked_until IS NULL OR locked_until < ?)", now.toISOString(), now.toISOString());
  for (const s of due) {
    // Claim: advance next_run_at and lock before running (prevents double runs).
    const claimed = run(
      'UPDATE schedules SET next_run_at = ?, locked_until = ? WHERE id = ? AND next_run_at = ?',
      computeNext(s, now).toISOString(),
      new Date(now.getTime() + 2 * 3600e3).toISOString(),
      s.id,
      s.next_run_at
    );
    if (!claimed.changes) continue;
    runSchedule(s).finally(() => run('UPDATE schedules SET locked_until = NULL WHERE id = ?', s.id));
  }
}

export function startScheduler() {
  seedSchedules();
  run('UPDATE schedules SET locked_until = NULL');
  // Catch up: if a daily job was missed while the server was down, run it now once.
  setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 30_000).unref();
  setTimeout(() => tick().catch((e) => console.error('[scheduler]', e)), 5_000).unref();
  console.log('[scheduler] started');
}
