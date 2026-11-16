// Daily Client Intelligence report: computed from the database (facts),
// optionally emailed. No AI-invented numbers.
import { all, get, run, getSettings } from '../db.js';
import { config } from '../config.js';
import { pipelineSummary, hydrate } from '../leads/repo.js';
import { localDateString } from './time.js';
import { sendMail, mailConfigured } from '../integrations/mailer.js';
import { emitAppEvent } from '../events.js';

const money = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`;

export function buildReportData() {
  const since = new Date(Date.now() - 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const newLeads = all('SELECT * FROM leads WHERE created_at >= ? AND archived = 0 ORDER BY score DESC', since).map(hydrate);
  const top = all(
    "SELECT * FROM leads WHERE archived = 0 AND stage NOT IN ('won','lost') AND score IS NOT NULL ORDER BY score DESC, COALESCE(est_value_high,0) DESC LIMIT 10"
  ).map(hydrate);
  const pending = all(
    "SELECT d.id, d.channel, d.kind, d.subject, l.id AS lead_id, l.name, l.score, l.score_tier FROM outreach_drafts d JOIN leads l ON l.id = d.lead_id WHERE d.status = 'pending' ORDER BY l.score DESC LIMIT 25"
  );
  const dueFollowUps = all(
    "SELECT f.id, f.due_at, f.reason, l.id AS lead_id, l.name, l.stage FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.status = 'open' AND f.due_at <= ? ORDER BY f.due_at",
    new Date(Date.now() + 864e5).toISOString()
  );
  const needsResearch = all(
    "SELECT id, name, research_gaps, research_status, score FROM leads WHERE archived = 0 AND stage NOT IN ('won','lost') AND (research_status != 'researched' OR (email IS NULL AND phone IS NULL)) ORDER BY score DESC LIMIT 15"
  );
  const runs = all("SELECT id, kind, status, error, created_at FROM agent_runs WHERE created_at >= ? ORDER BY id DESC", since);
  const pipeline = pipelineSummary();
  const newEst = newLeads.reduce((a, l) => a + (l.est_value_mid || 0), 0);

  const actions = [];
  const hotUncontacted = top.filter((l) => l.score_tier === 'Hot' && ['new', 'researched', 'qualified'].includes(l.stage));
  if (pending.length) actions.push(`Review and approve ${pending.length} outreach draft(s) — start with ${pending[0].name} (score ${pending[0].score}).`);
  if (dueFollowUps.length) actions.push(`Complete ${dueFollowUps.length} follow-up(s) due today/overdue.`);
  for (const l of hotUncontacted.slice(0, 3)) actions.push(`Contact ${l.name} (Hot, ${l.score}) about ${l.recommended_products[0] || 'a custom product'}.`);
  if (needsResearch.length) actions.push(`Run "Research This Business" on ${needsResearch.slice(0, 3).map((l) => l.name).join(', ')} to fill contact/evidence gaps.`);
  const failed = runs.filter((r) => r.status === 'failed');
  if (failed.length) actions.push(`${failed.length} agent run(s) failed in the last 24h — check Live Activity (often a missing API key).`);
  if (!newLeads.length && !failed.length) actions.push('No new leads in 24h — run "Find Clients Now" for a new industry or city.');

  return {
    date: localDateString(new Date(), config.timezone),
    new_leads: newLeads.map((l) => ({ id: l.id, name: l.name, industry: l.industry, city: l.city, score: l.score, tier: l.score_tier, est_value_mid: l.est_value_mid })),
    new_leads_est_value: newEst,
    top_opportunities: top.map((l) => ({ id: l.id, name: l.name, score: l.score, tier: l.score_tier, stage: l.stage_label, product: l.recommended_products[0] || null, est_value_low: l.est_value_low, est_value_high: l.est_value_high })),
    pending_drafts: pending,
    follow_ups_due: dueFollowUps,
    needs_research: needsResearch,
    pipeline,
    runs_last_24h: runs,
    recommended_actions: actions,
  };
}

export function reportToMarkdown(d) {
  const lines = [];
  lines.push(`# WoogzMadeit Daily Client Intelligence — ${d.date}`, '');
  lines.push(`**New leads (24h):** ${d.new_leads.length} · **Est. value of new leads:** ${money(d.new_leads_est_value)} (estimate)`);
  lines.push(`**Open pipeline (est.):** ${money(d.pipeline.open_pipeline_est_value)} · **Won revenue:** ${money(d.pipeline.won_revenue)} · **Hot:** ${d.pipeline.hot} · **Warm:** ${d.pipeline.warm}`, '');
  lines.push('## Recommended next actions');
  d.recommended_actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  lines.push('', '## Highest-priority opportunities');
  if (!d.top_opportunities.length) lines.push('_None yet._');
  for (const l of d.top_opportunities) lines.push(`- **${l.name}** — ${l.score} (${l.tier}), ${l.stage}${l.product ? ` · ${l.product}` : ''}${l.est_value_high ? ` · est. ${money(l.est_value_low)}–${money(l.est_value_high)}` : ''}`);
  lines.push('', '## New leads discovered');
  if (!d.new_leads.length) lines.push('_None in the last 24 hours._');
  for (const l of d.new_leads) lines.push(`- ${l.name} (${l.industry || '—'}, ${l.city || '—'}) — ${l.score ?? '—'} ${l.tier || ''}`);
  lines.push('', `## Outreach awaiting approval (${d.pending_drafts.length})`);
  for (const p of d.pending_drafts) lines.push(`- ${p.name}: ${p.kind === 'follow_up' ? 'follow-up' : 'initial'} ${p.channel}${p.subject ? ` — “${p.subject}”` : ''}`);
  lines.push('', `## Follow-ups due (${d.follow_ups_due.length})`);
  for (const f of d.follow_ups_due) lines.push(`- ${f.name} — due ${f.due_at.slice(0, 10)}${f.reason ? `: ${f.reason}` : ''}`);
  lines.push('', `## Leads needing more research (${d.needs_research.length})`);
  for (const l of d.needs_research) lines.push(`- ${l.name}${l.research_gaps ? ` — ${l.research_gaps}` : ''}`);
  lines.push('', '_Opportunity values are estimates generated from public information._');
  return lines.join('\n');
}

function mdToBasicHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:680px;color:#0f172a">${esc(md)
    .replace(/^# (.*)$/gm, '<h1 style="font-size:20px">$1</h1>')
    .replace(/^## (.*)$/gm, '<h2 style="font-size:16px;margin-top:20px">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/^(- |\d+\. )(.*)$/gm, '<div style="margin:4px 0 4px 12px">• $2</div>')
    .replace(/\n/g, '<br>')}</div>`;
}

export async function generateDailyReport({ email } = {}) {
  const data = buildReportData();
  const markdown = reportToMarkdown(data);
  const id = Number(run('INSERT INTO reports(report_date, data, markdown) VALUES(?,?,?)', data.date, JSON.stringify(data), markdown).lastInsertRowid);
  const settings = getSettings();
  const to = settings.report_email_to || config.reportEmailTo;
  const shouldEmail = email ?? settings.report_email_enabled;
  if (shouldEmail) {
    try {
      if (!to) throw new Error('No report recipient set (Agent Settings → Daily report email).');
      if (!mailConfigured()) throw new Error('SMTP is not configured.');
      await sendMail({ to, subject: `Daily Client Intelligence — ${data.date}`, text: markdown, html: mdToBasicHtml(markdown) });
      run("UPDATE reports SET emailed_at = datetime('now') WHERE id = ?", id);
    } catch (e) {
      run('UPDATE reports SET email_error = ? WHERE id = ?', e.message, id);
    }
  }
  emitAppEvent('report_created', { id });
  return get('SELECT * FROM reports WHERE id = ?', id);
}
