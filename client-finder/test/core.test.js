import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { scoreLead, haversineMiles } from '../src/leads/scoring.js';
import { normalizeDomain, normalizePhone, normalizeName } from '../src/leads/dedupe.js';
import { saveLead, updateLead, getLeadDetail, pipelineSummary } from '../src/leads/repo.js';
import { parseRobots, robotsAllows, extractFromHtml } from '../src/integrations/website.js';
import { nextDailyRun } from '../src/jobs/time.js';
import { EXECUTORS, validateToolInput } from '../src/agent/tools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
openDb(path.join(tmp, 'test.db'));

const baseFactors = {
  service_match: 9, service_match_reason: 'Makes chocolate bonbons',
  purchase_evidence: 8, purchase_evidence_reason: 'Advertises custom logo chocolates',
  size_value: 5, size_value_reason: 'Two locations',
  upcoming_signals: 7, upcoming_signals_reason: 'Holiday market',
  likelihood: 8, likelihood_reason: 'Strong fit',
};

test('evidence gate zeroes unsupported evidence and caps likelihood', () => {
  const r = scoreLead({ ...baseFactors, evidence: [] }, { distanceMiles: 5 });
  assert.equal(r.breakdown.purchase_evidence.points, 0);
  assert.equal(r.breakdown.upcoming_signals.points, 0);
  assert.equal(r.breakdown.likelihood.rating, 6);
  assert.ok(r.warnings.length >= 2);
  assert.equal(r.tier, 'Warm');
});

test('cited evidence earns points and can reach Hot', () => {
  const r = scoreLead(
    { ...baseFactors, evidence: [
      { claim: 'Offers custom logo chocolates', source_url: 'https://example-choc.com/custom', kind: 'purchase_need' },
      { claim: 'Holiday market Dec 6', source_url: 'https://example-choc.com/events', kind: 'upcoming_event' },
    ] },
    { distanceMiles: 5 }
  );
  assert.ok(r.score >= 70, `score ${r.score}`);
  assert.equal(r.tier, 'Hot');
});

test('evidence without valid URL is dropped', () => {
  const r = scoreLead({ ...baseFactors, evidence: [{ claim: 'x', source_url: 'not a url', kind: 'purchase_need' }] }, { distanceMiles: null });
  assert.equal(r.evidence.length, 0);
  assert.equal(r.breakdown.distance.rating, 3);
});

test('haversine Pontiac → Detroit is ~25 miles', () => {
  const d = haversineMiles({ lat: 42.6389, lng: -83.291 }, { lat: 42.3314, lng: -83.0458 });
  assert.ok(d > 20 && d < 28, String(d));
});

test('normalizers', () => {
  assert.equal(normalizeDomain('https://www.SweetShop.com/about'), 'sweetshop.com');
  assert.equal(normalizeDomain('https://facebook.com/sweetshop'), null);
  assert.equal(normalizePhone('+1 (248) 555-0142'), '2485550142');
  assert.equal(normalizeName("The Sweet Shop, LLC"), 'sweet shop');
});

test('saveLead dedupes by domain / place id / phone and preserves history', () => {
  const a = saveLead({ name: 'Cocoa Lab LLC', city: 'Troy', state: 'MI', website: 'https://cocoalab.example', phone: '(248) 555-0100', lat: 42.6, lng: -83.15, google_place_id: 'p1' }, { analysis: { ...baseFactors, evidence: [] } });
  assert.equal(a.created, true);
  updateLead(a.lead.id, { stage: 'contacted', note: 'Called owner' });
  const b = saveLead({ name: 'Cocoa Lab', website: 'http://www.cocoalab.example/contact', email: 'hello@cocoalab.example' });
  assert.equal(b.created, false);
  assert.equal(b.lead.id, a.lead.id);
  assert.equal(b.lead.email, 'hello@cocoalab.example');
  assert.equal(b.lead.stage, 'contacted', 'stage preserved on merge');
  const c = saveLead({ name: 'Totally Different Name', phone: '248-555-0100' });
  assert.equal(c.lead.id, a.lead.id);
  const detail = getLeadDetail(a.lead.id);
  assert.ok(detail.activities.length >= 4);
  assert.ok(detail.follow_ups.length === 1, 'contacted stage auto-schedules a follow-up');
  assert.ok(pipelineSummary().stages.find((s) => s.stage === 'contacted').count === 1);
});

test('save_lead tool discards contact details not present in tool results', async () => {
  const ctx = { runId: null, corpus: ['Sweet Spot Bakery hello@sweetspot.example (248) 555-0199 Owner: Dana Reyes https://sweetspot.example/about'], seenUrls: ['https://sweetspot.example/custom-orders'], savedLeads: [], drafts: [] };
  const input = {
    name: 'Sweet Spot Bakery', industry: 'Bakery', website: 'https://sweetspot.example', city: 'Waterford',
    email: 'hello@sweetspot.example', phone: '(248) 555-0199', contact_name: 'Dana Reyes', contact_title: 'Owner', contact_email: 'dana@sweetspot.example',
    contact_source_url: 'https://sweetspot.example/about',
    recommended_products: ['Custom silicone cake-topper molds'], need_reason: 'Custom cakes',
    ...baseFactors,
    evidence: [
      { claim: 'Takes custom orders', source_url: 'https://sweetspot.example/custom-orders', kind: 'purchase_need' },
      { claim: 'Made-up claim', source_url: 'https://never-seen.example/x', kind: 'purchase_need' },
    ],
  };
  assert.equal(validateToolInput('save_lead', input), null);
  const r = await EXECUTORS.save_lead(input, ctx);
  const lead = getLeadDetail(r.lead_id);
  assert.equal(lead.email, 'hello@sweetspot.example');
  assert.equal(lead.contact_name, 'Dana Reyes');
  assert.equal(lead.contact_email, null, 'fabricated contact email discarded');
  assert.equal(lead.evidence.length, 1, 'unseen evidence URL dropped');
  assert.ok(r.warnings.some((w) => w.includes('contact_email')));
});

test('tool input validation', () => {
  assert.match(validateToolInput('search_businesses', {}), /query/);
  assert.match(validateToolInput('draft_outreach', { lead_id: 1, channel: 'fax', kind: 'initial', body: 'x' }), /channel/);
  assert.equal(validateToolInput('search_businesses', { query: 'bakery', max_results: 10 }), null);
});

test('robots.txt parsing', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: BadBot\nDisallow: /');
  assert.equal(robotsAllows(rules, '/'), true);
  assert.equal(robotsAllows(rules, '/private/x'), false);
  assert.equal(robotsAllows(rules, '/private/ok'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), '/anything'), false);
});

test('html extraction finds public contacts and socials', () => {
  const html = `<html><head><title>Sweet Spot</title><meta name="description" content="Custom cakes"></head><body>
    <a href="mailto:orders@sweetspot.example">Email</a> Call (248) 555-0199
    <a href="https://www.instagram.com/sweetspot">IG</a><a href="/contact">Contact</a><script>var x="a@b.png"</script></body></html>`;
  const r = extractFromHtml(html, 'https://sweetspot.example/');
  assert.deepEqual(r.emails, ['orders@sweetspot.example']);
  assert.ok(r.phones.includes('(248) 555-0199'));
  assert.equal(r.social.instagram, 'https://www.instagram.com/sweetspot');
  assert.ok(r.internalLinks.includes('https://sweetspot.example/contact'));
});

test('nextDailyRun respects Detroit time zone', () => {
  const from = new Date('2026-07-01T10:00:00Z'); // 06:00 EDT
  assert.equal(nextDailyRun('07:10', 'America/Detroit', from).toISOString(), '2026-07-01T11:10:00.000Z');
  const winter = new Date('2026-12-01T13:00:00Z'); // 08:00 EST
  assert.equal(nextDailyRun('07:10', 'America/Detroit', winter).toISOString(), '2026-12-02T12:10:00.000Z');
});
