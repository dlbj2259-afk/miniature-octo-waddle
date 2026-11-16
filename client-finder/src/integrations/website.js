// Public website analyzer. Fetches a business's own public pages (home + up to
// two contact/about pages), honours robots.txt, blocks private network targets,
// and extracts text, public emails/phones and social profile links.
import dns from 'node:dns/promises';
import net from 'node:net';
import { fetchWithRetry, throttle } from '../ratelimit.js';

export const USER_AGENT = 'WoogzMadeitClientFinder/0.1 (B2B prospect research; respects robots.txt)';
const MAX_BYTES = 1_500_000;
const MAX_TEXT_PER_PAGE = 7000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs can be analyzed');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Non-standard ports are not allowed');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Private hosts are not allowed');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('URL resolves to a private network address');
  return u;
}

async function safeGet(url, accept = 'text/html,application/xhtml+xml') {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(current);
    await throttle(`site:${u.hostname}`, 1000); // be polite: max 1 req/sec per host
    const res = await fetchWithRetry(
      u.href,
      { headers: { 'User-Agent': USER_AGENT, Accept: accept }, redirect: 'manual' },
      { retries: 1, timeoutMs: 15000, provider: u.hostname }
    );
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    const reader = res.body?.getReader();
    let received = 0;
    const chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_BYTES) {
          reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { url: u.href, status: res.status, contentType: res.headers.get('content-type') || '', text };
  }
  throw new Error('Too many redirects');
}

// ---- robots.txt ----
const robotsCache = new Map();

export function parseRobots(txt, agentToken = 'woogzmadeitclientfinder') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !cur) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (field === 'disallow' || field === 'allow') cur.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agentToken.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

export function robotsAllows(rules, pathname) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    const pattern = '^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    if (new RegExp(pattern).test(pathname)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

async function allowedByRobots(u) {
  const origin = u.origin;
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const r = await safeGet(`${origin}/robots.txt`, 'text/plain');
      if (r.status >= 200 && r.status < 300) rules = parseRobots(r.text);
    } catch {
      rules = [];
    }
    robotsCache.set(origin, rules);
  }
  return robotsAllows(robotsCache.get(origin), u.pathname || '/');
}

// ---- extraction ----
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
const BAD_EMAIL = /(example\.|sentry|wixpress|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.svg$|domain\.com|email\.com|yourname|godaddy)/i;
const SOCIAL_HOSTS = {
  instagram: /instagram\.com\/[A-Za-z0-9_.]+/i,
  facebook: /facebook\.com\/[A-Za-z0-9_.\-/]+/i,
  linkedin: /linkedin\.com\/(company|in)\/[A-Za-z0-9_\-]+/i,
  tiktok: /tiktok\.com\/@[A-Za-z0-9_.]+/i,
  x: /(twitter|x)\.com\/[A-Za-z0-9_]+/i,
  youtube: /youtube\.com\/(@|c\/|channel\/)[A-Za-z0-9_\-]+/i,
};

export function extractFromHtml(html, baseUrl) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
      ''
  );
  const text = htmlToText(html);
  const hrefs = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => decodeEntities(m[1]));

  const emails = new Set();
  for (const h of hrefs) if (h.toLowerCase().startsWith('mailto:')) emails.add(h.slice(7).split('?')[0].trim().toLowerCase());
  for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());

  const phones = new Set();
  for (const h of hrefs) if (h.toLowerCase().startsWith('tel:')) phones.add(h.slice(4).replace(/[^\d+]/g, ''));
  for (const m of text.matchAll(PHONE_RE)) phones.add(`(${m[1]}) ${m[2]}-${m[3]}`);

  const social = {};
  for (const h of hrefs) {
    for (const [k, re] of Object.entries(SOCIAL_HOSTS)) {
      if (!social[k] && re.test(h) && !/sharer|share\?|intent\//i.test(h)) social[k] = h.startsWith('http') ? h : `https://${h.replace(/^\/\//, '')}`;
    }
  }

  const internal = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h, baseUrl);
      if (u.hostname.replace(/^www\./, '') === new URL(baseUrl).hostname.replace(/^www\./, '')) internal.push(u.href.split('#')[0]);
    } catch {
      /* ignore */
    }
  }

  return {
    title,
    description,
    text,
    emails: [...emails].filter((e) => !BAD_EMAIL.test(e)).slice(0, 10),
    phones: [...phones].slice(0, 6),
    social,
    internalLinks: [...new Set(internal)],
  };
}

function pickSubpages(links) {
  const score = (u) => {
    const p = u.toLowerCase();
    if (/contact/.test(p)) return 3;
    if (/about|our-story|team/.test(p)) return 2;
    if (/wholesale|catering|custom|events|order|services|shop/.test(p)) return 1;
    return 0;
  };
  return links
    .filter((l) => score(l) > 0 && !/\.(pdf|jpg|png|zip)$/i.test(l))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 2);
}

/** Analyze a business website. Returns structured, sourced findings. */
export async function analyzeWebsite(rawUrl) {
  const start = await assertPublicUrl(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  if (!(await allowedByRobots(start))) {
    return { url: start.href, blocked_by_robots: true, pages: [], note: 'robots.txt disallows automated access; not fetched.' };
  }
  const home = await safeGet(start.href);
  if (home.status >= 400) throw new Error(`Website returned HTTP ${home.status}`);
  if (!/html/i.test(home.contentType)) throw new Error(`Website returned non-HTML content (${home.contentType})`);
  const pages = [];
  const homeData = extractFromHtml(home.text, home.url);
  pages.push({ url: home.url, ...homeData });

  for (const sub of pickSubpages(homeData.internalLinks)) {
    try {
      const su = new URL(sub);
      if (!(await allowedByRobots(su))) continue;
      const r = await safeGet(su.href);
      if (r.status < 400 && /html/i.test(r.contentType)) pages.push({ url: r.url, ...extractFromHtml(r.text, r.url) });
    } catch {
      /* skip failing subpage */
    }
  }

  const merged = { emails: new Set(), phones: new Set(), social: {} };
  for (const p of pages) {
    p.emails.forEach((e) => merged.emails.add(e));
    p.phones.forEach((e) => merged.phones.add(e));
    Object.assign(merged.social, { ...p.social, ...merged.social });
  }
  return {
    url: home.url,
    fetched_at: new Date().toISOString(),
    title: homeData.title,
    description: homeData.description,
    emails: [...merged.emails],
    phones: [...merged.phones],
    social: merged.social,
    pages: pages.map((p) => ({ url: p.url, title: p.title, text: p.text.slice(0, MAX_TEXT_PER_PAGE) })),
  };
}
