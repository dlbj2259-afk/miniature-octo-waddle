// Lead identity normalization and duplicate detection.
import { get } from '../db.js';

// Domains that are not a business's own site — never used as a dedupe key.
const SHARED_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com',
  'yelp.com', 'google.com', 'goo.gl', 'linktr.ee', 'square.site', 'squareup.com', 'toasttab.com',
  'doordash.com', 'ubereats.com', 'grubhub.com', 'etsy.com', 'amazon.com', 'business.site', 'sites.google.com',
  'wixsite.com', 'godaddysites.com', 'shopify.com', 'myshopify.com', 'weebly.com', 'carrd.co', 'bit.ly',
]);

export function normalizeDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (SHARED_DOMAINS.has(host) || [...SHARED_DOMAINS].some((d) => host.endsWith(`.${d}`))) return null;
    return host;
  } catch {
    return null;
  }
}

export function normalizePhone(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

const SUFFIXES = /\b(llc|l\.l\.c|inc|incorporated|co|company|corp|corporation|ltd|the|pllc|lp)\b/g;

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find an existing lead that is the same business. Returns { lead, matchedOn } or null. */
export function findDuplicate({ google_place_id, website, phone, name, city }) {
  if (google_place_id) {
    const l = get('SELECT * FROM leads WHERE google_place_id = ?', google_place_id);
    if (l) return { lead: l, matchedOn: 'google_place_id' };
  }
  const domain = normalizeDomain(website);
  if (domain) {
    const l = get('SELECT * FROM leads WHERE domain = ?', domain);
    if (l) return { lead: l, matchedOn: 'website domain' };
  }
  const digits = normalizePhone(phone);
  if (digits) {
    const l = get('SELECT * FROM leads WHERE phone_digits = ?', digits);
    if (l) return { lead: l, matchedOn: 'phone' };
  }
  const nn = normalizeName(name);
  if (nn && city) {
    const l = get('SELECT * FROM leads WHERE normalized_name = ? AND lower(city) = lower(?)', nn, city);
    if (l) return { lead: l, matchedOn: 'name + city' };
  }
  return null;
}
