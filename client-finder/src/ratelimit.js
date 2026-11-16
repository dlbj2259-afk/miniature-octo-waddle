// Small rate-limit helpers: inbound per-IP fixed windows, and outbound
// per-provider spacing + retry with exponential backoff.

export function inboundLimiter({ windowMs, max, message = 'Too many requests' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const lastCall = new Map();

/** Ensure at least `minIntervalMs` between calls to the same provider. */
export async function throttle(provider, minIntervalMs) {
  const prev = lastCall.get(provider) || 0;
  const wait = prev + minIntervalMs - Date.now();
  lastCall.set(provider, Math.max(Date.now(), prev + minIntervalMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** fetch with timeout and retry on 429/5xx/network errors. */
export async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 20000, provider } = {}) {
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = parseInt(res.headers.get('retry-after') || '', 10);
        const delay = Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt + Math.random() * 300;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(delay, 30000)));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      if (attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
      throw new Error(`${provider || 'request'} failed: ${reason}`);
    }
  }
}
