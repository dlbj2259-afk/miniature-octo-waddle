import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

let db;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  industry TEXT,
  category TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  lat REAL,
  lng REAL,
  distance_miles REAL,
  website TEXT,
  domain TEXT,
  email TEXT,
  email_source_url TEXT,
  phone TEXT,
  phone_digits TEXT,
  contact_name TEXT,
  contact_title TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  contact_source_url TEXT,
  social_json TEXT NOT NULL DEFAULT '{}',
  google_place_id TEXT,
  google_maps_url TEXT,
  rating REAL,
  review_count INTEGER,
  business_status TEXT,
  recommended_products TEXT NOT NULL DEFAULT '[]',
  need_reason TEXT,
  score INTEGER,
  score_tier TEXT,
  score_breakdown TEXT NOT NULL DEFAULT '{}',
  score_reasoning TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  est_value_low REAL,
  est_value_high REAL,
  est_value_basis TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  research_status TEXT NOT NULL DEFAULT 'unresearched',
  research_gaps TEXT,
  next_follow_up_at TEXT,
  potential_revenue REAL,
  won_revenue REAL,
  lost_reason TEXT,
  last_verified_at TEXT,
  discovered_by_run_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_leads_place ON leads(google_place_id) WHERE google_place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_leads_domain ON leads(domain);
CREATE INDEX IF NOT EXISTS ix_leads_phone ON leads(phone_digits);
CREATE INDEX IF NOT EXISTS ix_leads_name_city ON leads(normalized_name, city);
CREATE INDEX IF NOT EXISTS ix_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS ix_leads_score ON leads(score);

CREATE TABLE IF NOT EXISTS lead_sources (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  source_type TEXT,
  retrieved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, url)
);

CREATE TABLE IF NOT EXISTS lead_activities (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_act_lead ON lead_activities(lead_id);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'initial',
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL DEFAULT 'agent',
  run_id INTEGER,
  approved_at TEXT,
  sent_at TEXT,
  send_result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_drafts_status ON outreach_drafts(status);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_fu_due ON follow_ups(status, due_at);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  trigger TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  summary TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  params TEXT,
  result_count INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  results TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  prompt TEXT,
  daily_time TEXT,
  interval_minutes INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_run_id INTEGER,
  last_status TEXT,
  next_run_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  report_date TEXT NOT NULL,
  data TEXT NOT NULL,
  markdown TEXT NOT NULL,
  emailed_at TEXT,
  email_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function getDb() {
  if (!db) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    db = new DatabaseSync(path.join(config.dataDir, 'clientfinder.db'));
    db.exec(SCHEMA);
  }
  return db;
}

/** Open an isolated database (used by tests). */
export function openDb(file) {
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}
export function get(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}
export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ---- settings helpers ----
export const DEFAULT_SETTINGS = {
  target_cities: ['Pontiac', 'Waterford', 'Auburn Hills', 'Rochester Hills', 'Troy', 'Detroit'],
  search_scope: 'local', // local | michigan | nationwide
  priority_industries: [
    'bakeries',
    'chocolatiers and candy makers',
    'specialty food manufacturers',
    'restaurants and dessert shops',
    'marketing and advertising agencies',
    'schools and sports organizations',
    'nonprofits',
    'manufacturers and product inventors',
    'retail stores',
    'event organizers and venues',
    'municipal departments',
  ],
  daily_new_lead_target: 10,
  min_score_to_draft: 45,
  rotation_index: 0,
  report_email_enabled: false,
  report_email_to: '',
};

export function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = parseJson(r.value, out[r.key]);
  return out;
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value)
  );
}
