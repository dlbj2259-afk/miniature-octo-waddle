// Client-side tools the agent can call. Each tool: definition + executor.
import { all, run } from '../db.js';
import { config } from '../config.js';
import { searchPlaces } from '../integrations/places.js';
import { analyzeWebsite } from '../integrations/website.js';
import { searchOpportunities } from '../integrations/sam.js';
import { findDuplicate, normalizePhone } from '../leads/dedupe.js';
import {
  saveLead, getLeadDetail, listLeads, updateLead, addFollowUp, createDraft, pipelineSummary, STAGES,
} from '../leads/repo.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const rating = (description) => ({ type: 'number', minimum: 0, maximum: 10, description });

export const CHANNELS = ['email', 'instagram_dm', 'facebook_message', 'phone_script', 'linkedin_message', 'text_message'];

export const TOOL_DEFS = [
  {
    name: 'search_businesses',
    description:
      'Search Google Places for real businesses. Returns name, address, website, phone, category, rating and whether the business is already in the CRM (existing_lead_id). Use specific queries like "custom cake bakery".',
    input_schema: {
      type: 'object',
      properties: {
        query: str('What to search for, e.g. "chocolatier" or "marketing agency".'),
        area: str('Location, e.g. "Pontiac, MI" or "Oakland County, Michigan". Defaults to the home base.'),
        max_results: { type: 'integer', minimum: 1, maximum: 60, description: 'Default 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'analyze_website',
    description:
      "Fetch and analyze a business's public website (homepage plus contact/about pages, robots.txt respected). Returns page text, public emails, phones and social links.",
    input_schema: { type: 'object', properties: { url: str('Website URL') }, required: ['url'] },
  },
  {
    name: 'search_procurement',
    description: 'Search SAM.gov for open federal contracting opportunities (e.g. signage, promotional items, 3D printing, plaques, awards).',
    input_schema: {
      type: 'object',
      properties: {
        keywords: str('Title keywords, e.g. "signage" or "promotional items"'),
        state: str('2-letter state for place of performance, default MI. Empty string for nationwide.'),
        days_back: { type: 'integer', minimum: 1, maximum: 364 },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'save_lead',
    description:
      'Save (or merge with an existing duplicate) a researched lead with factor ratings. The server computes the 0–100 score, enforces that evidence ratings require cited sources, and verifies contact details against what tools actually returned.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('Business name'),
        industry: str('Industry, e.g. "Bakery"'),
        google_place_id: str('Place id from search_businesses, if any'),
        address: str('Full address'),
        city: str('City'),
        state: str('State'),
        postal_code: str('ZIP'),
        lat: num('Latitude from search results'),
        lng: num('Longitude from search results'),
        website: str('Website URL'),
        phone: str('Public business phone'),
        email: str('Public business email exactly as found'),
        email_source_url: str('URL where the email was found'),
        contact_name: str('Publicly listed decision-maker name'),
        contact_title: str('Their title'),
        contact_email: str('Their publicly listed professional email'),
        contact_phone: str('Their publicly listed professional phone'),
        contact_source_url: str('URL where the decision-maker info is published'),
        social: {
          type: 'object',
          description: 'Public social profile URLs',
          properties: { instagram: { type: 'string' }, facebook: { type: 'string' }, linkedin: { type: 'string' }, tiktok: { type: 'string' } },
        },
        recommended_products: { type: 'array', items: { type: 'string' }, description: 'Specific WoogzMadeit products/services to pitch' },
        need_reason: str('Why they might need these products, specific to the business'),
        est_value_low: num('Estimated annual opportunity value, low end (USD)'),
        est_value_high: num('Estimated annual opportunity value, high end (USD)'),
        est_value_basis: str('How the estimate was derived'),
        service_match: rating('0–10'),
        service_match_reason: { type: 'string' },
        purchase_evidence: rating('0–10; must be 0 unless evidence items support it'),
        purchase_evidence_reason: { type: 'string' },
        size_value: rating('0–10'),
        size_value_reason: { type: 'string' },
        upcoming_signals: rating('0–10; must be 0 unless an upcoming_event evidence item supports it'),
        upcoming_signals_reason: { type: 'string' },
        likelihood: rating('0–10'),
        likelihood_reason: { type: 'string' },
        evidence: {
          type: 'array',
          description: 'Cited public evidence. Each must have a source_url seen in tool results.',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string' },
              source_url: { type: 'string' },
              quote: { type: 'string', description: 'Short supporting quote from the source' },
              kind: { type: 'string', enum: ['purchase_need', 'upcoming_event', 'other'] },
            },
            required: ['claim', 'source_url', 'kind'],
          },
        },
        sources: {
          type: 'array',
          description: 'All URLs used to research this lead',
          items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, type: { type: 'string' } }, required: ['url'] },
        },
        research_gaps: str('What is still unknown / needs more research (e.g. "no public email found")'),
      },
      required: ['name', 'industry', 'recommended_products', 'need_reason', 'service_match', 'purchase_evidence', 'size_value', 'upcoming_signals', 'likelihood', 'evidence'],
    },
  },
  {
    name: 'find_leads',
    description: 'Query saved leads in the CRM with filters. Sorted by score by default.',
    input_schema: {
      type: 'object',
      properties: {
        q: str('Free-text search'),
        industry: { type: 'string' },
        tier: { type: 'string', enum: ['Hot', 'Warm', 'Cold'] },
        stage: { type: 'string', enum: STAGES },
        min_score: { type: 'number' },
        city: { type: 'string' },
        sort: { type: 'string', enum: ['score', 'value', 'recent', 'distance'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_lead',
    description: 'Get full details for one lead: research, score breakdown, sources, history, drafts, follow-ups, quotes.',
    input_schema: { type: 'object', properties: { lead_id: { type: 'integer' } }, required: ['lead_id'] },
  },
  {
    name: 'draft_outreach',
    description: 'Save an outreach message draft for owner review. It is NOT sent. Write the full message yourself.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'integer' },
        channel: { type: 'string', enum: CHANNELS },
        kind: { type: 'string', enum: ['initial', 'follow_up'] },
        subject: str('Email subject (email only)'),
        body: str('Full message text or call script'),
      },
      required: ['lead_id', 'channel', 'kind', 'body'],
    },
  },
  {
    name: 'update_lead',
    description: "Update a lead's pipeline stage, add a note, or set potential revenue. Only change stages when the owner asks or the facts clearly warrant it.",
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'integer' },
        stage: { type: 'string', enum: STAGES },
        note: { type: 'string' },
        potential_revenue: { type: 'number' },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'schedule_follow_up',
    description: 'Schedule a follow-up reminder for a lead.',
    input_schema: {
      type: 'object',
      properties: { lead_id: { type: 'integer' }, due_date: str('YYYY-MM-DD'), reason: { type: 'string' } },
      required: ['lead_id', 'due_date'],
    },
  },
  {
    name: 'pipeline_summary',
    description: 'Counts and estimated value by pipeline stage, hot/warm counts, pending drafts, due follow-ups.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'follow_up_queue',
    description: 'Follow-ups due within N days, plus leads contacted more than 4 days ago with no newer activity.',
    input_schema: { type: 'object', properties: { days_ahead: { type: 'integer', minimum: 0, maximum: 30 } } },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

// ---- input validation (eager streaming means the server no longer validates) ----
function typeOk(schema, v) {
  if (v === undefined || v === null) return true;
  switch (schema.type) {
    case 'string':
      return typeof v === 'string' && (!schema.enum || schema.enum.includes(v));
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && !Array.isArray(v);
    default:
      return true;
  }
}

export function validateToolInput(name, input) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return `Unknown tool ${name}`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'INVALID_JSON: input must be an object';
  const s = def.input_schema;
  for (const r of s.required || []) if (input[r] === undefined || input[r] === null || input[r] === '') return `Missing required field "${r}"`;
  for (const [k, ps] of Object.entries(s.properties || {})) {
    if (!typeOk(ps, input[k])) return `Field "${k}" has the wrong type (expected ${ps.type}${ps.enum ? ` one of ${ps.enum.join('|')}` : ''})`;
  }
  return null;
}

// ---- helpers ----
function remember(ctx, ...texts) {
  for (const t of texts) if (t) ctx.corpus.push(typeof t === 'string' ? t : JSON.stringify(t));
}

function logSearch(ctx, provider, query, params, status, results, error) {
  run(
    'INSERT INTO search_history(run_id, provider, query, params, result_count, status, error, results) VALUES(?,?,?,?,?,?,?,?)',
    ctx.runId,
    provider,
    query,
    params ? JSON.stringify(params) : null,
    Array.isArray(results) ? results.length : null,
    status,
    error || null,
    results ? JSON.stringify(results).slice(0, 200000) : null
  );
}

/** Verify a contact value appears in material the tools actually returned (or the existing lead record). */
function verifyContacts(input, ctx) {
  const corpus = ctx.corpus.join('\n').toLowerCase();
  const corpusDigits = corpus.replace(/\D/g, '');
  const warnings = [];
  const out = { ...input };
  const existing = findDuplicate(input)?.lead;

  const emailOk = (e) => !e || corpus.includes(String(e).toLowerCase()) || [existing?.email, existing?.contact_email].includes(e);
  const phoneOk = (p) => {
    const d = normalizePhone(p);
    return !p || (d && (corpusDigits.includes(d) || [existing?.phone_digits, normalizePhone(existing?.contact_phone)].includes(d)));
  };
  for (const k of ['email', 'contact_email']) {
    if (!emailOk(out[k])) {
      warnings.push(`${k} "${out[k]}" was not found in any tool result this session — discarded.`);
      out[k] = null;
    }
  }
  for (const k of ['phone', 'contact_phone']) {
    if (!phoneOk(out[k])) {
      warnings.push(`${k} "${out[k]}" was not found in any tool result this session — discarded.`);
      out[k] = null;
    }
  }
  if (out.contact_name) {
    const nameFound = corpus.includes(String(out.contact_name).toLowerCase()) || existing?.contact_name === out.contact_name;
    if (!nameFound || !out.contact_source_url) {
      warnings.push(`Decision-maker "${out.contact_name}" discarded: ${nameFound ? 'no contact_source_url given' : 'name not found in tool results'}.`);
      out.contact_name = out.contact_title = out.contact_email = out.contact_phone = out.contact_source_url = null;
    }
  }
  if (out.email && !out.email_source_url) out.email_source_url = out.website || null;
  return { input: out, warnings };
}

function compactLead(l) {
  return {
    id: l.id, name: l.name, industry: l.industry, city: l.city, score: l.score, tier: l.score_tier, stage: l.stage,
    website: l.website, email: l.email, phone: l.phone, recommended_products: l.recommended_products,
    est_value: l.est_value_low != null ? `$${l.est_value_low}–$${l.est_value_high} (estimate)` : null,
    next_follow_up_at: l.next_follow_up_at, research_status: l.research_status,
  };
}

// ---- executors ----
export const EXECUTORS = {
  async search_businesses(input, ctx) {
    const area = input.area || ctx.defaultArea || config.homeBase.name;
    const query = `${input.query} in ${area}`;
    try {
      const results = await searchPlaces({ query, lat: config.homeBase.lat, lng: config.homeBase.lng, radiusMiles: 30, maxResults: input.max_results || 20 });
      const annotated = results
        .filter((r) => r.business_status !== 'CLOSED_PERMANENTLY')
        .map((r) => ({ ...r, existing_lead_id: findDuplicate(r)?.lead.id ?? null }));
      remember(ctx, annotated);
      logSearch(ctx, 'google_places', query, { max_results: input.max_results }, 'ok', annotated);
      return { query, count: annotated.length, results: annotated };
    } catch (e) {
      logSearch(ctx, 'google_places', query, null, 'error', null, e.message);
      throw e;
    }
  },

  async analyze_website(input, ctx) {
    try {
      const result = await analyzeWebsite(input.url);
      remember(ctx, result.emails.join(' '), result.phones.join(' '), ...result.pages.map((p) => `${p.url}\n${p.text}`), JSON.stringify(result.social));
      logSearch(ctx, 'website', input.url, null, result.blocked_by_robots ? 'blocked_by_robots' : 'ok', result.pages.map((p) => ({ url: p.url, title: p.title })));
      return result;
    } catch (e) {
      logSearch(ctx, 'website', input.url, null, 'error', null, e.message);
      throw e;
    }
  },

  async search_procurement(input, ctx) {
    const state = input.state === undefined ? 'MI' : input.state;
    try {
      const results = await searchOpportunities({ keywords: input.keywords, state, daysBack: input.days_back || 60 });
      remember(ctx, results);
      logSearch(ctx, 'sam_gov', input.keywords, { state }, 'ok', results);
      return { count: results.length, results };
    } catch (e) {
      logSearch(ctx, 'sam_gov', input.keywords, { state }, 'error', null, e.message);
      throw e;
    }
  },

  async save_lead(input, ctx) {
    const { input: clean, warnings } = verifyContacts(input, ctx);
    const analysis = {
      service_match: clean.service_match, service_match_reason: clean.service_match_reason,
      purchase_evidence: clean.purchase_evidence, purchase_evidence_reason: clean.purchase_evidence_reason,
      size_value: clean.size_value, size_value_reason: clean.size_value_reason,
      upcoming_signals: clean.upcoming_signals, upcoming_signals_reason: clean.upcoming_signals_reason,
      likelihood: clean.likelihood, likelihood_reason: clean.likelihood_reason,
      evidence: clean.evidence,
    };
    // Evidence URLs must be URLs the agent actually saw this session.
    const seen = ctx.corpus.join('\n') + '\n' + ctx.seenUrls.join('\n');
    analysis.evidence = (clean.evidence || []).filter((e) => {
      const ok = e.source_url && seen.includes(e.source_url.replace(/\/$/, ''));
      if (!ok) warnings.push(`Evidence "${e.claim?.slice(0, 60)}" dropped: source URL ${e.source_url} was not returned by any tool this session.`);
      return ok;
    });
    const sources = [...(clean.sources || [])];
    if (clean.website) sources.push({ url: clean.website, type: 'website' });
    for (const e of analysis.evidence) sources.push({ url: e.source_url, type: 'evidence' });
    const res = saveLead(clean, { runId: ctx.runId, analysis, sources });
    ctx.savedLeads.push(res.lead.id);
    return {
      lead_id: res.lead.id,
      created: res.created,
      merged_with_existing: res.merged ? `matched on ${res.matchedOn}` : false,
      score: res.lead.score,
      tier: res.lead.score_tier,
      stage: res.lead.stage,
      score_reasoning: res.lead.score_reasoning,
      warnings: [...warnings, ...res.warnings],
    };
  },

  async find_leads(input) {
    const { total, leads } = listLeads({ ...input, minScore: input.min_score, limit: input.limit || 25 });
    return { total, leads: leads.map(compactLead) };
  },

  async get_lead(input) {
    const l = getLeadDetail(input.lead_id);
    if (!l) throw new Error(`Lead ${input.lead_id} not found`);
    return { ...l, activities: l.activities.slice(0, 30) };
  },

  async draft_outreach(input, ctx) {
    const id = createDraft({ leadId: input.lead_id, channel: input.channel, kind: input.kind, subject: input.subject, body: input.body, runId: ctx.runId });
    ctx.drafts.push(id);
    return { draft_id: id, status: 'pending_approval', note: 'Saved for owner review. Not sent.' };
  },

  async update_lead(input) {
    const l = updateLead(input.lead_id, { stage: input.stage, note: input.note, potential_revenue: input.potential_revenue }, 'agent');
    return compactLead(l);
  },

  async schedule_follow_up(input) {
    const id = addFollowUp(input.lead_id, input.due_date, input.reason);
    return { follow_up_id: id, due_date: input.due_date };
  },

  async pipeline_summary() {
    return pipelineSummary();
  },

  async follow_up_queue(input) {
    const horizon = new Date(Date.now() + (input.days_ahead ?? 1) * 864e5).toISOString();
    const due = all(
      `SELECT f.id AS follow_up_id, f.due_at, f.reason, l.id AS lead_id, l.name, l.stage, l.score, l.score_tier
       FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.status = 'open' AND f.due_at <= ? ORDER BY f.due_at`,
      horizon
    );
    const stale = all(
      `SELECT l.id AS lead_id, l.name, l.stage, l.score, MAX(a.created_at) AS last_activity
       FROM leads l JOIN lead_activities a ON a.lead_id = l.id
       WHERE l.stage = 'contacted' GROUP BY l.id HAVING last_activity < datetime('now', '-4 days')`
    );
    return { due, contacted_no_recent_activity: stale };
  },
};

export function toolSummary(name, result) {
  try {
    switch (name) {
      case 'search_businesses':
        return `${result.count} businesses found for “${result.query}”`;
      case 'analyze_website':
        return result.blocked_by_robots ? `Skipped ${result.url} (robots.txt)` : `Read ${result.pages.length} page(s) on ${new URL(result.url).hostname}; ${result.emails.length} email(s), ${result.phones.length} phone(s)`;
      case 'search_procurement':
        return `${result.count} SAM.gov opportunities`;
      case 'save_lead':
        return `${result.created ? 'Saved' : 'Updated'} lead #${result.lead_id}: score ${result.score} (${result.tier})${result.warnings.length ? ` — ${result.warnings.length} warning(s)` : ''}`;
      case 'draft_outreach':
        return `Draft #${result.draft_id} saved for approval`;
      case 'find_leads':
        return `${result.leads.length} of ${result.total} leads`;
      default:
        return `${name.replace(/_/g, ' ')} complete`;
    }
  } catch {
    return 'done';
  }
}
