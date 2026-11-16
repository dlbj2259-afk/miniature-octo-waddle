// Lead persistence: create/merge with dedupe, history, pipeline operations.
import { all, get, run, tx, parseJson } from '../db.js';
import { config } from '../config.js';
import { findDuplicate, normalizeDomain, normalizeName, normalizePhone } from './dedupe.js';
import { haversineMiles, scoreLead } from './scoring.js';
import { emitAppEvent } from '../events.js';

export const STAGES = ['new', 'researched', 'qualified', 'contacted', 'interested', 'quote_sent', 'negotiating', 'won', 'lost'];
export const STAGE_LABELS = {
  new: 'New Lead',
  researched: 'Researched',
  qualified: 'Qualified',
  contacted: 'Contacted',
  interested: 'Interested',
  quote_sent: 'Quote Sent',
  negotiating: 'Negotiating',
  won: 'Won',
  lost: 'Lost',
};

export function addActivity(leadId, type, summary, details) {
  run('INSERT INTO lead_activities(lead_id, type, summary, details) VALUES(?,?,?,?)', leadId, type, summary, details ? JSON.stringify(details) : null);
}

export function addSources(leadId, sources = []) {
  for (const s of sources) {
    if (!s?.url || !/^https?:\/\//i.test(s.url)) continue;
    run(
      `INSERT INTO lead_sources(lead_id, url, title, source_type) VALUES(?,?,?,?)
       ON CONFLICT(lead_id, url) DO UPDATE SET retrieved_at = datetime('now'), title = COALESCE(excluded.title, title)`,
      leadId,
      s.url,
      s.title || null,
      s.type || null
    );
  }
}

export function hydrate(l) {
  if (!l) return l;
  return {
    ...l,
    social: parseJson(l.social_json, {}),
    recommended_products: parseJson(l.recommended_products, []),
    score_breakdown: parseJson(l.score_breakdown, {}),
    evidence: parseJson(l.evidence, []),
    stage_label: STAGE_LABELS[l.stage] || l.stage,
    est_value_mid: l.est_value_low != null && l.est_value_high != null ? Math.round((l.est_value_low + l.est_value_high) / 2) : null,
  };
}

const MERGEABLE = [
  'industry', 'category', 'address', 'city', 'state', 'postal_code', 'lat', 'lng', 'website', 'email', 'email_source_url', 'phone',
  'contact_name', 'contact_title', 'contact_email', 'contact_phone', 'contact_source_url', 'google_place_id', 'google_maps_url',
  'rating', 'review_count', 'business_status',
];

/**
 * Create or merge a lead. `analysis` (optional) contains factor ratings for scoring.
 * Returns { lead, created, merged, matchedOn, warnings }.
 */
export function saveLead(input, { runId = null, analysis = null, sources = [] } = {}) {
  return tx(() => {
    const warnings = [];
    const dup = findDuplicate(input);
    const base = dup ? dup.lead : null;

    const f = {};
    for (const k of MERGEABLE) {
      const incoming = input[k];
      const existing = base ? base[k] : null;
      // Never overwrite existing verified data with empties; fill gaps; refresh business facts from Places.
      f[k] = incoming != null && incoming !== '' ? (existing != null && existing !== '' && !['rating', 'review_count', 'business_status'].includes(k) ? existing : incoming) : existing;
    }
    const name = base?.name || input.name;
    const lat = f.lat;
    const lng = f.lng;
    const distance = haversineMiles(config.homeBase, { lat, lng });
    const social = { ...parseJson(base?.social_json, {}), ...(input.social || {}) };

    let scoring = null;
    if (analysis) {
      scoring = scoreLead(analysis, { distanceMiles: distance });
      warnings.push(...scoring.warnings);
    }

    const fields = {
      ...f,
      name,
      normalized_name: normalizeName(name),
      domain: normalizeDomain(f.website),
      phone_digits: normalizePhone(f.phone),
      distance_miles: distance == null ? null : Math.round(distance * 10) / 10,
      social_json: JSON.stringify(social),
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (input.recommended_products?.length) fields.recommended_products = JSON.stringify(input.recommended_products);
    if (input.need_reason) fields.need_reason = input.need_reason;
    if (input.research_gaps !== undefined) fields.research_gaps = input.research_gaps || null;
    if (input.est_value_low != null && input.est_value_high != null) {
      const lo = Math.max(0, Number(input.est_value_low));
      const hi = Math.max(lo, Number(input.est_value_high));
      fields.est_value_low = lo;
      fields.est_value_high = hi;
      fields.est_value_basis = input.est_value_basis || null;
    }
    if (scoring) {
      fields.score = scoring.score;
      fields.score_tier = scoring.tier;
      fields.score_breakdown = JSON.stringify(scoring.breakdown);
      fields.score_reasoning = scoring.reasoning;
      fields.evidence = JSON.stringify(scoring.evidence);
      fields.research_status = input.research_gaps ? 'needs_more' : 'researched';
    }

    let leadId;
    if (base) {
      leadId = base.id;
      if (scoring && ['new', 'researched'].includes(base.stage)) {
        fields.stage = scoring.tier === 'Cold' ? 'researched' : 'qualified';
      }
      const keys = Object.keys(fields);
      run(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k] ?? null), leadId);
      addActivity(leadId, scoring ? 'research' : 'merge', scoring ? `Re-researched; score ${base.score ?? '—'} → ${scoring.score} (${scoring.tier})` : `Matched existing lead on ${dup.matchedOn}; filled missing details`, { run_id: runId, matched_on: dup.matchedOn });
    } else {
      fields.stage = scoring ? (scoring.tier === 'Cold' ? 'researched' : 'qualified') : 'new';
      fields.discovered_by_run_id = runId;
      const keys = Object.keys(fields);
      leadId = Number(run(`INSERT INTO leads(${keys.join(', ')}) VALUES(${keys.map(() => '?').join(', ')})`, ...keys.map((k) => fields[k] ?? null)).lastInsertRowid);
      addActivity(leadId, 'system', scoring ? `Discovered and scored ${scoring.score} (${scoring.tier})` : 'Discovered', { run_id: runId });
    }
    addSources(leadId, sources);
    const lead = hydrate(get('SELECT * FROM leads WHERE id = ?', leadId));
    emitAppEvent('lead_saved', { id: leadId, name: lead.name, score: lead.score, tier: lead.score_tier, created: !base });
    return { lead, created: !base, merged: Boolean(base), matchedOn: dup?.matchedOn || null, warnings };
  });
}

export function getLeadDetail(id) {
  const lead = hydrate(get('SELECT * FROM leads WHERE id = ?', id));
  if (!lead) return null;
  return {
    ...lead,
    sources: all('SELECT * FROM lead_sources WHERE lead_id = ? ORDER BY retrieved_at DESC', id),
    activities: all('SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY id DESC LIMIT 200', id).map((a) => ({ ...a, details: parseJson(a.details, null) })),
    drafts: all('SELECT * FROM outreach_drafts WHERE lead_id = ? ORDER BY id DESC', id),
    follow_ups: all('SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY due_at', id),
    quotes: all('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC', id),
  };
}

export function listLeads({ q, industry, tier, stage, minScore, city, limit = 100, offset = 0, sort = 'score', includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push('archived = 0');
  if (q) {
    where.push('(name LIKE ? OR industry LIKE ? OR city LIKE ? OR need_reason LIKE ? OR category LIKE ?)');
    params.push(...Array(5).fill(`%${q}%`));
  }
  if (industry) {
    where.push('(industry LIKE ? OR category LIKE ?)');
    params.push(`%${industry}%`, `%${industry}%`);
  }
  if (tier) {
    where.push('score_tier = ?');
    params.push(tier);
  }
  if (stage) {
    where.push('stage = ?');
    params.push(stage);
  }
  if (minScore != null && minScore !== '') {
    where.push('score >= ?');
    params.push(Number(minScore));
  }
  if (city) {
    where.push('city LIKE ?');
    params.push(`%${city}%`);
  }
  const order =
    {
      score: 'score IS NULL, score DESC, id DESC',
      value: 'COALESCE(est_value_high, 0) DESC, score DESC',
      recent: 'id DESC',
      distance: 'distance_miles IS NULL, distance_miles ASC',
      name: 'name COLLATE NOCASE',
    }[sort] || 'score DESC';
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(`SELECT * FROM leads ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
  const total = get(`SELECT COUNT(*) AS n FROM leads ${w}`, ...params).n;
  return { total, leads: rows.map(hydrate) };
}

export function updateLead(id, patch, actor = 'user') {
  const lead = get('SELECT * FROM leads WHERE id = ?', id);
  if (!lead) throw new Error(`Lead ${id} not found`);
  const allowed = ['stage', 'potential_revenue', 'won_revenue', 'lost_reason', 'next_follow_up_at', 'contact_name', 'contact_title', 'contact_email', 'contact_phone', 'email', 'phone', 'website', 'industry', 'archived', 'need_reason'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (k === 'stage' && !STAGES.includes(patch[k])) throw new Error(`Invalid stage ${patch[k]}`);
    sets.push(`${k} = ?`);
    vals.push(patch[k] === '' ? null : patch[k]);
  }
  if (patch.website !== undefined) {
    sets.push('domain = ?');
    vals.push(normalizeDomain(patch.website));
  }
  if (patch.phone !== undefined) {
    sets.push('phone_digits = ?');
    vals.push(normalizePhone(patch.phone));
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    run(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  }
  if (patch.stage && patch.stage !== lead.stage) {
    addActivity(id, 'stage_change', `Stage: ${STAGE_LABELS[lead.stage]} → ${STAGE_LABELS[patch.stage]}${actor === 'agent' ? ' (by agent)' : ''}`, { from: lead.stage, to: patch.stage });
    if (patch.stage === 'contacted' && !patch.next_follow_up_at) {
      // Default follow-up 4 days after first contact.
      const due = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
      addFollowUp(id, due, 'Check for a reply to initial outreach');
    }
  }
  if (patch.note) addActivity(id, patch.note_type || 'note', patch.note);
  emitAppEvent('lead_updated', { id });
  return hydrate(get('SELECT * FROM leads WHERE id = ?', id));
}

export function addFollowUp(leadId, dueDate, reason) {
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) throw new Error('Invalid due date');
  const iso = String(dueDate).length <= 10 ? `${dueDate}T13:00:00.000Z` : due.toISOString();
  const id = Number(run('INSERT INTO follow_ups(lead_id, due_at, reason) VALUES(?,?,?)', leadId, iso, reason || null).lastInsertRowid);
  const next = get("SELECT MIN(due_at) AS d FROM follow_ups WHERE lead_id = ? AND status = 'open'", leadId).d;
  run('UPDATE leads SET next_follow_up_at = ? WHERE id = ?', next, leadId);
  addActivity(leadId, 'follow_up', `Follow-up scheduled for ${iso.slice(0, 10)}${reason ? `: ${reason}` : ''}`);
  return id;
}

export function completeFollowUp(id, status = 'done') {
  const fu = get('SELECT * FROM follow_ups WHERE id = ?', id);
  if (!fu) throw new Error('Follow-up not found');
  run("UPDATE follow_ups SET status = ?, completed_at = datetime('now') WHERE id = ?", status, id);
  const next = get("SELECT MIN(due_at) AS d FROM follow_ups WHERE lead_id = ? AND status = 'open'", fu.lead_id).d;
  run('UPDATE leads SET next_follow_up_at = ? WHERE id = ?', next, fu.lead_id);
  addActivity(fu.lead_id, 'follow_up', `Follow-up marked ${status}`);
}

export function createDraft({ leadId, channel, kind = 'initial', subject, body, createdBy = 'agent', runId = null }) {
  if (!get('SELECT id FROM leads WHERE id = ?', leadId)) throw new Error(`Lead ${leadId} not found`);
  const id = Number(
    run('INSERT INTO outreach_drafts(lead_id, channel, kind, subject, body, created_by, run_id) VALUES(?,?,?,?,?,?,?)', leadId, channel, kind, subject || null, body, createdBy, runId).lastInsertRowid
  );
  addActivity(leadId, 'draft', `${kind === 'follow_up' ? 'Follow-up' : 'Outreach'} draft (${channel}) prepared — awaiting approval`, { draft_id: id });
  emitAppEvent('draft_created', { id, lead_id: leadId });
  return id;
}

export function pipelineSummary() {
  const byStage = all("SELECT stage, COUNT(*) AS n, SUM(COALESCE(potential_revenue, (est_value_low + est_value_high) / 2.0, 0)) AS value FROM leads WHERE archived = 0 GROUP BY stage");
  const stages = STAGES.map((s) => {
    const r = byStage.find((x) => x.stage === s);
    return { stage: s, label: STAGE_LABELS[s], count: r?.n || 0, est_value: Math.round(r?.value || 0) };
  });
  const open = stages.filter((s) => !['won', 'lost'].includes(s.stage));
  return {
    stages,
    open_pipeline_est_value: open.reduce((a, s) => a + s.est_value, 0),
    won_revenue: get("SELECT COALESCE(SUM(won_revenue), 0) AS v FROM leads WHERE stage = 'won'").v,
    hot: get("SELECT COUNT(*) AS n FROM leads WHERE score_tier = 'Hot' AND archived = 0 AND stage NOT IN ('won','lost')").n,
    warm: get("SELECT COUNT(*) AS n FROM leads WHERE score_tier = 'Warm' AND archived = 0 AND stage NOT IN ('won','lost')").n,
    drafts_pending: get("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'pending'").n,
    follow_ups_due: get("SELECT COUNT(*) AS n FROM follow_ups WHERE status = 'open' AND due_at <= ?", new Date(Date.now() + 864e5).toISOString()).n,
    quotes_open_value: get("SELECT COALESCE(SUM(amount), 0) AS v FROM quotes WHERE status IN ('draft','sent')").v,
  };
}
