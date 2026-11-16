// Transparent, evidence-gated lead scoring (0–100).
//
// Claude rates each factor 0–10 with a reason; this module applies fixed
// weights, computes distance itself, and ENFORCES the evidence rule:
// "evidence of purchasing need" and "upcoming events/projects" earn points
// only when backed by a cited public source URL. Industry fit alone counts
// toward "service match", never toward evidence.

export const WEIGHTS = {
  service_match: 25,
  purchase_evidence: 20,
  size_value: 15,
  distance: 10,
  upcoming_signals: 10,
  likelihood: 20,
};

export const TIERS = [
  { name: 'Hot', min: 70 },
  { name: 'Warm', min: 45 },
  { name: 'Cold', min: 0 },
];

export function haversineMiles(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function distanceRating(miles) {
  if (miles == null) return { rating: 3, reason: 'Location coordinates unknown — neutral distance rating.' };
  const m = Math.round(miles * 10) / 10;
  if (miles <= 10) return { rating: 10, reason: `${m} mi from home base — local, easy pickup/delivery.` };
  if (miles <= 25) return { rating: 8, reason: `${m} mi — within metro Detroit service area.` };
  if (miles <= 60) return { rating: 6, reason: `${m} mi — regional, shipping or scheduled delivery.` };
  if (miles <= 200) return { rating: 4, reason: `${m} mi — in-state/regional; ship-only.` };
  if (miles <= 600) return { rating: 2, reason: `${m} mi — out of region; ship-only.` };
  return { rating: 1, reason: `${m} mi — national; ship-only, harder to win locally.` };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));

function isUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {object} f factor ratings from the agent
 * @param {{distanceMiles:number|null}} ctx
 * @returns {{score:number, tier:string, breakdown:object, reasoning:string, evidence:Array, warnings:string[]}}
 */
export function scoreLead(f, { distanceMiles }) {
  const warnings = [];
  const evidence = (Array.isArray(f.evidence) ? f.evidence : [])
    .filter((e) => e && typeof e.claim === 'string' && e.claim.trim())
    .map((e) => ({ claim: e.claim.trim(), source_url: e.source_url, kind: e.kind || 'purchase_need', quote: e.quote || null }));

  const valid = evidence.filter((e) => isUrl(e.source_url));
  if (valid.length < evidence.length) warnings.push(`${evidence.length - valid.length} evidence item(s) dropped: no valid source URL.`);
  const needEvidence = valid.filter((e) => e.kind !== 'upcoming_event');
  const eventEvidence = valid.filter((e) => e.kind === 'upcoming_event');

  const ratings = {
    service_match: clamp(f.service_match, 0, 10),
    purchase_evidence: clamp(f.purchase_evidence, 0, 10),
    size_value: clamp(f.size_value, 0, 10),
    upcoming_signals: clamp(f.upcoming_signals, 0, 10),
    likelihood: clamp(f.likelihood, 0, 10),
  };
  const reasons = {
    service_match: f.service_match_reason || '',
    purchase_evidence: f.purchase_evidence_reason || '',
    size_value: f.size_value_reason || '',
    upcoming_signals: f.upcoming_signals_reason || '',
    likelihood: f.likelihood_reason || '',
  };

  if (needEvidence.length === 0 && ratings.purchase_evidence > 0) {
    warnings.push('Purchase-need evidence rating set to 0: no cited public evidence was provided.');
    ratings.purchase_evidence = 0;
    reasons.purchase_evidence = 'No verified public evidence of a purchasing need yet (fit is inferred from industry only).';
  }
  if (eventEvidence.length === 0 && ratings.upcoming_signals > 0) {
    warnings.push('Upcoming-signals rating set to 0: no cited public evidence of an upcoming event/project.');
    ratings.upcoming_signals = 0;
    reasons.upcoming_signals = 'No public evidence of upcoming events or projects found.';
  }
  // Likelihood can't be high without any evidence at all.
  if (valid.length === 0 && ratings.likelihood > 6) {
    warnings.push('Likelihood capped at 6 because no evidence was cited.');
    ratings.likelihood = 6;
  }

  const dist = distanceRating(distanceMiles);
  ratings.distance = dist.rating;
  reasons.distance = dist.reason;

  const breakdown = {};
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const pts = Math.round((ratings[k] / 10) * w * 10) / 10;
    total += pts;
    breakdown[k] = { rating: ratings[k], weight: w, points: pts, reason: reasons[k] };
  }
  const score = Math.round(clamp(total, 0, 100));
  const tier = TIERS.find((t) => score >= t.min).name;

  const label = {
    service_match: 'Service match',
    purchase_evidence: 'Evidence of purchasing need',
    size_value: 'Size / potential order value',
    distance: 'Distance',
    upcoming_signals: 'Upcoming events/projects',
    likelihood: 'Likelihood to buy',
  };
  const reasoning = Object.entries(breakdown)
    .map(([k, b]) => `${label[k]}: ${b.points}/${b.weight} — ${b.reason || 'no reason given'}`)
    .join('\n');

  return { score, tier, breakdown, reasoning, evidence: valid, warnings };
}
