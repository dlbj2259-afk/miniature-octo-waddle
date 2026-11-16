import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Load .env if present (Node >= 20.12 has process.loadEnvFile built in).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function int(name, def) {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}
function float(name, def) {
  const v = parseFloat(env[name] ?? '');
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) {
  const v = (env[name] ?? '').toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

export const config = {
  port: int('PORT', 3000),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  appSecret: env.APP_SECRET || '',
  cookieSecure: bool('COOKIE_SECURE', env.NODE_ENV === 'production'),
  trustProxy: bool('TRUST_PROXY', false),
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  enableScheduler: bool('ENABLE_SCHEDULER', true),
  timezone: env.APP_TIMEZONE || 'America/Detroit',

  // Claude
  model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  effort: env.AGENT_EFFORT || 'high',
  serverSideFallbacks: bool('ANTHROPIC_FALLBACKS', true),
  maxAgentIterations: int('AGENT_MAX_ITERATIONS', 30),
  maxConcurrentRuns: int('AGENT_MAX_CONCURRENT_RUNS', 2),
  webSearchEnabled: bool('ANTHROPIC_WEB_SEARCH', true),

  // Home base for distance scoring (Pontiac, MI by default)
  homeBase: {
    name: env.HOME_BASE_NAME || 'Pontiac, MI',
    lat: float('HOME_BASE_LAT', 42.6389),
    lng: float('HOME_BASE_LNG', -83.291),
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: env.SMTP_USER || '',
    from: env.SMTP_FROM || '',
  },
  reportEmailTo: env.REPORT_EMAIL_TO || '',
};

// Names of secrets that may come from env vars or the encrypted DB store.
export const SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_PLACES_API_KEY',
  'SAM_GOV_API_KEY',
  'SMTP_PASS',
];

export function assertBootConfig() {
  if (!config.appSecret || config.appSecret.length < 32) {
    throw new Error(
      'APP_SECRET must be set to a random string of at least 32 characters ' +
        '(e.g. `openssl rand -hex 32`). It signs sessions and encrypts stored API keys.'
    );
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
}
