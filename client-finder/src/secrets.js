// API credentials: environment variables take precedence; otherwise keys entered
// in Agent Settings are stored AES-256-GCM encrypted (key derived from APP_SECRET).
// Plaintext keys are never returned to the browser.
import crypto from 'node:crypto';
import { config, SECRET_NAMES } from './config.js';
import { get, run, all } from './db.js';

function key() {
  return crypto.scryptSync(config.appSecret, 'woogz-secret-store-v1', 32);
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decrypt({ ciphertext, iv, tag }) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8');
}

export function getSecret(name) {
  if (process.env[name]) return process.env[name];
  const row = get('SELECT ciphertext, iv, tag FROM secrets WHERE name = ?', name);
  if (!row) return '';
  try {
    return decrypt(row);
  } catch {
    return '';
  }
}

export function setSecret(name, value) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  if (!value) {
    run('DELETE FROM secrets WHERE name = ?', name);
    return;
  }
  const enc = encrypt(value);
  run(
    `INSERT INTO secrets(name, ciphertext, iv, tag, updated_at) VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, updated_at=excluded.updated_at`,
    name,
    enc.ciphertext,
    enc.iv,
    enc.tag
  );
}

export function secretStatus() {
  const stored = new Set(all('SELECT name FROM secrets').map((r) => r.name));
  return SECRET_NAMES.map((name) => ({
    name,
    configured: Boolean(process.env[name]) || stored.has(name),
    source: process.env[name] ? 'environment' : stored.has(name) ? 'encrypted-store' : null,
  }));
}
