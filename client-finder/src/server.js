import express from 'express';
import path from 'node:path';
import { config, ROOT, assertBootConfig, SECRET_NAMES } from './config.js';
import { getDb, all, get, run, parseJson, getSettings, setSetting, DEFAULT_SETTINGS } from './db.js';
import { bootstrapAdmin, login, logout, currentUser, requireAuth, setSessionCookie, clearSessionCookie } from './auth.js';
import { inboundLimiter } from './ratelimit.js';
import { bus } from './events.js';
import { secretStatus, setSecret } from './secrets.js';
import { startRun, claudeConfigured, markInterruptedRuns } from './agent/runner.js';
import { placesConfigured } from './integrations/places.js';
import { samConfigured } from './integrations/sam.js';
import { mailConfigured, sendMail } from './integrations/mailer.js';
import { listLeads, getLeadDetail, updateLead, addFollowUp, completeFollowUp, createDraft, pipelineSummary, addActivity, hydrate, STAGES, STAGE_LABELS, saveLead } from './leads/repo.js';
import { startScheduler, runSchedule, computeNext, seedSchedules } from './jobs/scheduler.js';
import { generateDailyReport, buildReportData, reportToMarkdown } from './jobs/daily-report.js';

assertBootConfig();
getDb();
bootstrapAdmin();
markInterruptedRuns();
seedSchedules();

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  );
  next();
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[api] ${req.method} ${req.path}:`, e.message);
    res.status(e.status || 400).json({ error: e.message });
  });

// ---------- auth ----------
app.post('/api/auth/login', inboundLimiter({ windowMs: 15 * 60e3, max: 10, message: 'Too many login attempts; try again in 15 minutes.' }), wrap((req, res) => {
  const s = login(req.body?.email, req.body?.password);
  if (!s) return res.status(401).json({ error: 'Invalid email or password' });
  setSessionCookie(res, s.token, s.expires);
  res.json({ user: s.user });
}));
app.post('/api/auth/logout', wrap((req, res) => {
  const u = currentUser(req);
  if (u) logout(u.token);
  clearSessionCookie(res);
  res.json({ ok: true });
}));
app.get('/api/auth/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: { id: u.id, email: u.email } });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Everything else under /api requires a session.
app.use('/api', inboundLimiter({ windowMs: 60e3, max: 600 }), requireAuth);

// ---------- status / integrations ----------
function integrationStatus() {
  return {
    claude: { connected: claudeConfigured(), model: config.model, web_search: config.webSearchEnabled, label: 'Claude AI (agent reasoning + web search)', required: true, how: 'Set ANTHROPIC_API_KEY (console.anthropic.com → API Keys). Web search must be enabled for your organization in the Claude Console.' },
    google_places: { connected: placesConfigured(), label: 'Google Places API (business discovery)', required: true, how: 'Google Cloud Console → enable "Places API (New)" → create API key (restrict it to Places API) → GOOGLE_PLACES_API_KEY.' },
    sam_gov: { connected: samConfigured(), label: 'SAM.gov (public procurement)', required: false, how: 'SAM.gov → Account Details → Public API Key → SAM_GOV_API_KEY.' },
    email: { connected: mailConfigured(), label: 'SMTP email (daily report + approved emails)', required: false, how: 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM env vars and SMTP_PASS.' },
  };
}

app.get('/api/status', (req, res) => {
  res.json({ integrations: integrationStatus(), secrets: secretStatus(), scheduler: config.enableScheduler, timezone: config.timezone, home_base: config.homeBase, stages: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] })) });
});

app.put('/api/secrets/:name', wrap((req, res) => {
  if (!SECRET_NAMES.includes(req.params.name)) return res.status(404).json({ error: 'Unknown secret' });
  if (process.env[req.params.name]) return res.status(409).json({ error: 'This key is set in the server environment; change it there.' });
  setSecret(req.params.name, String(req.body?.value || '').trim());
  res.json({ secrets: secretStatus(), integrations: integrationStatus() });
}));

// ---------- settings ----------
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', wrap((req, res) => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[k] !== undefined && k !== 'rotation_index') setSetting(k, req.body[k]);
  }
  res.json(getSettings());
}));

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const data = buildReportData();
  const latestReport = get('SELECT id, report_date, created_at, emailed_at, email_error FROM reports ORDER BY id DESC LIMIT 1');
  res.json({ ...data, latest_report: latestReport, integrations: integrationStatus() });
});

// ---------- leads ----------
app.get('/api/leads', (req, res) => {
  const q = req.query;
  res.json(listLeads({ q: q.q, industry: q.industry, tier: q.tier, stage: q.stage, minScore: q.min_score, city: q.city, limit: q.limit, offset: q.offset, sort: q.sort }));
});
app.get('/api/leads/:id', (req, res) => {
  const l = getLeadDetail(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Not found' });
  res.json(l);
});
app.post('/api/leads', wrap((req, res) => {
  // Manual lead entry (owner-provided data).
  const b = req.body || {};
  if (!b.name) throw new Error('Name is required');
  const r = saveLead({ name: b.name, industry: b.industry, website: b.website, phone: b.phone, email: b.email, city: b.city, state: b.state, address: b.address }, { sources: b.website ? [{ url: b.website, type: 'manual' }] : [] });
  addActivity(r.lead.id, 'note', r.created ? 'Added manually by owner' : `Manual entry matched existing lead (${r.matchedOn})`);
  res.json(r);
}));
app.patch('/api/leads/:id', wrap((req, res) => res.json(updateLead(Number(req.params.id), req.body || {}))));
app.post('/api/leads/:id/activities', wrap((req, res) => {
  const { type = 'note', summary } = req.body || {};
  if (!summary) throw new Error('Summary is required');
  if (!['note', 'call', 'email', 'dm', 'meeting', 'reply'].includes(type)) throw new Error('Invalid activity type');
  addActivity(Number(req.params.id), type, summary);
  run("UPDATE leads SET updated_at = datetime('now') WHERE id = ?", Number(req.params.id));
  res.json({ ok: true });
}));
app.post('/api/leads/:id/follow-ups', wrap((req, res) => res.json({ id: addFollowUp(Number(req.params.id), req.body?.due_date, req.body?.reason) })));
app.post('/api/leads/:id/quotes', wrap((req, res) => {
  const { description, amount, status = 'draft' } = req.body || {};
  if (!description || !(Number(amount) > 0)) throw new Error('Description and a positive amount are required');
  const id = Number(run('INSERT INTO quotes(lead_id, description, amount, status, sent_at) VALUES(?,?,?,?,?)', Number(req.params.id), description, Number(amount), status, status === 'sent' ? new Date().toISOString() : null).lastInsertRowid);
  addActivity(Number(req.params.id), 'quote', `Quote ${status}: ${description} — $${Number(amount).toFixed(2)}`);
  if (status === 'sent') updateLead(Number(req.params.id), { stage: 'quote_sent', potential_revenue: Number(amount) });
  res.json({ id });
}));
app.patch('/api/quotes/:id', wrap((req, res) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q) throw new Error('Quote not found');
  const status = req.body?.status;
  if (!['draft', 'sent', 'accepted', 'rejected'].includes(status)) throw new Error('Invalid status');
  run('UPDATE quotes SET status = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?', status, status === 'sent' ? new Date().toISOString() : null, q.id);
  addActivity(q.lead_id, 'quote', `Quote marked ${status}: ${q.description}`);
  if (status === 'accepted') updateLead(q.lead_id, { stage: 'won', won_revenue: q.amount });
  if (status === 'sent') updateLead(q.lead_id, { stage: 'quote_sent', potential_revenue: q.amount });
  res.json({ ok: true });
}));

// ---------- pipeline ----------
app.get('/api/pipeline', (req, res) => {
  const leads = all("SELECT * FROM leads WHERE archived = 0 ORDER BY score DESC").map(hydrate);
  res.json({ summary: pipelineSummary(), columns: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s], leads: leads.filter((l) => l.stage === s) })) });
});
app.get('/api/revenue', (req, res) => {
  res.json({
    summary: pipelineSummary(),
    opportunities: all("SELECT * FROM leads WHERE archived = 0 AND stage NOT IN ('won','lost') AND (est_value_high IS NOT NULL OR potential_revenue IS NOT NULL) ORDER BY COALESCE(potential_revenue, est_value_high) DESC LIMIT 100").map(hydrate),
    quotes: all('SELECT q.*, l.name FROM quotes q JOIN leads l ON l.id = q.lead_id ORDER BY q.id DESC LIMIT 100'),
    won: all("SELECT id, name, won_revenue, updated_at FROM leads WHERE stage = 'won' ORDER BY updated_at DESC"),
  });
});

// ---------- outreach drafts (approval workflow) ----------
app.get('/api/drafts', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = all(
    `SELECT d.*, l.name AS lead_name, l.email AS lead_email, l.contact_email, l.score, l.score_tier, l.social_json, l.phone AS lead_phone
     FROM outreach_drafts d JOIN leads l ON l.id = d.lead_id ${status === 'all' ? '' : 'WHERE d.status = ?'} ORDER BY d.id DESC LIMIT 200`,
    ...(status === 'all' ? [] : [status])
  );
  res.json(rows.map((r) => ({ ...r, social: parseJson(r.social_json, {}) })));
});
app.patch('/api/drafts/:id', wrap((req, res) => {
  const d = get('SELECT * FROM outreach_drafts WHERE id = ?', Number(req.params.id));
  if (!d) throw new Error('Draft not found');
  const { subject, body, status } = req.body || {};
  if (status && !['pending', 'approved', 'rejected', 'sent'].includes(status)) throw new Error('Invalid status');
  run(
    "UPDATE outreach_drafts SET subject = COALESCE(?, subject), body = COALESCE(?, body), status = COALESCE(?, status), approved_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE approved_at END, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END, updated_at = datetime('now') WHERE id = ?",
    subject ?? null, body ?? null, status ?? null, status ?? null, status ?? null, d.id
  );
  if (status === 'approved') addActivity(d.lead_id, 'draft', `Owner approved ${d.channel} draft #${d.id}`);
  if (status === 'rejected') addActivity(d.lead_id, 'draft', `Owner rejected ${d.channel} draft #${d.id}`);
  if (status === 'sent') {
    addActivity(d.lead_id, d.channel === 'email' ? 'email' : 'dm', `Owner sent ${d.channel} message (manually): ${d.subject || d.body.slice(0, 80)}`);
    const lead = get('SELECT stage FROM leads WHERE id = ?', d.lead_id);
    if (['new', 'researched', 'qualified'].includes(lead.stage)) updateLead(d.lead_id, { stage: 'contacted' });
  }
  res.json(get('SELECT * FROM outreach_drafts WHERE id = ?', d.id));
}));
// Sending is only possible for an APPROVED email draft, on an explicit owner click.
app.post('/api/drafts/:id/send', wrap(async (req, res) => {
  const d = get('SELECT * FROM outreach_drafts WHERE id = ?', Number(req.params.id));
  if (!d) throw new Error('Draft not found');
  if (d.channel !== 'email') throw new Error('Only email drafts can be sent from the app. Copy DMs/scripts and send them yourself.');
  if (d.status !== 'approved') throw new Error('Approve the draft before sending.');
  if (req.body?.confirm !== true) throw new Error('Explicit confirmation required.');
  const lead = get('SELECT * FROM leads WHERE id = ?', d.lead_id);
  const to = req.body?.to || lead.contact_email || lead.email;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('No valid recipient email on this lead.');
  const result = await sendMail({ to, subject: d.subject || `Custom products for ${lead.name}`, text: d.body });
  run("UPDATE outreach_drafts SET status = 'sent', sent_at = datetime('now'), send_result = ? WHERE id = ?", JSON.stringify(result), d.id);
  addActivity(d.lead_id, 'email', `Email sent to ${to}: ${d.subject || ''}`, result);
  if (['new', 'researched', 'qualified'].includes(lead.stage)) updateLead(d.lead_id, { stage: 'contacted' });
  res.json({ ok: true, result });
}));
app.post('/api/drafts', wrap((req, res) => {
  const { lead_id, channel, kind, subject, body } = req.body || {};
  if (!lead_id || !channel || !body) throw new Error('lead_id, channel and body are required');
  res.json({ id: createDraft({ leadId: Number(lead_id), channel, kind, subject, body, createdBy: 'user' }) });
}));

// ---------- follow-ups ----------
app.get('/api/follow-ups', (req, res) => {
  res.json(
    all(`SELECT f.*, l.name, l.stage, l.score, l.score_tier FROM follow_ups f JOIN leads l ON l.id = f.lead_id
         WHERE f.status = 'open' ORDER BY f.due_at LIMIT 300`)
  );
});
app.post('/api/follow-ups/:id/complete', wrap((req, res) => {
  completeFollowUp(Number(req.params.id), req.body?.status === 'skipped' ? 'skipped' : 'done');
  res.json({ ok: true });
}));

// ---------- agent ----------
const agentLimiter = inboundLimiter({ windowMs: 60e3, max: 20, message: 'Too many agent requests per minute' });

app.post('/api/agent/chat', agentLimiter, wrap((req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) throw new Error('Message is required');
  if (message.length > 8000) throw new Error('Message too long');
  if (!claudeConfigured()) {
    return res.status(412).json({ error: 'Claude is not connected. Add ANTHROPIC_API_KEY in Agent Settings.', integration: 'claude' });
  }
  const convId = req.body?.conversation_id ? Number(req.body.conversation_id) : null;
  if (convId && !get('SELECT id FROM conversations WHERE id = ?', convId)) throw new Error('Conversation not found');
  const { runId, conversationId } = startRun({ prompt: message, conversationId: convId, kind: 'chat' });
  res.json({ run_id: runId, conversation_id: conversationId });
}));

// Manual controls. Each builds a precise instruction for the agent.
app.post('/api/agent/action', agentLimiter, wrap((req, res) => {
  if (!claudeConfigured()) return res.status(412).json({ error: 'Claude is not connected. Add ANTHROPIC_API_KEY in Agent Settings.', integration: 'claude' });
  const b = req.body || {};
  const settings = getSettings();
  let prompt;
  let title;
  switch (b.action) {
    case 'find_clients': {
      const count = Math.min(Math.max(Number(b.count) || 10, 1), 30);
      const what = String(b.industry || 'businesses that could buy custom manufacturing').slice(0, 200);
      const where = String(b.area || settings.target_cities.slice(0, 3).join(', ') + ', MI').slice(0, 200);
      const product = b.product ? ` Focus on prospects for: ${String(b.product).slice(0, 200)}.` : '';
      prompt = `Find Clients Now: find ${count} new prospects — ${what} — in/around ${where}.${product} Research each (website + public signals), save with honest scores and cited evidence, and draft initial outreach for leads scoring ${settings.min_score_to_draft}+. Finish with a ranked summary.`;
      title = `Find: ${what} — ${where}`;
      break;
    }
    case 'research': {
      const target = String(b.target || '').slice(0, 500);
      const lead = b.lead_id ? get('SELECT id, name, website, city FROM leads WHERE id = ?', Number(b.lead_id)) : null;
      if (!lead && !target) throw new Error('Provide a business name/URL or lead');
      const who = lead ? `lead #${lead.id} ${lead.name}${lead.website ? ` (${lead.website})` : ''}${lead.city ? ` in ${lead.city}` : ''}` : target;
      prompt = `Research This Business: ${who}. Find it (Google Places / website / web search), analyze its public website and recent public activity, identify which WoogzMadeit products fit and why, find publicly listed decision-maker contact info if published, save_lead with cited evidence, and explain concretely how we could win their business (angle, first offer, objections, best channel).`;
      title = `Research: ${lead ? lead.name : target}`;
      break;
    }
    case 'pitch': {
      const lead = get('SELECT id, name FROM leads WHERE id = ?', Number(b.lead_id));
      if (!lead) throw new Error('Lead not found');
      const channels = Array.isArray(b.channels) && b.channels.length ? b.channels.join(', ') : 'email, instagram_dm, phone_script';
      prompt = `Generate Pitch for lead #${lead.id} ${lead.name}. Use get_lead first. Draft personalized outreach on these channels: ${channels} (draft_outreach kind initial). Base it only on verified facts in the lead record.`;
      title = `Pitch: ${lead.name}`;
      break;
    }
    case 'follow_up': {
      const lead = get('SELECT id, name FROM leads WHERE id = ?', Number(b.lead_id));
      if (!lead) throw new Error('Lead not found');
      prompt = `Prepare Follow-Up for lead #${lead.id} ${lead.name}. Use get_lead to review history and prior messages, then draft one short follow-up on the most appropriate channel (draft_outreach kind follow_up) and schedule_follow_up for a sensible next date if none is open.`;
      title = `Follow-up: ${lead.name}`;
      break;
    }
    default:
      throw new Error('Unknown action');
  }
  const { runId, conversationId } = startRun({ prompt, kind: 'manual', title });
  res.json({ run_id: runId, conversation_id: conversationId });
}));

app.get('/api/conversations', (req, res) => {
  res.json(all('SELECT c.*, (SELECT status FROM agent_runs r WHERE r.conversation_id = c.id ORDER BY r.id DESC LIMIT 1) AS last_status FROM conversations c ORDER BY updated_at DESC LIMIT 100'));
});
app.get('/api/conversations/:id', (req, res) => {
  const c = get('SELECT * FROM conversations WHERE id = ?', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  const msgs = all('SELECT id, role, content, run_id, created_at FROM messages WHERE conversation_id = ? ORDER BY id', c.id);
  // Render-friendly transcript: user text, assistant text (+ citations), tool activity.
  const items = [];
  for (const m of msgs) {
    const content = parseJson(m.content, []);
    if (m.role === 'user') {
      const text = content.filter((b) => b.type === 'text').map((b) => b.text.replace(/\n\n\[Context: [^\]]*\]$/, '')).join('\n');
      if (text) items.push({ role: 'user', text, run_id: m.run_id, created_at: m.created_at });
    } else {
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const citations = content.filter((b) => b.type === 'text').flatMap((b) => (b.citations || []).map((c) => ({ url: c.url, title: c.title }))).filter((c) => c.url);
      const tools = content.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use').map((b) => ({ name: b.name, input: b.input }));
      if (text || tools.length) items.push({ role: 'assistant', text, citations, tools, run_id: m.run_id, created_at: m.created_at });
    }
  }
  const runs = all('SELECT id, status, error, created_at, finished_at FROM agent_runs WHERE conversation_id = ? ORDER BY id', c.id);
  res.json({ conversation: c, items, runs });
});
app.delete('/api/conversations/:id', wrap((req, res) => {
  run('DELETE FROM conversations WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

app.get('/api/runs', (req, res) => {
  res.json(all('SELECT r.*, c.title FROM agent_runs r LEFT JOIN conversations c ON c.id = r.conversation_id ORDER BY r.id DESC LIMIT ?', Math.min(Number(req.query.limit) || 50, 200)));
});
app.get('/api/runs/:id/events', (req, res) => {
  res.json(all('SELECT * FROM run_events WHERE run_id = ? ORDER BY id', Number(req.params.id)).map((e) => ({ ...e, data: parseJson(e.data, null) })));
});
app.get('/api/activity', (req, res) => {
  res.json(all(`SELECT e.*, c.title FROM run_events e JOIN agent_runs r ON r.id = e.run_id LEFT JOIN conversations c ON c.id = r.conversation_id ORDER BY e.id DESC LIMIT ?`, Math.min(Number(req.query.limit) || 100, 500)).map((e) => ({ ...e, data: parseJson(e.data, null) })));
});
app.get('/api/search-history', (req, res) => {
  res.json(all('SELECT id, run_id, provider, query, result_count, status, error, created_at FROM search_history ORDER BY id DESC LIMIT 200'));
});

// Live events (Server-Sent Events)
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const onEvent = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
});

// ---------- schedules & reports ----------
app.get('/api/schedules', (req, res) => res.json(all('SELECT * FROM schedules ORDER BY id')));
app.patch('/api/schedules/:id', wrap((req, res) => {
  const s = get('SELECT * FROM schedules WHERE id = ?', Number(req.params.id));
  if (!s) throw new Error('Schedule not found');
  const enabled = req.body?.enabled === undefined ? s.enabled : req.body.enabled ? 1 : 0;
  let daily = s.daily_time;
  if (req.body?.daily_time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.daily_time)) throw new Error('Time must be HH:MM (24h)');
    daily = req.body.daily_time;
  }
  const next = computeNext({ ...s, daily_time: daily }).toISOString();
  run('UPDATE schedules SET enabled = ?, daily_time = ?, next_run_at = ? WHERE id = ?', enabled, daily, next, s.id);
  res.json(get('SELECT * FROM schedules WHERE id = ?', s.id));
}));
app.post('/api/schedules/:id/run', agentLimiter, wrap((req, res) => {
  const s = get('SELECT * FROM schedules WHERE id = ?', Number(req.params.id));
  if (!s) throw new Error('Schedule not found');
  runSchedule(s, 'manual').catch(() => {});
  res.json({ ok: true, message: `${s.name} started` });
}));
app.get('/api/reports', (req, res) => res.json(all('SELECT id, report_date, emailed_at, email_error, created_at FROM reports ORDER BY id DESC LIMIT 60')));
app.get('/api/reports/latest', (req, res) => {
  const r = get('SELECT * FROM reports ORDER BY id DESC LIMIT 1');
  if (!r) {
    const data = buildReportData();
    return res.json({ preview: true, data, markdown: reportToMarkdown(data) });
  }
  res.json({ ...r, data: parseJson(r.data, {}) });
});
app.get('/api/reports/:id', (req, res) => {
  const r = get('SELECT * FROM reports WHERE id = ?', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r, data: parseJson(r.data, {}) });
});
app.post('/api/reports', wrap(async (req, res) => res.json(await generateDailyReport({ email: Boolean(req.body?.email) }))));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- static UI ----------
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.listen(config.port, () => {
  console.log(`WoogzMadeit Client Finder listening on http://localhost:${config.port}`);
  if (config.enableScheduler) startScheduler();
  const st = integrationStatus();
  for (const [k, v] of Object.entries(st)) console.log(`  ${v.connected ? '✓' : '✗'} ${v.label}${v.connected ? '' : ` — ${v.how}`}`);
});
